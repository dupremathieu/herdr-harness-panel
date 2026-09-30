/**
 * GitHub Copilot CLI adapter.
 *
 * Supported fields:
 * - model.name / model.effort: last session.model_change (or session.start) event
 * - turn.steps / tokensOut / modelMs / toolMs / tokPerSec: events of the current turn
 *   (from the last user.message). Input tokens are not recorded per request, so
 *   tokensIn / cacheHit / cost are unavailable.
 * - session.durationMs: session.start to the last event
 * - subagents: subagent.started / subagent.completed
 * - mcp: servers from ~/.copilot/mcp-config.json and the workspace .mcp.json (configured only)
 * - usage: Copilot AI-credit quota from GET https://api.github.com/copilot_internal/user
 *   (undocumented endpoint, authenticated with GH_TOKEN / GITHUB_TOKEN / `gh auth token`).
 *   Cached for 2 minutes; set HARNESS_PANEL_NO_NETWORK=1 to disable.
 *
 * Unsupported: context window usage (only written at shutdown), cost, cache stats.
 *
 * Sessions live in ~/.copilot/session-state/<id>/{events.jsonl,workspace.yaml}. The session is
 * ctx.sessionId when it exists there, else the most recently written one whose cwd matches.
 */
import {
	existsSync,
	openSync,
	closeSync,
	readFileSync,
	readSync,
	readdirSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getGitStatus } from "../lib/git";
import type { PanelSnapshot, SubagentInfo, UsageProvider } from "../model";
import type { Adapter, AgentContext } from "./types";

const MAX_READ = 3 * 1024 * 1024;
const QUOTA_TTL_MS = 120_000;
const QUOTA_URL = "https://api.github.com/copilot_internal/user";
// Tools that wait on the human: excluded from both tool and model time.
const WAIT_TOOLS = new Set(["ask_user", "exit_plan_mode"]);

const stateDir = () =>
	process.env.HARNESS_PANEL_COPILOT_DIR ?? join(homedir(), ".copilot");

interface Ev {
	type?: string;
	timestamp?: string;
	data?: any;
}

export type CopilotEvents = Pick<
	PanelSnapshot,
	"model" | "turn" | "subagents" | "session"
>;

const ms = (e: Ev) => (e.timestamp ? Date.parse(e.timestamp) : Number.NaN);

/** Pure: events.jsonl text -> model, turn stats, subagents, duration. */
export function parseEvents(jsonl: string): CopilotEvents {
	const evs: Ev[] = [];
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		try {
			evs.push(JSON.parse(line));
		} catch {}
	}
	const out: CopilotEvents = {};

	let name: string | undefined;
	let effort: string | undefined;
	const subs = new Map<string, SubagentInfo>();
	let lastUser = -1;
	evs.forEach((e, i) => {
		const d = e.data ?? {};
		if (e.type === "session.start") {
			name = d.selectedModel ?? name;
			effort = d.reasoningEffort ?? effort;
		} else if (e.type === "session.model_change") {
			name = d.newModel ?? name;
			effort = d.reasoningEffort ?? effort;
		} else if (e.type === "user.message") {
			lastUser = i;
		} else if (e.type === "subagent.started" && d.toolCallId) {
			subs.set(d.toolCallId, {
				name: d.agentDisplayName ?? d.agentName ?? "subagent",
				status: "running",
			});
		} else if (e.type === "subagent.completed" && subs.has(d.toolCallId)) {
			subs.get(d.toolCallId)!.status = d.success === false ? "error" : "done";
		}
	});
	if (name) out.model = { name, effort };
	if (subs.size) out.subagents = [...subs.values()];

	const first = evs.map(ms).find((t) => !Number.isNaN(t));
	const last = [...evs].reverse().map(ms).find((t) => !Number.isNaN(t));
	if (first !== undefined && last !== undefined)
		out.session = { durationMs: last - first };

	if (lastUser >= 0) {
		const t0 = ms(evs[lastUser]);
		const starts = new Map<string, number>();
		const waits = new Map<string, number>();
		let toolMs = 0;
		let waitMs = 0;
		let steps = 0;
		let tokensOut = 0;
		let lastTs = t0;
		for (const e of evs.slice(lastUser + 1)) {
			const t = ms(e);
			if (!Number.isNaN(t)) lastTs = Math.max(lastTs, t);
			const d = e.data ?? {};
			if (e.type === "assistant.message") {
				steps++;
				tokensOut += Number(d.outputTokens) || 0;
			} else if (e.type === "tool.execution_start") {
				(WAIT_TOOLS.has(d.toolName) ? waits : starts).set(d.toolCallId, t);
			} else if (e.type === "tool.execution_complete") {
				const s = starts.get(d.toolCallId);
				const w = waits.get(d.toolCallId);
				if (s !== undefined && !Number.isNaN(t) && !Number.isNaN(s))
					toolMs += Math.max(0, t - s);
				if (w !== undefined && !Number.isNaN(t) && !Number.isNaN(w))
					waitMs += Math.max(0, t - w);
			}
		}
		const total = Number.isNaN(lastTs - t0) ? 0 : lastTs - t0;
		const modelMs = Math.max(0, total - toolMs - waitMs);
		out.turn = { steps, tokensOut, toolMs, modelMs };
		if (modelMs > 0 && tokensOut > 0)
			out.turn.tokPerSec = Math.round((tokensOut / (modelMs / 1000)) * 10) / 10;
	}
	return out;
}

