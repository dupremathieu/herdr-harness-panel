import { agyAdapter } from "./agy";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { copilotAdapter } from "./copilot";
import { opencodeAdapter } from "./opencode";
import type { Adapter, AgentContext } from "./types";

/** Register new harness adapters here. */
export const adapters: Adapter[] = [
	claudeAdapter,
	codexAdapter,
	opencodeAdapter,
	agyAdapter,
	copilotAdapter,
];

export function pickAdapter(agent: AgentContext): Adapter | undefined {
	return adapters.find((a) => a.detect(agent));
}
