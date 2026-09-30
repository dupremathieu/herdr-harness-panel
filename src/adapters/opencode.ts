/**
 * opencode adapter — OpenCode v2 (local server, the same one `opencode api ...` talks to).
 *
 * Data is read over read-only HTTP from the background service. The base URL and the
 * password are read from ~/.local/state/opencode/service.json (written by `opencode
 * serve --service`); they are used in memory only and never logged or written anywhere.
 * Overrides for tests / unusual setups: HARNESS_PANEL_OPENCODE_URL + _PASSWORD, or
 * HARNESS_PANEL_OPENCODE_SERVICE (path to the service file).
 *
 * Supported fields
 *   model.name        display name of the session model (GET /api/model catalog)
 *   model.effort      session model variant (e.g. "high"); "default" is omitted
 *   session.ctxTokens newest assistant request: input + cache-read + cache-write
 *   session.ctxMax    model context limit from the catalog (+ derived ctxPct)
 *   session.cost      cumulative session cost in USD (GET /api/session/{id})
 *   session.durationMs wall time since session creation (now - time.created)
 *   project.*         cwd + getGitStatus() branch / linked worktree
 *   turn.*            steps, tokensIn/Out, cacheHit, cost, modelMs, toolMs, tokPerSec,
 *                     computed from GET /api/session/{id}/message since the last user prompt
 *   subagents[]       child sessions (GET /api/session?parentID=) + GET /api/session/active
 *   mcp.total/up/servers  GET /api/mcp; a server counts as "up" when status=connected
 *
 * Not possible (omitted honestly)
 *   usage[]           the v2 API exposes no provider quota / rate-limit windows.
 *   model.fast        OpenCode has no fast-mode flag.
 *   session.durationMs is wall time, not active (non-idle) time: only wall time is known.
 *   turn.modelMs/toolMs are derived from message/tool timestamps and are approximate;
 *     modelMs sums per-message streaming time, toolMs sums execution time (parallel
 *     calls add up, permission wait is not included).
 *   ctxMax/ctxPct when the session model is missing from the catalog.
 *   turn when the last user prompt is not inside the fetched message page.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getGitStatus } from "../lib/git";
import type { PanelSnapshot, SubagentInfo } from "../model";
import type { Adapter, AgentContext } from "./types";

/** Hard cap per HTTP request so a stuck server cannot blow the < 500 ms budget. */
const REQ_TIMEOUT_MS = 400;
/** Model catalog is ~460 KB; cache it across refreshes instead of refetching each second. */
const MODEL_CACHE_TTL_MS = 5 * 60_000;
const MESSAGE_PAGE = 60;

export interface OpenCodeService {
	url: string;
	password: string;
}

interface TokenUsage {
	input?: number;
	output?: number;
	reasoning?: number;
	cache?: { read?: number; write?: number };
}
interface ToolBlock {
	type?: string;
	name?: string;
	time?: { created?: number; ran?: number; completed?: number };
	state?: { status?: string };
}
interface Message {
	type?: string;
	time?: { created?: number; streamed?: number; completed?: number };
	tokens?: TokenUsage;
	cost?: number;
	content?: ToolBlock[];
}

const stateDir = () =>
	process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");

/** Path of the file the running service writes its URL + password to. */
export function serviceFilePath(): string {
	return (
		process.env.HARNESS_PANEL_OPENCODE_SERVICE ??
		join(stateDir(), "opencode", "service.json")
	);
}

/** Pure: service.json text -> {url, password} (null when either is missing/invalid). */
export function parseService(text: string): OpenCodeService | null {
	try {
		const j = JSON.parse(text);
		if (typeof j?.url === "string" && typeof j?.password === "string")
			return { url: j.url.replace(/\/+$/, ""), password: j.password };
	} catch {}
	return null;
}

