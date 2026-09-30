import { describe, expect, it } from "bun:test";
import { parseTranscript } from "../src/adapters/claude";
import { renderPanel } from "../src/render";

const line = (o: object) => JSON.stringify(o);
const T = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

const transcript = [
	line({ type: "user", timestamp: T(0), message: { content: "hi" } }),
	line({
		type: "assistant", timestamp: T(10), requestId: "r1",
		message: {
			usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 100 },
			content: [{ type: "tool_use", id: "t1", name: "Agent", input: { description: "review" } }],
		},
	}),
	line({
		type: "user", timestamp: T(30),
		message: { content: [{ type: "tool_result", tool_use_id: "t1" }] },
	}),
	line({
		type: "assistant", timestamp: T(40), requestId: "r2",
		message: { usage: { input_tokens: 100, output_tokens: 100 }, content: [{ type: "text", text: "ok" }] },
	}),
	line({ type: "assistant", isSidechain: true, timestamp: T(41), requestId: "s", message: { usage: { output_tokens: 999 } } }),
].join("\n");

describe("parseTranscript", () => {
	it("computes turn stats, ignoring sidechains", () => {
		const { turn } = parseTranscript(transcript);
		expect(turn).toMatchObject({ steps: 2, tokensOut: 200, toolMs: 20000, modelMs: 20000, tokPerSec: 10 });
		expect(turn?.cacheHit).toBe(45);
	});
	it("tracks subagent status", () => {
		expect(parseTranscript(transcript).subagents).toEqual([{ name: "review", status: "done" }]);
		const running = transcript.split("\n").filter((l) => !l.includes("tool_result")).join("\n");
		expect(parseTranscript(running).subagents?.[0].status).toBe("running");
	});
	it("survives garbage", () => {
		expect(parseTranscript("nope\n{}").subagents).toEqual([]);
	});
});

describe("renderPanel", () => {
	it("hides absent sections and flags placeholders", () => {
		const out = renderPanel({ harness: "codex", unsupported: true }, 40).join("\n");
		expect(out).toContain("no adapter yet");
		expect(out).not.toContain("Turn stats");
	});
});
