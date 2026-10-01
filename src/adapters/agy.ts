/**
 * Antigravity CLI (agy) adapter.
 *
 * Supported fields:
 * - model.name: parsed from USER_SETTINGS_CHANGE in transcript or gen_metadata in conversation SQLite db
 * - model.effort: parsed from USER_SETTINGS_CHANGE effort label (e.g. "High", "Medium", "Low")
 * - session.durationMs: computed from transcript timestamps (first to last event)
 * - project.cwd, project.branch, project.worktree: current workspace directory and git status via getGitStatus
 * - turn.steps: count of model response steps (PLANNER_RESPONSE) in the current/last turn
 * - turn.modelMs: elapsed model time (turn duration minus tool execution time)
 * - turn.toolMs: cumulative time spent executing tools (excluding interactive wait tools like ask_question)
 * - subagents: child sessions from conversation_summaries.db (parent_conversation_id) and invoke_subagent calls
 * - mcp.total, mcp.servers: configured MCP servers from ~/.gemini/config/mcp_config.json,
 *   ~/.gemini/antigravity-cli/mcp_config.json, and workspace mcp_config.json / .mcp.json
 * - usage: Gemini quota windows (5h, 7d) fetched from the local LanguageServer via Connect RPC
 *   (RetrieveUserQuotaSummary) using the process environment or discovered credentials
 *
 * Unsupported / impossible fields (and rationale):
 * - session.ctxTokens, ctxMax, ctxPct: Antigravity transcripts and logs do not record token counts;
 *   internal SQLite conversation tables store proprietary binary protobuf blobs without public token metrics.
 * - session.cost, turn.cost: Antigravity CLI operates without tracking USD token costs locally.
 * - turn.tokensIn, tokensOut, tokPerSec, cacheHit: token usage is not emitted in transcript.jsonl.
 * - model.fast: fast mode indicator is not exposed in agy local configurations.
 * - mcp.up: local config files do not maintain live connection state for MCP servers.
 */

import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getGitStatus } from "../lib/git";
import type { PanelSnapshot, SubagentInfo, UsageProvider } from "../model";
import type { Adapter, AgentContext } from "./types";

export const AGY_DATA_DIR =
	process.env.HARNESS_PANEL_AGY_DATA_DIR ??
	process.env.AGY_DATA_DIR ??
	join(homedir(), ".gemini", "antigravity-cli");

const WAIT_TOOLS = new Set(["ask_question", "AskUserQuestion", "ask_user_input"]);

export interface AgyTranscriptEntry {
	step_index?: number;
	source?: string;
	type?: string;
	status?: string;
	created_at?: string;
	content?: string;
	thinking?: string;
	tool_calls?: Array<{
		name: string;
		args?: any;
	}>;
}

