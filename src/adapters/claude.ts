import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getGitStatus } from "../lib/git";
import type { PanelSnapshot, SubagentInfo } from "../model";
import type { Adapter, AgentContext } from "./types";

export const STATE_DIR =
	process.env.HARNESS_PANEL_STATE_DIR ??
	join(homedir(), ".local", "state", "harness-panel");

interface Block {
	type: string;
	id?: string;
	tool_use_id?: string;
	name?: string;
	is_error?: boolean;
	input?: { description?: string; subagent_type?: string };
}
interface Entry {
	type?: string;
	isSidechain?: boolean;
	isMeta?: boolean;
	timestamp?: string;
	requestId?: string;
	message?: {
		id?: string;
		content?: string | Block[];
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		};
	};
}

export type TranscriptStats = Pick<PanelSnapshot, "turn" | "subagents"> & {
	mcpToolServers: string[];
};

// Tools that wait on the human, not on compute: excluded from tool and model time.
const WAIT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

const blocks = (e: Entry): Block[] =>
	Array.isArray(e.message?.content) ? (e.message.content as Block[]) : [];

const isPrompt = (e: Entry) =>
	e.type === "user" &&
	!e.isSidechain &&
	!e.isMeta &&
	(typeof e.message?.content === "string" ||
		blocks(e).some((b) => b.type === "text"));

const ts = (e: Entry) => (e.timestamp ? Date.parse(e.timestamp) : Number.NaN);

/** Pure: JSONL transcript text -> turn stats + subagents. */
export function parseTranscript(jsonl: string): TranscriptStats {
	const entries: Entry[] = [];
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {}
	}
	const main = entries.filter((e) => !e.isSidechain);

	// Subagents: Agent/Task tool_use blocks, matched to their tool_result.
	const results = new Map<string, boolean>();
	const mcp = new Set<string>();
	for (const e of main) {
		for (const b of blocks(e)) {
			if (b.type === "tool_result" && b.tool_use_id)
				results.set(b.tool_use_id, !!b.is_error);
			if (b.type === "tool_use" && b.name?.startsWith("mcp__"))
				mcp.add(b.name.split("__")[1]);
		}
	}
	const subagents: SubagentInfo[] = [];
	for (const e of main) {
		if (e.type !== "assistant") continue;
		for (const b of blocks(e)) {
			if (b.type !== "tool_use" || (b.name !== "Agent" && b.name !== "Task"))
				continue;
			const done = b.id ? results.has(b.id) : false;
			subagents.push({
				name: b.input?.description ?? b.input?.subagent_type ?? "subagent",
				status: !done ? "running" : results.get(b.id!) ? "error" : "done",
			});
		}
	}

	// Current turn: from the last real user prompt.
	let start = -1;
	for (let i = main.length - 1; i >= 0; i--) {
		if (isPrompt(main[i])) {
			start = i;
			break;
		}
	}
	const turn: TranscriptStats["turn"] = {};
	if (start >= 0) {
		const t0 = ts(main[start]);
		const usageByReq = new Map<string, NonNullable<Entry["message"]>["usage"]>();
		const toolStart = new Map<string, number>();
		const waitStart = new Map<string, number>();
		let toolMs = 0;
		let waitMs = 0;
		let lastTs = t0;
		for (const e of main.slice(start + 1)) {
			const t = ts(e);
			if (!Number.isNaN(t)) lastTs = Math.max(lastTs, t);
			if (e.type === "assistant") {
				const key = e.requestId ?? e.message?.id ?? String(usageByReq.size);
				if (e.message?.usage) usageByReq.set(key, e.message.usage);
				for (const b of blocks(e))
					if (b.type === "tool_use" && b.id)
						(WAIT_TOOLS.has(b.name ?? "") ? waitStart : toolStart).set(b.id, t);
			} else if (e.type === "user") {
				for (const b of blocks(e)) {
					const s = b.tool_use_id ? toolStart.get(b.tool_use_id) : undefined;
					if (s !== undefined && !Number.isNaN(t) && !Number.isNaN(s))
						toolMs += Math.max(0, t - s);
					const w = b.tool_use_id ? waitStart.get(b.tool_use_id) : undefined;
					if (w !== undefined && !Number.isNaN(t) && !Number.isNaN(w))
						waitMs += Math.max(0, t - w);
				}
			}
		}
		let input = 0;
		let read = 0;
		let output = 0;
		for (const u of usageByReq.values()) {
			input +=
				(u?.input_tokens ?? 0) +
				(u?.cache_creation_input_tokens ?? 0) +
				(u?.cache_read_input_tokens ?? 0);
			read += u?.cache_read_input_tokens ?? 0;
			output += u?.output_tokens ?? 0;
		}
		const total = Number.isNaN(lastTs - t0) ? 0 : lastTs - t0;
		const modelMs = Math.max(0, total - toolMs - waitMs);
		turn.steps = usageByReq.size;
		turn.tokensIn = input;
		turn.tokensOut = output;
		turn.toolMs = toolMs;
		turn.modelMs = modelMs;
		if (input > 0) turn.cacheHit = Math.round((read / input) * 100);
		if (modelMs > 0 && output > 0)
			turn.tokPerSec = Math.round((output / (modelMs / 1000)) * 10) / 10;
	}
	return { turn, subagents, mcpToolServers: [...mcp] };
}

