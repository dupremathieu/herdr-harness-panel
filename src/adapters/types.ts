import type { PanelSnapshot } from "../model";

/** Agent as reported by `herdr agent list`. */
export interface AgentContext {
	/** herdr agent kind: "claude", "codex", "opencode", ... */
	agent: string;
	sessionId?: string;
	cwd: string;
	paneId?: string;
	status?: string;
}

export interface Adapter {
	id: string;
	detect(agent: AgentContext): boolean;
	/** Must never throw and should resolve in < 500 ms; return partial data instead. */
	snapshot(ctx: AgentContext): Promise<PanelSnapshot>;
}

/** Placeholder factory for harnesses that still need a real adapter (see SPEC.md). */
export function placeholderAdapter(id: string, aliases: string[] = []): Adapter {
	const names = [id, ...aliases];
	return {
		id,
		detect: (a) => names.includes(a.agent),
		async snapshot(ctx) {
			return {
				harness: id,
				unsupported: true,
				project: { cwd: ctx.cwd },
			};
		},
	};
}