export function parseModelSetting(text: string): { name: string; effort?: string } | undefined {
	const m = text.match(/The user changed setting [`"'\s]?Model Selection[`"'\s]? from \S+ to\s+([^\n]+)/);
	if (!m) return undefined;
	const clause = m[1].split(/\.(?:\s+|$)/)[0].trim();
	const paren = clause.match(/^(.+?)(?:\s*\(([^()]+)\))?$/);
	if (!paren) return { name: clause };
	return { name: paren[1].trim(), effort: paren[2]?.trim() };
}

export function formatModelName(raw: string): { name: string; effort?: string } {
	let str = raw.trim();
	let effort: string | undefined;
	if (str.endsWith("-high")) {
		effort = "high";
		str = str.replace(/-high$/, "");
	} else if (str.endsWith("-medium")) {
		effort = "medium";
		str = str.replace(/-medium$/, "");
	} else if (str.endsWith("-low")) {
		effort = "low";
		str = str.replace(/-low$/, "");
	}
	const pretty = str
		.split("-")
		.map((part) => {
			if (/^\d+(\.\d+)*$/.test(part)) return part;
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(" ");
	return { name: pretty, effort };
}

export function mapSubagentStatus(status: unknown, killed?: unknown): "running" | "done" | "error" {
	if (killed === 1 || killed === true) return "error";
	const s = typeof status === "string" ? status.toUpperCase() : "";
	if (s.includes("RUNNING")) return "running";
	if (s.includes("ERROR") || s.includes("FAIL") || s.includes("CANCEL")) return "error";
	return "done";
}

/** Pure: JSONL transcript text -> model, session duration, turn stats, and subagents. */
export function parseAgyTranscript(jsonl: string): Partial<PanelSnapshot> {
	const entries: AgyTranscriptEntry[] = [];
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed && typeof parsed === "object") entries.push(parsed);
		} catch {}
	}
	if (!entries.length) return {};

	const snap: Partial<PanelSnapshot> = {};

	// 1. Model & effort from USER_SETTINGS_CHANGE
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.source === "MODEL" && entry.type === "GENERIC") continue;
		const content = entry.content;
		if (typeof content === "string" && content.includes("Model Selection")) {
			const m = parseModelSetting(content);
			if (m) {
				snap.model = m;
				break;
			}
		}
	}

	// 2. Session duration from first timestamp to last timestamp
	const times = entries
		.map((e) => (e.created_at ? Date.parse(e.created_at) : Number.NaN))
		.filter((t) => !Number.isNaN(t));
	if (times.length >= 2) {
		const durationMs = Math.max(0, times[times.length - 1] - times[0]);
		snap.session = { durationMs };
	}

	// 3. Subagents from invoke_subagent tool calls
	const subagents: SubagentInfo[] = [];
	const seenSubagents = new Set<string>();
	for (const e of entries) {
		for (const tc of e.tool_calls ?? []) {
			if (tc.name === "invoke_subagent" && tc.args) {
				let subList = tc.args.Subagents ?? tc.args.subagents;
				if (typeof subList === "string") {
					try {
						subList = JSON.parse(subList);
					} catch {}
				}
				if (Array.isArray(subList)) {
					for (const s of subList) {
						const name = s.Role ?? s.TypeName ?? s.name ?? "subagent";
						if (!seenSubagents.has(name)) {
							seenSubagents.add(name);
							subagents.push({ name, status: "done" });
						}
					}
				}
			}
		}
	}

	// 4. Turn stats: from last real user prompt
	let promptIndex = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "USER_INPUT" || (e.source === "USER_EXPLICIT" && e.type !== "PLANNER_RESPONSE")) {
			promptIndex = i;
			break;
		}
	}

	if (promptIndex >= 0) {
		const turnSlice = entries.slice(promptIndex);
		const promptEntry = turnSlice[0];
		const t0 = promptEntry.created_at ? Date.parse(promptEntry.created_at) : Number.NaN;
		let lastTs = t0;
		let steps = 0;
		let toolMs = 0;
		let pendingToolStart: number | undefined;

		for (let i = 1; i < turnSlice.length; i++) {
			const e = turnSlice[i];
			const t = e.created_at ? Date.parse(e.created_at) : Number.NaN;
			if (!Number.isNaN(t)) lastTs = Number.isNaN(lastTs) ? t : Math.max(lastTs, t);

			if (e.type === "PLANNER_RESPONSE") {
				steps++;
				if (pendingToolStart !== undefined && !Number.isNaN(t)) {
					toolMs += Math.max(0, t - pendingToolStart);
					pendingToolStart = undefined;
				}
				const tc = e.tool_calls;
				if (tc && tc.length > 0) {
					const isWaitOnly = tc.every((call) => WAIT_TOOLS.has(call.name));
					if (!isWaitOnly && !Number.isNaN(t)) {
						pendingToolStart = t;
					}
				}
			} else {
				// Tool execution output step
				if (pendingToolStart !== undefined && !Number.isNaN(t)) {
					toolMs += Math.max(0, t - pendingToolStart);
					pendingToolStart = undefined;
				}
			}
		}

		const elapsed = !Number.isNaN(t0) && !Number.isNaN(lastTs) ? Math.max(0, lastTs - t0) : undefined;
		const modelMs = elapsed !== undefined ? Math.max(0, elapsed - toolMs) : undefined;

		if (steps > 0 || toolMs > 0 || (modelMs !== undefined && modelMs > 0)) {
			snap.turn = {
				steps: steps || undefined,
				toolMs: toolMs || undefined,
				modelMs,
			};
		}
	}

	if (subagents.length > 0) {
		snap.subagents = subagents;
	}

	return snap;
}