function readJson(path: string): any {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function configuredMcp(cwd: string): string[] {
	const names = new Set<string>();
	const sources = [
		readJson(join(homedir(), ".claude.json")),
		readJson(join(homedir(), ".claude", "claude.json")),
		readJson(join(cwd, ".mcp.json")),
	];
	for (const s of sources)
		for (const n of Object.keys(s?.mcpServers ?? {})) names.add(n);
	return [...names];
}

export function payloadPath(sessionId: string): string {
	return join(STATE_DIR, "claude", `${sessionId}.json`);
}

function transcriptFor(ctx: AgentContext, payload: any): string | undefined {
	const p = payload?.transcript_path;
	if (p && existsSync(p)) return p;
	if (!ctx.sessionId) return undefined;
	const slug = ctx.cwd.replace(/[/.]/g, "-");
	const guess = join(homedir(), ".claude", "projects", slug, `${ctx.sessionId}.jsonl`);
	return existsSync(guess) ? guess : undefined;
}

export const claudeAdapter: Adapter = {
	id: "claude",
	detect: (a) => a.agent === "claude",
	async snapshot(ctx) {
		const snap: PanelSnapshot = { harness: "claude" };
		try {
			const payload = ctx.sessionId ? readJson(payloadPath(ctx.sessionId)) : null;
			const cwd = payload?.workspace?.current_dir ?? ctx.cwd;
			snap.project = { cwd };
			try {
				const g = await getGitStatus(cwd);
				snap.project.branch = g.branch === "no-git" ? undefined : g.branch;
				snap.project.worktree = g.worktree;
			} catch {}

			if (payload) {
				snap.model = {
					name: payload.model?.display_name,
					effort: payload.effort?.level,
					fast: payload.fast_mode,
				};
				const cw = payload.context_window;
				const cur = cw?.current_usage;
				const used = cur
					? (cur.input_tokens ?? 0) +
						(cur.cache_creation_input_tokens ?? 0) +
						(cur.cache_read_input_tokens ?? 0)
					: undefined;
				snap.session = {
					ctxTokens: used,
					ctxMax: cw?.context_window_size,
					ctxPct: cw?.used_percentage,
					cost: payload.cost?.total_cost_usd,
					durationMs: payload.cost?.total_duration_ms,
				};
				const rl = payload.rate_limits;
				const windows = [
					["5h", rl?.five_hour],
					["7d", rl?.seven_day],
				]
					.filter(([, w]) => w)
					.map(([label, w]: any) => ({
						label,
						pct: w.used_percentage,
						resetsAt: w.resets_at,
					}));
				if (windows.length) snap.usage = [{ provider: "Claude", windows }];
			}

			const tPath = transcriptFor(ctx, payload);
			if (tPath) {
				const stats = parseTranscript(readFileSync(tPath, "utf-8"));
				if (stats.turn && Object.keys(stats.turn).length) snap.turn = stats.turn;
				if (stats.subagents?.length) snap.subagents = stats.subagents;
			}
			const servers = configuredMcp(cwd);
			if (servers.length)
				snap.mcp = {
					total: servers.length,
					servers: servers.map((name) => ({ name })),
				};
		} catch {}
		return snap;
	},
};
