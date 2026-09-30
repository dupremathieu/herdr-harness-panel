#!/usr/bin/env bun
/**
 * harness-panel: side panel following the focused herdr agent.
 *   bun src/index.ts                  live TUI (refresh 1s)
 *   bun src/index.ts --once           render once to stdout
 *   --harness <id> --session <id> --cwd <dir>   bypass herdr detection
 */
import { pickAdapter } from "./adapters";
import type { AgentContext } from "./adapters/types";
import { findFollowedAgent } from "./herdr";
import { renderPanel } from "./render";

const args = process.argv.slice(2);
const flag = (n: string) => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const once = args.includes("--once");
const refreshMs = Number(flag("refresh") ?? 1000);

let last: AgentContext | null = null;

async function frame(): Promise<string[]> {
	const forced = flag("harness");
	const agent: AgentContext | null = forced
		? { agent: forced, sessionId: flag("session"), cwd: flag("cwd") ?? process.cwd() }
		: ((await findFollowedAgent()) ?? last);
	if (!agent) return ["harness-panel", "", "no agent found", "(not in herdr?)"];
	last = agent;
	const adapter = pickAdapter(agent);
	if (!adapter) return ["harness-panel", "", `no adapter for "${agent.agent}"`];
	const snap = await adapter.snapshot(agent).catch(() => ({ harness: adapter.id }));
	return renderPanel(snap, process.stdout.columns || 40);
}

if (once) {
	console.log((await frame()).join("\n"));
} else {
	process.stdout.write("\x1b[?1049h\x1b[?25l");
	const restore = () => {
		process.stdout.write("\x1b[?25h\x1b[?1049l");
		process.exit(0);
	};
	process.on("SIGINT", restore);
	process.on("SIGTERM", restore);
	for (;;) {
		const lines = (await frame()).slice(0, (process.stdout.rows || 50) - 1);
		process.stdout.write(`\x1b[H\x1b[2J${lines.join("\n")}`);
		await Bun.sleep(refreshMs);
	}
}