/** Pure: MCP config JSON -> server names. */
export function parseAgyMcpConfig(text: string): string[] {
	try {
		const json = JSON.parse(text);
		const servers = json?.mcpServers ?? json?.mcp_servers;
		if (servers && typeof servers === "object" && !Array.isArray(servers)) {
			return Object.keys(servers);
		}
		if (Array.isArray(servers)) {
			return servers.map((s: any) => (typeof s === "string" ? s : s?.name)).filter(Boolean);
		}
	} catch {}
	return [];
}

/** Pure: history JSONL text -> entries. */
export function parseAgyHistory(
	text: string
): Array<{ conversationId?: string; workspace?: string; timestamp?: number; display?: string }> {
	const result: Array<{ conversationId?: string; workspace?: string; timestamp?: number; display?: string }> = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry && typeof entry === "object") {
				result.push({
					conversationId: typeof entry.conversationId === "string" ? entry.conversationId : undefined,
					workspace: typeof entry.workspace === "string" ? entry.workspace : undefined,
					timestamp: typeof entry.timestamp === "number" ? entry.timestamp : undefined,
					display: typeof entry.display === "string" ? entry.display : undefined,
				});
			}
		} catch {}
	}
	return result;
}

function tailText(path: string, maxBytes = 512 * 1024): string {
	let fd: number | undefined;
	try {
		const size = statSync(path).size;
		fd = openSync(path, "r");
		const length = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, Math.max(0, size - length));
		const text = buffer.toString("utf8");
		return size > length ? text.slice(text.indexOf("\n") + 1) : text;
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {}
		}
	}
}

function firstLine(path: string): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(8192);
		const size = readSync(fd, buffer, 0, buffer.length, 0);
		return buffer.toString("utf8", 0, size).split("\n", 1)[0] ?? "";
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {}
		}
	}
}

function readTranscriptText(path: string): { first: string; tail: string } {
	try {
		const size = statSync(path).size;
		if (size <= 512 * 1024) {
			const full = readFileSync(path, "utf-8");
			return { first: full.split("\n", 1)[0] ?? "", tail: full };
		}
		const first = firstLine(path);
		const tail = tailText(path, 512 * 1024);
		return { first, tail };
	} catch {
		return { first: "", tail: "" };
	}
}