/** Pure: /copilot_internal/user JSON -> usage provider (limited quotas only). */
export function parseQuota(json: any): UsageProvider | undefined {
	const snaps = json?.quota_snapshots;
	if (!snaps || typeof snaps !== "object") return undefined;
	const resetsAt = json.quota_reset_date
		? Math.floor(Date.parse(json.quota_reset_date) / 1000)
		: undefined;
	const windows: UsageProvider["windows"] = [];
	for (const [key, q] of Object.entries<any>(snaps)) {
		if (!q || q.unlimited || !(q.entitlement > 0)) continue;
		const remaining = Math.floor(q.remaining ?? q.quota_remaining ?? 0);
		const pct = Math.round(((q.entitlement - (q.quota_remaining ?? remaining)) / q.entitlement) * 100);
		windows.push({
			label: key === "premium_interactions" ? "AI credits" : key,
			pct: Math.max(0, Math.min(100, pct)),
			resetsAt: Number.isNaN(resetsAt) ? undefined : resetsAt,
			detail: `${remaining} / ${q.entitlement} left`,
		});
	}
	return windows.length ? { provider: "GitHub Copilot", windows } : undefined;
}

async function githubToken(): Promise<string | null> {
	const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	if (env) return env;
	try {
		const p = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
		const t = (await new Response(p.stdout).text()).trim();
		return (await p.exited) === 0 && t ? t : null;
	} catch {
		return null;
	}
}

let quotaCache: { at: number; value?: UsageProvider } | null = null;
let quotaInflight: Promise<void> | null = null;

function refreshQuota(): Promise<void> {
	quotaInflight ??= (async () => {
		let value: UsageProvider | undefined;
		try {
			const token = await githubToken();
			if (token) {
				const res = await fetch(QUOTA_URL, {
					headers: { authorization: `token ${token}`, accept: "application/json" },
					signal: AbortSignal.timeout(2000),
				});
				if (res.ok) value = parseQuota(await res.json());
			}
		} catch {}
		quotaCache = { at: Date.now(), value };
	})().finally(() => {
		quotaInflight = null;
	});
	return quotaInflight;
}

/** Stale-while-revalidate: only the very first call waits for the network. */
async function quota(): Promise<UsageProvider | undefined> {
	if (process.env.HARNESS_PANEL_NO_NETWORK === "1") return undefined;
	if (!quotaCache) await refreshQuota();
	else if (Date.now() - quotaCache.at > QUOTA_TTL_MS) void refreshQuota();
	return quotaCache?.value;
}

function readTail(path: string): string {
	try {
		const size = statSync(path).size;
		if (size <= MAX_READ) return readFileSync(path, "utf-8");
		const fd = openSync(path, "r");
		try {
			const buf = Buffer.alloc(MAX_READ);
			readSync(fd, buf, 0, MAX_READ, size - MAX_READ);
			const text = buf.toString("utf-8");
			return text.slice(text.indexOf("\n") + 1);
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

function findSession(ctx: AgentContext): string | undefined {
	const root = join(stateDir(), "session-state");
	try {
		if (ctx.sessionId && existsSync(join(root, ctx.sessionId, "events.jsonl")))
			return join(root, ctx.sessionId, "events.jsonl");
		let best: { path: string; mtime: number } | undefined;
		for (const id of readdirSync(root)) {
			const events = join(root, id, "events.jsonl");
			try {
				const yaml = readFileSync(join(root, id, "workspace.yaml"), "utf-8");
				if (yaml.match(/^cwd: (.*)$/m)?.[1]?.trim() !== ctx.cwd) continue;
				const mtime = statSync(events).mtimeMs;
				if (!best || mtime > best.mtime) best = { path: events, mtime };
			} catch {}
		}
		return best?.path;
	} catch {
		return undefined;
	}
}

function configuredMcp(cwd: string): string[] {
	const names = new Set<string>();
	for (const p of [join(stateDir(), "mcp-config.json"), join(cwd, ".mcp.json")]) {
		try {
			const j = JSON.parse(readFileSync(p, "utf-8"));
			for (const n of Object.keys(j.mcpServers ?? j.servers ?? {})) names.add(n);
		} catch {}
	}
	return [...names];
}

export const copilotAdapter: Adapter = {
	id: "copilot",
	detect: (a) => a.agent === "copilot",
	async snapshot(ctx) {
		const snap: PanelSnapshot = { harness: "copilot", project: { cwd: ctx.cwd } };
		try {
			const [usage, git] = await Promise.all([
				quota(),
				getGitStatus(ctx.cwd).catch(() => null),
			]);
			if (git) {
				snap.project!.branch = git.branch === "no-git" ? undefined : git.branch;
				snap.project!.worktree = git.worktree;
			}
			if (usage) snap.usage = [usage];
			const path = findSession(ctx);
			if (path) {
				const p = parseEvents(readTail(path));
				if (p.model) snap.model = p.model;
				if (p.turn) snap.turn = p.turn;
				if (p.subagents) snap.subagents = p.subagents;
				if (p.session) snap.session = p.session;
			}
			const servers = configuredMcp(ctx.cwd);
			if (servers.length)
				snap.mcp = { total: servers.length, servers: servers.map((name) => ({ name })) };
		} catch {}
		return snap;
	},
};
