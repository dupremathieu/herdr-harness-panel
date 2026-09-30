/**
 * Codex CLI adapter.
 * Supported: model/effort, context tokens/window, session duration, turn input/output,
 * cache ratio, model/tool time, steps, project git status, and configured MCP names.
 * Unavailable/unreliable here: session or turn cost, fast mode, child-agent status,
 * live MCP health.
 */
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getGitStatus } from "../lib/git";
import type { PanelSnapshot } from "../model";
import type { Adapter, AgentContext } from "./types";

const SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const MODELS_CACHE_PATH = join(homedir(), ".codex", "models_cache.json");
type Row = { type?: string; timestamp?: string; payload?: any };
type Usage = { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };

const number = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined;
const timestamp = (v: unknown): number => typeof v === "string" ? Date.parse(v) : Number.NaN;
const parseRows = (text: string): Row[] => {
	const rows: Row[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try { const value = JSON.parse(line); if (value && typeof value === "object") rows.push(value); } catch {}
	}
	return rows;
};

export function parseCodexModelContext(json: string, model: string): number | undefined {
	try {
		const catalog = JSON.parse(json);
		const match = catalog.models?.find((entry: any) => entry.slug === model);
		return number(match?.context_window);
	} catch { return undefined; }
}

let modelsCacheMtime = -1;
let modelsCacheText = "";
function modelContextWindow(model: string): number | undefined {
	try {
		const mtime = statSync(MODELS_CACHE_PATH).mtimeMs;
		if (mtime !== modelsCacheMtime) {
			modelsCacheText = readFileSync(MODELS_CACHE_PATH, "utf8");
			modelsCacheMtime = mtime;
		}
		return parseCodexModelContext(modelsCacheText, model);
	} catch { return undefined; }
}

function tailText(path: string, maxBytes = 4 * 1024 * 1024): string {
	let fd: number | undefined;
	try {
		const size = statSync(path).size;
		fd = openSync(path, "r");
		const length = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, Math.max(0, size - length));
		const text = buffer.toString("utf8");
		return size > length ? text.slice(text.indexOf("\n") + 1) : text;
	} catch { return ""; }
	finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

function headText(path: string, maxBytes = 128 * 1024): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(maxBytes);
		const size = readSync(fd, buffer, 0, maxBytes, 0);
		const text = buffer.toString("utf8", 0, size);
		return size === maxBytes ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
	} catch { return ""; }
	finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

export function firstLine(path: string): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const chunks: Buffer[] = [];
		let offset = 0;
		while (offset < 256 * 1024) {
			const buffer = Buffer.alloc(8192);
			const size = readSync(fd, buffer, 0, buffer.length, offset);
			if (!size) break;
			const newline = buffer.subarray(0, size).indexOf(10);
			chunks.push(buffer.subarray(0, newline < 0 ? size : newline));
			if (newline >= 0) break;
			offset += size;
		}
		return Buffer.concat(chunks).toString("utf8");
	} catch { return ""; }
	finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

function sessionFiles(): string[] {
	try {
		const days: { path: string; mtime: number }[] = [];
		for (const year of readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory())) {
			const yp = join(SESSIONS_DIR, year.name);
			for (const month of readdirSync(yp, { withFileTypes: true }).filter((e) => e.isDirectory())) {
				const mp = join(yp, month.name);
				for (const day of readdirSync(mp, { withFileTypes: true }).filter((e) => e.isDirectory())) {
					const dp = join(mp, day.name);
					for (const file of readdirSync(dp, { withFileTypes: true })) {
						if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
						const path = join(dp, file.name);
						try { days.push({ path, mtime: statSync(path).mtimeMs }); } catch {}
					}
				}
			}
		}
		days.sort((a, b) => b.mtime - a.mtime);
		return days.slice(0, 60).map((v) => v.path);
	} catch { return []; }
}

