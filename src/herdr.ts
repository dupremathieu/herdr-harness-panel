import type { AgentContext } from "./adapters/types";

interface HerdrAgent {
	agent: string;
	agent_session?: { value?: string };
	agent_status?: string;
	cwd: string;
	focused?: boolean;
	pane_id: string;
	tab_id?: string;
	workspace_id: string;
}

async function herdrJson(args: string[]): Promise<any> {
	const bin = process.env.HERDR_BIN_PATH || "herdr";
	const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "ignore" });
	const text = await new Response(proc.stdout).text();
	return JSON.parse(text);
}

function toContext(a: HerdrAgent): AgentContext {
	return {
		agent: a.agent,
		sessionId: a.agent_session?.value,
		cwd: a.cwd,
		paneId: a.pane_id,
		status: a.agent_status,
	};
}

/**
 * The agent the panel follows: the focused agent of this panel's tab (or workspace)
 * (falling back to any agent in it). Returns null outside herdr or with no agent.
 */
export async function findFollowedAgent(): Promise<AgentContext | null> {
	try {
		const list = await herdrJson(["agent", "list"]);
		const agents: HerdrAgent[] = list?.result?.agents ?? [];
		const tab = process.env.HERDR_TAB_ID;
		const ws = process.env.HERDR_WORKSPACE_ID;
		const inWs = tab
			? agents.filter((a) => a.tab_id === tab)
			: ws
				? agents.filter((a) => a.workspace_id === ws)
				: agents;
		const pick = inWs.find((a) => a.focused) ?? inWs[0];
		return pick ? toContext(pick) : null;
	} catch {
		return null;
	}
}