function readSubagentsFromDb(dbPath: string, parentId: string): SubagentInfo[] {
	if (!existsSync(dbPath)) return [];
	try {
		const db = new Database(dbPath, { readonly: true });
		try {
			const rows = db
				.query(
					"SELECT agent_name, title, status, killed FROM conversation_summaries WHERE parent_conversation_id = ?"
				)
				.all(parentId) as any[];
			return rows.map((r) => ({
				name: r.agent_name || r.title || "subagent",
				status: mapSubagentStatus(r.status, r.killed),
			}));
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
}

function readModelFromDb(dbPath: string): { name: string; effort?: string } | undefined {
	if (!existsSync(dbPath)) return undefined;
	try {
		const db = new Database(dbPath, { readonly: true });
		try {
			const rows = db.query("SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 10").all() as any[];
			for (const r of rows) {
				if (!r?.data) continue;
				const str = Buffer.from(r.data).toString("binary");
				const match = str.match(/(?:gemini|claude)-[a-zA-Z0-9.-]+/i);
				if (match) {
					return formatModelName(match[0]);
				}
			}
		} finally {
			db.close();
		}
	} catch {}
	return undefined;
}

function findSessionFromDb(dbPath: string, cwd: string): string | undefined {
	if (!existsSync(dbPath)) return undefined;
	try {
		const db = new Database(dbPath, { readonly: true });
		try {
			const rows = db
				.query(
					"SELECT conversation_id, last_modified_time, workspace_uris FROM conversation_summaries ORDER BY last_modified_time DESC"
				)
				.all() as any[];
			for (const r of rows) {
				if (!r.workspace_uris) continue;
				try {
					const uris: string[] = JSON.parse(r.workspace_uris);
					const match = uris.some((u) => {
						const decoded = decodeURIComponent(u.replace(/^file:\/\//, ""));
						return decoded === cwd || decoded === `${cwd}/` || cwd.startsWith(decoded);
					});
					if (match && typeof r.conversation_id === "string") {
						return r.conversation_id;
					}
				} catch {}
			}
		} finally {
			db.close();
		}
	} catch {}
	return undefined;
}

function findSessionFromHistory(historyPath: string, cwd: string): string | undefined {
	if (!existsSync(historyPath)) return undefined;
	try {
		const text = tailText(historyPath, 128 * 1024);
		const entries = parseAgyHistory(text);
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.conversationId && e.workspace) {
				if (e.workspace === cwd || e.workspace === `${cwd}/` || cwd.startsWith(e.workspace)) {
					return e.conversationId;
				}
			}
		}
	} catch {}
	return undefined;
}

function findSession(ctx: AgentContext, dataDir: string): string | undefined {
	const brainDir = join(dataDir, "brain");
	const summariesDb = join(dataDir, "conversation_summaries.db");
	const historyPath = join(dataDir, "history.jsonl");

	if (ctx.sessionId) {
		if (existsSync(join(brainDir, ctx.sessionId))) return ctx.sessionId;
		try {
			if (existsSync(brainDir)) {
				const entries = readdirSync(brainDir, { withFileTypes: true });
				const match = entries.find((e) => e.isDirectory() && e.name.includes(ctx.sessionId!));
				if (match) return match.name;
			}
		} catch {}
		if (existsSync(summariesDb)) {
			try {
				const db = new Database(summariesDb, { readonly: true });
				try {
					const row = db
						.query("SELECT conversation_id FROM conversation_summaries WHERE conversation_id LIKE ? LIMIT 1")
						.get(`%${ctx.sessionId}%`) as any;
					if (row?.conversation_id) return row.conversation_id;
				} finally {
					db.close();
				}
			} catch {}
		}
		return ctx.sessionId;
	}

	const fromDb = findSessionFromDb(summariesDb, ctx.cwd);
	if (fromDb) return fromDb;

	const fromHistory = findSessionFromHistory(historyPath, ctx.cwd);
	if (fromHistory) return fromHistory;

	try {
		if (existsSync(brainDir)) {
			const dirs: { name: string; mtime: number }[] = [];
			for (const e of readdirSync(brainDir, { withFileTypes: true })) {
				if (!e.isDirectory()) continue;
				const p = join(brainDir, e.name);
				try {
					dirs.push({ name: e.name, mtime: statSync(p).mtimeMs });
				} catch {}
			}
			dirs.sort((a, b) => b.mtime - a.mtime);
			if (dirs.length > 0) return dirs[0].name;
		}
	} catch {}

	return undefined;
}

export function findAgyMcpServers(cwd: string, dataDir: string): string[] {
	const names = new Set<string>();
	const sources = [
		join(homedir(), ".gemini", "config", "mcp_config.json"),
		join(dataDir, "mcp_config.json"),
		join(dataDir, "settings.json"),
		join(cwd, ".agents", "mcp_config.json"),
		join(cwd, "mcp_config.json"),
		join(cwd, ".mcp.json"),
	];
	for (const src of sources) {
		if (existsSync(src)) {
			try {
				const content = readFileSync(src, "utf-8");
				for (const name of parseAgyMcpConfig(content)) {
					names.add(name);
				}
			} catch {}
		}
	}
	return [...names];
}

/** Pure: parse LanguageServer RetrieveUserQuotaSummary JSON into UsageProvider array. */
export function parseAgyQuota(input: unknown): UsageProvider[] {
	let data = input;
	if (typeof data === "string") {
		try {
			data = JSON.parse(data);
		} catch {
			return [];
		}
	}
	if (!data || typeof data !== "object") return [];

	const groups = (data as any)?.response?.groups ?? (data as any)?.groups;
	if (!Array.isArray(groups)) return [];

	const providers: UsageProvider[] = [];

	for (const group of groups) {
		if (!group || typeof group !== "object") continue;
		const displayName = typeof group.displayName === "string" ? group.displayName : "";
		const buckets = Array.isArray(group.buckets) ? group.buckets : [];
		if (buckets.length === 0) continue;

		const windows: UsageProvider["windows"] = [];
		for (const bucket of buckets) {
			if (!bucket || typeof bucket !== "object") continue;
			const remaining = typeof bucket.remainingFraction === "number" ? bucket.remainingFraction : 1;
			const pct = Math.max(0, Math.min(100, Math.round((1 - remaining) * 100)));
			const rawWindow = typeof bucket.window === "string" ? bucket.window : "";
			const label = rawWindow === "weekly" ? "7d" : rawWindow || bucket.bucketId || "limit";
			const resetsAt = bucket.resetTime ? Math.floor(Date.parse(bucket.resetTime) / 1000) : undefined;

			windows.push({
				label,
				pct,
				resetsAt: resetsAt && !Number.isNaN(resetsAt) ? resetsAt : undefined,
			});
		}

		if (windows.length === 0) continue;

		const order = ["5h", "7d"];
		windows.sort((a, b) => {
			const ia = order.indexOf(a.label);
			const ib = order.indexOf(b.label);
			if (ia !== -1 && ib !== -1) return ia - ib;
			if (ia !== -1) return -1;
			if (ib !== -1) return 1;
			return a.label.localeCompare(b.label);
		});

		let providerName = displayName;
		if (/gemini/i.test(displayName)) {
			providerName = "Gemini";
		}

		providers.push({
			provider: providerName,
			windows,
		});
	}

	return providers;
}

export function findLsCredentials(
	sessionId?: string,
	dataDir?: string
): { address: string; csrfToken: string } | undefined {
	if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
		return {
			address: process.env.ANTIGRAVITY_LS_ADDRESS,
			csrfToken: process.env.ANTIGRAVITY_CSRF_TOKEN,
		};
	}

	if (dataDir) {
		for (const fname of ["last_ls.json", "ls_credentials.json"]) {
			const fpath = join(dataDir, fname);
			if (existsSync(fpath)) {
				try {
					const parsed = JSON.parse(readFileSync(fpath, "utf-8"));
					if (parsed?.address && parsed?.csrfToken) {
						return { address: parsed.address, csrfToken: parsed.csrfToken };
					}
				} catch {}
			}
		}
	}

	try {
		const entries = readdirSync("/proc");
		let fallback: { address: string; csrfToken: string } | undefined;

		for (const entry of entries) {
			if (!/^\d+$/.test(entry)) continue;
			try {
				const env = readFileSync(`/proc/${entry}/environ`, "utf-8");
				if (!env.includes("ANTIGRAVITY_CSRF_TOKEN=")) continue;

				let address = "";
				let csrfToken = "";
				let convId = "";

				for (const line of env.split("\0")) {
					if (line.startsWith("ANTIGRAVITY_LS_ADDRESS=")) {
						address = line.slice("ANTIGRAVITY_LS_ADDRESS=".length);
					} else if (line.startsWith("ANTIGRAVITY_CSRF_TOKEN=")) {
						csrfToken = line.slice("ANTIGRAVITY_CSRF_TOKEN=".length);
					} else if (line.startsWith("ANTIGRAVITY_CONVERSATION_ID=")) {
						convId = line.slice("ANTIGRAVITY_CONVERSATION_ID=".length);
					}
				}

				if (address && csrfToken) {
					if (sessionId && convId === sessionId) {
						return { address, csrfToken };
					}
					if (!fallback) {
						fallback = { address, csrfToken };
					}
				}
			} catch {}
		}
		return fallback;
	} catch {
		return undefined;
	}
}

let quotaCache: {
	data: UsageProvider[];
	sessionId?: string;
	expiresAt: number;
} | null = null;

let credsCache: {
	creds: { address: string; csrfToken: string };
	sessionId?: string;
	expiresAt: number;
} | null = null;

export async function fetchAgyQuota(
	ctx: AgentContext,
	dataDir: string,
	modelName?: string
): Promise<UsageProvider[] | undefined> {
	const now = Date.now();
	if (
		quotaCache &&
		now < quotaCache.expiresAt &&
		(!ctx.sessionId || quotaCache.sessionId === ctx.sessionId)
	) {
		return quotaCache.data;
	}

	let creds: { address: string; csrfToken: string } | undefined;
	if (
		credsCache &&
		now < credsCache.expiresAt &&
		(!ctx.sessionId || credsCache.sessionId === ctx.sessionId)
	) {
		creds = credsCache.creds;
	} else {
		creds = findLsCredentials(ctx.sessionId, dataDir);
		if (creds) {
			credsCache = { creds, sessionId: ctx.sessionId, expiresAt: now + 30000 };
		}
	}

	if (!creds) return undefined;

	try {
		const res = await fetch(
			`http://${creds.address}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-codeium-csrf-token": creds.csrfToken,
				},
				body: "{}",
				signal: AbortSignal.timeout(300),
			}
		);

		if (!res.ok) {
			credsCache = null;
			return undefined;
		}

		const json = await res.json();
		const allProviders = parseAgyQuota(json);
		if (allProviders.length === 0) return undefined;

		const modelLower = (modelName ?? "").toLowerCase();
		const is3p =
			modelLower.includes("claude") ||
			modelLower.includes("gpt") ||
			modelLower.includes("opus") ||
			modelLower.includes("sonnet");

		const filtered = allProviders.filter((p) => {
			if (p.provider === "Gemini") return true;
			if (is3p) return true;
			return p.windows.some((w) => w.pct > 0);
		});

		const result = filtered.length > 0 ? filtered : allProviders;
		quotaCache = { data: result, sessionId: ctx.sessionId, expiresAt: now + 5000 };
		return result;
	} catch {
		credsCache = null;
		return quotaCache?.data;
	}
}

export const agyAdapter: Adapter = {
	id: "agy",
	detect: (a) => a.agent === "agy" || a.agent === "antigravity",
	async snapshot(ctx) {
		const snap: PanelSnapshot = {
			harness: "agy",
			project: { cwd: ctx.cwd },
		};
		try {
			const dataDir = AGY_DATA_DIR;
			const sessionId = findSession(ctx, dataDir);

			try {
				const g = await getGitStatus(ctx.cwd);
				snap.project!.branch = g.branch === "no-git" ? undefined : g.branch;
				snap.project!.worktree = g.worktree;
			} catch {}

			try {
				const mcpServers = findAgyMcpServers(ctx.cwd, dataDir);
				if (mcpServers.length > 0) {
					snap.mcp = {
						total: mcpServers.length,
						servers: mcpServers.map((name) => ({ name })),
					};
				}
			} catch {}

			if (sessionId) {
				const brainDir = join(dataDir, "brain");
				const tPath = join(brainDir, sessionId, ".system_generated", "logs", "transcript.jsonl");
				if (existsSync(tPath)) {
					const { first, tail } = readTranscriptText(tPath);
					const combined = first && tail !== first ? `${first}\n${tail}` : tail;
					const parsed = parseAgyTranscript(combined);
					if (parsed.model) snap.model = parsed.model;
					if (parsed.session?.durationMs !== undefined) {
						snap.session = { durationMs: parsed.session.durationMs };
					}
					if (parsed.turn && Object.keys(parsed.turn).length > 0) {
						snap.turn = parsed.turn;
					}
					if (parsed.subagents && parsed.subagents.length > 0) {
						snap.subagents = parsed.subagents;
					}
				}

				if (!snap.model) {
					const convDb = join(dataDir, "conversations", `${sessionId}.db`);
					const dbModel = readModelFromDb(convDb);
					if (dbModel) snap.model = dbModel;
				}

				const summariesDb = join(dataDir, "conversation_summaries.db");
				const dbSubagents = readSubagentsFromDb(summariesDb, sessionId);
				if (dbSubagents.length > 0) {
					snap.subagents = dbSubagents;
				}
			}

			try {
				const usage = await fetchAgyQuota(ctx, dataDir, snap.model?.name);
				if (usage && usage.length > 0) {
					snap.usage = usage;
				}
			} catch {}
		} catch {}

		return snap;
	},
};