function findSession(ctx: AgentContext): string | undefined {
	const files = sessionFiles();
	if (ctx.sessionId) {
		const match = files.find((p) => p.includes(ctx.sessionId!));
		if (match) return match;
		for (const path of files) {
			const row = parseRows(firstLine(path))[0];
			if (row?.payload?.session_id === ctx.sessionId || row?.payload?.id === ctx.sessionId) return path;
		}
	}
	for (const path of files) {
		const row = parseRows(firstLine(path))[0];
		if (row?.type === "session_meta" && row.payload?.cwd === ctx.cwd) return path;
	}
	return undefined;
}

/** Pure: Codex session JSONL -> model/session/turn fields. */
export function parseCodexSession(jsonl: string, sessionStartedAt?: number): Partial<PanelSnapshot> {
	const rows = parseRows(jsonl);
	const meta = rows.find((r) => r.type === "session_meta")?.payload ?? {};
	const turns = rows.filter((r) => r.type === "turn_context");
	const lastTurn = turns[turns.length - 1]?.payload ?? {};
	const counts = rows.filter((r) => r.type === "event_msg" && r.payload?.type === "token_count");
	const latestCount = counts[counts.length - 1]?.payload;
	const count = latestCount?.info ?? {};
	const lastUsage: Usage = count.last_token_usage ?? {};
	const ctxTokens = number(lastUsage.input_tokens);
	const ctxMax = number(count.model_context_window) ?? number(lastTurn.model_context_window) ?? number(meta.context_window);
	const snap: Partial<PanelSnapshot> = {};
	const modelName = typeof lastTurn.model === "string" ? lastTurn.model :
		(typeof meta.model === "string" ? meta.model : undefined);
	if (modelName || typeof lastTurn.effort === "string") snap.model = { name: modelName ?? meta.model_provider ?? "Codex", effort: lastTurn.effort };
	if (ctxTokens !== undefined || ctxMax !== undefined) {
		snap.session = { ctxTokens, ctxMax, ctxPct: ctxTokens !== undefined && ctxMax ? Math.min(100, Math.round(ctxTokens / ctxMax * 100)) : undefined };
	}
	const limits = [...rows].reverse().find((r) => r.type === "event_msg" && r.payload?.type === "token_count" && r.payload?.rate_limits)?.payload?.rate_limits;
	const windows = ([
		["5h", limits?.primary],
		["7d", limits?.secondary],
	] as const).flatMap(([label, window]) => {
		const pct = number(window?.used_percent);
		if (pct === undefined) return [];
		return [{ label, pct, resetsAt: number(window?.resets_at) }];
	});
	if (windows.length) snap.usage = [{ provider: "Codex", windows }];
	const promptIndex = (() => {
		for (let i = rows.length - 1; i >= 0; i--) {
			const p = rows[i].payload;
			if (rows[i].type === "response_item" && p?.type === "message" && p?.role === "user") return i;
		}
		return -1;
	})();
	if (promptIndex >= 0) {
		const relevant = rows.slice(promptIndex);
		const tokenRows = relevant.filter((r) => r.type === "event_msg" && r.payload?.type === "token_count");
		const info = tokenRows[tokenRows.length - 1]?.payload?.info;
		const usage: Usage = info?.last_token_usage ?? {};
		const records = relevant.filter((r) => r.type === "token_usage_record");
		const input = records.length ? records.reduce((sum, r) => sum + (number(r.payload?.usage?.input_tokens) ?? 0), 0) : number(usage.input_tokens);
		const output = records.length ? records.reduce((sum, r) => sum + (number(r.payload?.usage?.output_tokens) ?? 0), 0) : number(usage.output_tokens);
		const read = records.length ? records.reduce((sum, r) => sum + (number(r.payload?.usage?.cached_input_tokens) ?? 0), 0) : number(usage.cached_input_tokens);
		const callStarts = new Map<string, number>();
		let toolMs = 0;
		let steps = 0;
		let modelStart = timestamp(rows[promptIndex].timestamp);
		let modelMs = 0;
		let lastResponseRate: number | undefined;
		for (const row of relevant) {
			const t = timestamp(row.timestamp);
			if (row.type === "token_usage_record") {
				const duration = t - modelStart;
				const tokens = number(row.payload?.usage?.output_tokens);
				if (Number.isFinite(duration) && duration > 0) {
					modelMs += duration;
					if (tokens !== undefined) lastResponseRate = Math.round(tokens / (duration / 1000) * 10) / 10;
				}
				steps++;
				modelStart = t;
				continue;
			}
			if (row.type !== "response_item") continue;
			const p = row.payload;
			if (p?.type === "message" && p.role === "assistant" && !records.length) steps++;
			if ((p?.type === "function_call" || p?.type === "custom_tool_call") && typeof p.call_id === "string" && Number.isFinite(t)) callStarts.set(p.call_id, t);
			if ((p?.type === "function_call_output" || p?.type === "custom_tool_call_output") && typeof p.call_id === "string" && callStarts.has(p.call_id) && Number.isFinite(t)) {
				toolMs += Math.max(0, t - callStarts.get(p.call_id)!);
				callStarts.delete(p.call_id);
				modelStart = t;
			}
		}
		const turn: NonNullable<PanelSnapshot["turn"]> = { tokensIn: input, tokensOut: output, steps: steps || (info ? 1 : undefined), toolMs: toolMs || undefined, modelMs: records.length ? modelMs : undefined };
		if (input && read !== undefined) turn.cacheHit = Math.round(read / input * 100);
		if (lastResponseRate !== undefined) turn.tokPerSec = lastResponseRate;
		snap.turn = turn;
	}
	const times = rows.map((r) => timestamp(r.timestamp)).filter(Number.isFinite);
	const metaTime = timestamp(meta.timestamp);
	const started = sessionStartedAt !== undefined && Number.isFinite(sessionStartedAt) ? sessionStartedAt : Number.isFinite(metaTime) ? metaTime : times[0];
	const latest = times.length ? Math.max(...times) : Number.NaN;
	const durationMs = Number.isFinite(started) && Number.isFinite(latest) ? Math.max(0, latest - started) : undefined;
	if (durationMs !== undefined) snap.session = { ...snap.session, durationMs };
	return snap;
}