/** Resolve the service endpoint without ever throwing. */
export function readService(): OpenCodeService | null {
	try {
		const envUrl = process.env.HARNESS_PANEL_OPENCODE_URL;
		const envPass = process.env.HARNESS_PANEL_OPENCODE_PASSWORD;
		if (envUrl && envPass)
			return { url: envUrl.replace(/\/+$/, ""), password: envPass };
		const path = serviceFilePath();
		if (!existsSync(path)) return null;
		return parseService(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

const authedGet = async (
	svc: OpenCodeService,
	path: string,
): Promise<any | null> => {
	try {
		const res = await fetch(`${svc.url}${path}`, {
			headers: {
				authorization: `Basic ${btoa(`opencode:${svc.password}`)}`,
			},
			signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
};

const modelCache = new Map<string, { at: number; json: any }>();

async function modelCatalog(svc: OpenCodeService): Promise<any> {
	const hit = modelCache.get(svc.url);
	if (hit && Date.now() - hit.at < MODEL_CACHE_TTL_MS) return hit.json;
	const json = await authedGet(svc, "/api/model");
	if (json) modelCache.set(svc.url, { at: Date.now(), json });
	return json;
}

/**
 * Pure: message list (any order) -> turn stats since the last user prompt.
 * Returns `{}` when no user prompt is present (instead of inventing a boundary).
 */
export function parseMessages(
	messages: unknown,
	now = Date.now(),
): Pick<PanelSnapshot, "turn"> {
	const list = Array.isArray(messages) ? (messages as Message[]) : [];
	const msgs = [...list].sort(
		(a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0),
	);
	let start = -1;
	for (let i = msgs.length - 1; i >= 0; i--)
		if (msgs[i].type === "user") {
			start = i;
			break;
		}
	if (start < 0) return {};
	const win = msgs.slice(start + 1);

	const assistants = win.filter((m) => m.type === "assistant");
	let tokensIn = 0;
	let tokensOut = 0;
	let read = 0;
	let cost = 0;
	let hasCost = false;
	let modelMs = 0;
	for (const m of assistants) {
		const t = m.tokens;
		if (t) {
			const c = t.cache ?? {};
			tokensIn += (t.input ?? 0) + (c.read ?? 0) + (c.write ?? 0);
			tokensOut += t.output ?? 0;
			read += c.read ?? 0;
		}
		if (typeof m.cost === "number") {
			cost += m.cost;
			hasCost = true;
		}
		const created = m.time?.created;
		const end = m.time?.streamed ?? m.time?.completed;
		if (typeof created === "number" && typeof end === "number")
			modelMs += Math.max(0, end - created);
	}

	let toolMs = 0;
	for (const m of win)
		for (const b of m.content ?? []) {
			if (b.type !== "tool") continue;
			const s = b.time?.ran ?? b.time?.created;
			const e =
				b.time?.completed ??
				(b.state?.status === "running" && typeof s === "number"
					? now
					: undefined);
			if (typeof s === "number" && typeof e === "number")
				toolMs += Math.max(0, e - s);
		}

	const turn: NonNullable<PanelSnapshot["turn"]> = { steps: assistants.length };
	turn.tokensIn = tokensIn;
	turn.tokensOut = tokensOut;
	if (tokensIn > 0) turn.cacheHit = Math.round((read / tokensIn) * 100);
	if (hasCost) turn.cost = cost;
	turn.modelMs = modelMs;
	turn.toolMs = toolMs;
	if (modelMs > 0 && tokensOut > 0)
		turn.tokPerSec = Math.round((tokensOut / (modelMs / 1000)) * 10) / 10;
	return { turn };
}

/** Pure: GET /api/mcp -> mcp section (undefined when nothing is configured). */
export function parseMcp(json: any): PanelSnapshot["mcp"] | undefined {
	const data = json?.data;
	if (!Array.isArray(data) || data.length === 0) return undefined;
	const servers = data.map((s: any) => ({
		name: String(s?.name ?? "?"),
		up: s?.status?.status === "connected",
	}));
	return {
		total: servers.length,
		up: servers.filter((s) => s.up).length,
		servers,
	};
}

/** Pure: model catalog + session model ref -> display name and context limit. */
export function parseModelCatalog(
	json: any,
	ref: { id?: string; providerID?: string } | undefined,
): { name?: string; ctxMax?: number } {
	const data = json?.data;
	if (!Array.isArray(data) || !ref) return {};
	const byId = (m: any) => m?.id === ref.id || m?.modelID === ref.id;
	const match =
		data.find((m: any) => m?.providerID === ref.providerID && byId(m)) ??
		data.find(byId);
	if (!match) return {};
	const name = typeof match.name === "string" && match.name ? match.name : undefined;
	const ctxMax =
		typeof match.limit?.context === "number" ? match.limit.context : undefined;
	return { name, ctxMax };
}

/** Pure: child sessions + active map -> subagent list. */
export function parseSubagents(
	children: any,
	active: any,
	parentId: string,
): SubagentInfo[] {
	const data = Array.isArray(children) ? children : children?.data;
	if (!Array.isArray(data)) return [];
	const running: Record<string, unknown> =
		active?.data && typeof active.data === "object" ? active.data : {};
	const out: SubagentInfo[] = [];
	for (const c of data) {
		if (!c || c.parentID !== parentId) continue;
		const status: SubagentInfo["status"] =
			String(c.id ?? "") in running
				? "running"
				: c.outcome === "failed"
					? "error"
					: "done";
		const info: SubagentInfo = {
			name: String(c.title || c.agent || "subagent"),
			status,
		};
		if (typeof c.cost === "number" && c.cost > 0) info.cost = c.cost;
		out.push(info);
	}
	return out;
}

/** Fetch the session by id, falling back to the newest session in this cwd. */
async function resolveSession(
	svc: OpenCodeService,
	ctx: AgentContext,
): Promise<any | null> {
	if (ctx.sessionId) {
		const r = await authedGet(
			svc,
			`/api/session/${encodeURIComponent(ctx.sessionId)}`,
		);
		if (r?.data) return r.data;
	}
	const q = new URLSearchParams({ directory: ctx.cwd, order: "desc", limit: "1" });
	const r = await authedGet(svc, `/api/session?${q.toString()}`);
	return r?.data?.[0] ?? null;
}

export const opencodeAdapter: Adapter = {
	id: "opencode",
	detect: (a) => a.agent === "opencode",
	async snapshot(ctx) {
		const snap: PanelSnapshot = { harness: "opencode", project: { cwd: ctx.cwd } };
		try {
			const svc = readService();
			if (!svc) return snap;

			const session = await resolveSession(svc, ctx);
			if (!session) return snap;

			const sid = session.id;
			const dir = session.location?.directory ?? ctx.cwd;
			snap.project = { cwd: dir };

			const gitP = getGitStatus(dir).catch(() => null);
			const [messagesRes, mcpRes, activeRes, childrenRes, catalog] =
				await Promise.all([
					authedGet(
						svc,
						`/api/session/${encodeURIComponent(sid)}/message?order=desc&limit=${MESSAGE_PAGE}`,
					),
					authedGet(svc, "/api/mcp"),
					authedGet(svc, "/api/session/active"),
					authedGet(svc, `/api/session?parentID=${encodeURIComponent(sid)}`),
					modelCatalog(svc),
				]);

			const ref = session.model;
			const { name, ctxMax } = parseModelCatalog(catalog, ref);
			const modelName =
				name ?? (ref?.id ? `${ref.providerID ? `${ref.providerID}/` : ""}${ref.id}` : undefined);
			if (modelName) {
				snap.model = { name: modelName };
				if (ref?.variant && ref.variant !== "default")
					snap.model.effort = ref.variant;
			}

			const messages: Message[] = messagesRes?.data ?? [];
			const asc = [...messages].sort(
				(a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0),
			);
			let ctxTokens: number | undefined;
			for (let i = asc.length - 1; i >= 0; i--) {
				const m = asc[i];
				if (m.type === "assistant" && m.tokens) {
					const c = m.tokens.cache ?? {};
					ctxTokens = (m.tokens.input ?? 0) + (c.read ?? 0) + (c.write ?? 0);
					break;
				}
			}
			const created = session.time?.created;
			snap.session = {
				ctxTokens,
				ctxMax,
				ctxPct:
					ctxTokens !== undefined && ctxMax
						? Math.round((ctxTokens / ctxMax) * 100)
						: undefined,
				cost: typeof session.cost === "number" ? session.cost : undefined,
				durationMs:
					typeof created === "number"
						? Math.max(0, Date.now() - created)
						: undefined,
			};

			const { turn } = parseMessages(messages);
			if (turn && Object.keys(turn).length) snap.turn = turn;

			const subs = parseSubagents(childrenRes, activeRes, sid);
			if (subs.length) snap.subagents = subs;

			const mcp = parseMcp(mcpRes);
			if (mcp) snap.mcp = mcp;

			const g = await gitP;
			if (g && g.branch && g.branch !== "no-git") {
				snap.project.branch = g.branch;
				snap.project.worktree = g.worktree;
			}
		} catch {}
		return snap;
	},
};
