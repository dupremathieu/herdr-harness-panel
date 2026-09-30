/**
 * Codex CLI adapter.
 * Supported: model/effort, context tokens/window, session duration, turn input/output,
 * cache ratio, model/tool time, steps, project git status, and configured MCP names.
 * Unavailable/unreliable here: session or turn cost, fast mode, child-agent status,
 * live MCP health, and provider quota windows (the local files do not expose these).
 */
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getGitStatus } from "../lib/git";
import type { PanelSnapshot } from "../model";
import type { Adapter, AgentContext } from "./types";

const SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const CONFIG_PATH = join(homedir(), ".codex", "config.toml");
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
	} catch { return ""; }
	finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

function firstLine(path: string): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(8192);
		const size = readSync(fd, buffer, 0, buffer.length, 0);
		return buffer.toString("utf8", 0, size).split("\n", 1)[0] ?? "";
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
export function parseCodexSession(jsonl: string): Partial<PanelSnapshot> {
	const rows = parseRows(jsonl);
	const meta = rows.find((r) => r.type === "session_meta")?.payload ?? {};
	const turns = rows.filter((r) => r.type === "turn_context");
	const lastTurn = turns[turns.length - 1]?.payload ?? {};
	const counts = rows.filter((r) => r.type === "event_msg" && r.payload?.type === "token_count");
	const count = counts[counts.length - 1]?.payload?.info ?? {};
	const lastUsage: Usage = count.last_token_usage ?? {};
	const ctxTokens = number(lastUsage.input_tokens) === undefined ? undefined :
		(number(lastUsage.input_tokens) ?? 0) + (number(lastUsage.cached_input_tokens) ?? 0);
	const ctxMax = number(count.model_context_window) ?? number(lastTurn.model_context_window) ?? number(meta.context_window);
	const snap: Partial<PanelSnapshot> = {};
	const modelName = typeof lastTurn.model === "string" ? lastTurn.model :
		(typeof meta.model === "string" ? meta.model : undefined);
	if (modelName || typeof lastTurn.effort === "string") snap.model = { name: modelName ?? meta.model_provider ?? "Codex", effort: lastTurn.effort };
	if (ctxTokens !== undefined || ctxMax !== undefined) {
		snap.session = { ctxTokens, ctxMax, ctxPct: ctxTokens !== undefined && ctxMax ? Math.min(100, Math.round(ctxTokens / ctxMax * 100)) : undefined };
	}
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
		const input = number(usage.input_tokens) === undefined ? undefined : (number(usage.input_tokens) ?? 0) + (number(usage.cached_input_tokens) ?? 0);
		const output = number(usage.output_tokens);
		const read = number(usage.cached_input_tokens);
		const callStarts = new Map<string, number>();
		let toolMs = 0;
		let steps = 0;
		let t0 = timestamp(rows[promptIndex].timestamp);
		let lastTs = t0;
		for (const row of relevant) {
			const t = timestamp(row.timestamp);
			if (Number.isFinite(t)) lastTs = Number.isFinite(lastTs) ? Math.max(lastTs, t) : t;
			if (row.type !== "response_item") continue;
			const p = row.payload;
			if (p?.type === "message" && p.role === "assistant") steps++;
			if (p?.type === "function_call" && typeof p.call_id === "string" && Number.isFinite(t)) callStarts.set(p.call_id, t);
			if (p?.type === "function_call_output" && typeof p.call_id === "string" && callStarts.has(p.call_id) && Number.isFinite(t)) {
				toolMs += Math.max(0, t - callStarts.get(p.call_id)!);
				callStarts.delete(p.call_id);
			}
		}
		const elapsed = Number.isFinite(t0) && Number.isFinite(lastTs) ? Math.max(0, lastTs - t0) : undefined;
		const modelMs = elapsed === undefined ? undefined : Math.max(0, elapsed - toolMs);
		const turn: NonNullable<PanelSnapshot["turn"]> = { tokensIn: input, tokensOut: output, steps: steps || (info ? 1 : undefined), toolMs: toolMs || undefined, modelMs };
		if (input && read !== undefined) turn.cacheHit = Math.round(read / input * 100);
		if (modelMs && output) turn.tokPerSec = Math.round(output / (modelMs / 1000) * 10) / 10;
		snap.turn = turn;
	}
	const times = rows.map((r) => timestamp(r.timestamp)).filter(Number.isFinite);
	const started = timestamp(meta.timestamp) || times[0];
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
				const parsed = parseCodexSession(tailText(path));
				Object.assign(snap, parsed);
				const metaLine = parseRows(firstLine(path))[0];
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