/** Pure: count configured Codex MCP sections in config.toml. */
export function parseCodexMcpConfig(text: string): string[] {
	const names = new Set<string>();
	for (const line of text.split("\n")) {
		const match = line.match(/^\s*\[\[?mcp_servers\.([A-Za-z0-9_-]+)\]?\]\]?\s*(?:#.*)?$/);
		if (match) names.add(match[1]);
	}
	return [...names];
}

export const codexAdapter: Adapter = {
	id: "codex",
	detect: (agent) => agent.agent === "codex",
	async snapshot(ctx) {
		const snap: PanelSnapshot = { harness: "codex", project: { cwd: ctx.cwd } };
		try {
			const path = findSession(ctx);
			if (path) {
				const metaLine = parseRows(firstLine(path))[0];
				const parsed = parseCodexSession(tailText(path), timestamp(metaLine?.timestamp));
				Object.assign(snap, parsed);
				if (!snap.model) snap.model = parseCodexSession(headText(path)).model;
				const modelMax = snap.model?.name ? modelContextWindow(snap.model.name) : undefined;
				if (modelMax && snap.session) {
					snap.session.ctxMax = modelMax;
					if (snap.session.ctxTokens !== undefined)
						snap.session.ctxPct = Math.min(100, Math.round(snap.session.ctxTokens / modelMax * 100));
				}
				const cwd = metaLine?.payload?.cwd;
				if (typeof cwd === "string") snap.project!.cwd = cwd;
			}
			try {
				const git = await getGitStatus(snap.project?.cwd ?? ctx.cwd);
				snap.project!.branch = git.branch === "no-git" ? undefined : git.branch;
				snap.project!.worktree = git.worktree;
			} catch {}
			try {
				if (existsSync(CONFIG_PATH)) {
					const names = parseCodexMcpConfig(readFileSync(CONFIG_PATH, "utf8"));
					snap.mcp = { total: names.length, servers: names.map((name) => ({ name })) };
				}
			} catch {}
		} catch {}
		return snap;
	},
};
