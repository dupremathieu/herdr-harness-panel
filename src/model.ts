/**
 * PanelSnapshot: the single contract between harness adapters and the UI.
 * Every field is optional; the UI hides sections whose data is absent.
 * See SPEC.md for field semantics and units.
 */

export interface PanelSnapshot {
	harness: string;
	/** True for placeholder adapters that have no data source yet. */
	unsupported?: boolean;
	model?: { name: string; effort?: string; fast?: boolean };
	session?: {
		ctxTokens?: number;
		ctxMax?: number;
		/** 0-100 */
		ctxPct?: number;
		/** USD, cumulative for the session */
		cost?: number;
		durationMs?: number;
	};
	project?: { cwd: string; branch?: string; worktree?: string | null };
	/** Stats for the current (or last) turn: from the last user prompt to now. */
	turn?: {
		tokPerSec?: number;
		modelMs?: number;
		toolMs?: number;
		steps?: number;
		tokensIn?: number;
		tokensOut?: number;
		/** 0-100 cache read ratio of input tokens */
		cacheHit?: number;
		cost?: number;
	};
	subagents?: SubagentInfo[];
	mcp?: { total: number; up?: number; servers?: { name: string; up?: boolean }[] };
	usage?: UsageProvider[];
}

export interface SubagentInfo {
	name: string;
	status: "running" | "done" | "error";
	cost?: number;
}

export interface UsageProvider {
	provider: string;
	windows: {
		label: string;
		/** 0-100 used */
		pct: number;
		/** epoch seconds */
		resetsAt?: number;
		/** shown instead of pct when set, e.g. "74264 / 75000 left" */
		detail?: string;
	}[];
}
