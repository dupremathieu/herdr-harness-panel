import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	agyAdapter,
	formatModelName,
	mapSubagentStatus,
	parseAgyHistory,
	parseAgyMcpConfig,
	parseAgyTranscript,
	parseModelSetting,
} from "../src/adapters/agy";

const transcriptFixture = readFileSync(
	resolve(import.meta.dir, "../fixtures/agy/transcript.jsonl"),
	"utf-8"
);
const mcpFixture = readFileSync(
	resolve(import.meta.dir, "../fixtures/agy/mcp_config.json"),
	"utf-8"
);
const historyFixture = readFileSync(
	resolve(import.meta.dir, "../fixtures/agy/history.jsonl"),
	"utf-8"
);

describe("parseAgyTranscript", () => {
	it("extracts model, duration, subagents, and turn stats from fixture", () => {
		const parsed = parseAgyTranscript(transcriptFixture);
		expect(parsed.model).toEqual({
			name: "Gemini 3.8 Flash",
			effort: "High",
		});
		expect(parsed.session?.durationMs).toBe(8000);
		expect(parsed.subagents).toEqual([
			{ name: "Code Reviewer", status: "done" },
		]);
		expect(parsed.turn).toMatchObject({
			steps: 3,
			toolMs: 4000,
			modelMs: 4000,
		});
	});

	it("handles malformed lines and empty input without throwing", () => {
		expect(parseAgyTranscript("")).toEqual({});
		expect(parseAgyTranscript("garbage\n{}\nnot-json")).toEqual({});
	});

	it("excludes wait tools such as ask_question from tool compute time", () => {
		const transcript = [
			JSON.stringify({
				type: "USER_INPUT",
				created_at: "2026-01-01T00:00:00.000Z",
				content: "Question please",
			}),
			JSON.stringify({
				type: "PLANNER_RESPONSE",
				created_at: "2026-01-01T00:00:01.000Z",
				tool_calls: [{ name: "ask_question", args: {} }],
			}),
			JSON.stringify({
				type: "GENERIC",
				created_at: "2026-01-01T00:00:10.000Z",
				content: "user answered",
			}),
			JSON.stringify({
				type: "PLANNER_RESPONSE",
				created_at: "2026-01-01T00:00:12.000Z",
				content: "Done",
			}),
		].join("\n");

		const parsed = parseAgyTranscript(transcript);
		expect(parsed.turn?.steps).toBe(2);
		expect(parsed.turn?.toolMs).toBeUndefined();
		expect(parsed.turn?.modelMs).toBe(12000);
	});
});

describe("parseAgyMcpConfig", () => {
	it("extracts configured server names from mcpServers map", () => {
		expect(parseAgyMcpConfig(mcpFixture)).toEqual(["git", "memory"]);
	});

	it("handles array format and malformed JSON safely", () => {
		expect(parseAgyMcpConfig('{"mcpServers":["srv1","srv2"]}')).toEqual(["srv1", "srv2"]);
		expect(parseAgyMcpConfig("not-json")).toEqual([]);
		expect(parseAgyMcpConfig("{}")).toEqual([]);
	});
});

describe("parseAgyHistory", () => {
	it("extracts history entries correctly", () => {
		const parsed = parseAgyHistory(historyFixture);
		expect(parsed).toEqual([
			{
				conversationId: "test-conv-123",
				workspace: "/workspace/demo",
				timestamp: 1767225600000,
				display: "Initial prompt",
			},
		]);
	});

	it("ignores malformed JSONL lines", () => {
		expect(parseAgyHistory("bad-line\n{}")).toEqual([{}]);
	});
});

describe("model helpers", () => {
	it("parses model setting phrases with and without effort", () => {
		expect(
			parseModelSetting(
				"The user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment."
			)
		).toEqual({ name: "Gemini 3.8 Flash", effort: "High" });

		expect(
			parseModelSetting("The user changed setting Model Selection from None to Gemini 1.5 Pro.")
		).toEqual({ name: "Gemini 1.5 Pro", effort: undefined });
	});

	it("formats raw model strings from database", () => {
		expect(formatModelName("gemini-3.8-flash-high")).toEqual({
			name: "Gemini 3.8 Flash",
			effort: "high",
		});
		expect(formatModelName("gemini-1.5-pro")).toEqual({
			name: "Gemini 1.5 Pro",
			effort: undefined,
		});
	});
});

describe("subagent status mapping", () => {
	it("maps status strings correctly", () => {
		expect(mapSubagentStatus("CASCADE_RUN_STATUS_RUNNING")).toBe("running");
		expect(mapSubagentStatus("CASCADE_RUN_STATUS_IDLE")).toBe("done");
		expect(mapSubagentStatus("CASCADE_RUN_STATUS_ERROR")).toBe("error");
		expect(mapSubagentStatus("CASCADE_RUN_STATUS_RUNNING", 1)).toBe("error");
	});
});

describe("agyAdapter", () => {
	it("detects agy and antigravity aliases", () => {
		expect(agyAdapter.detect({ agent: "agy", cwd: "/test" })).toBe(true);
		expect(agyAdapter.detect({ agent: "antigravity", cwd: "/test" })).toBe(true);
		expect(agyAdapter.detect({ agent: "claude", cwd: "/test" })).toBe(false);
		expect(agyAdapter.detect({ agent: "codex", cwd: "/test" })).toBe(false);
	});

	it("returns a snapshot without throwing even for unknown directories", async () => {
		const snap = await agyAdapter.snapshot({
			agent: "agy",
			cwd: "/nonexistent/test/path",
		});
		expect(snap.harness).toBe("agy");
		expect(snap.project?.cwd).toBe("/nonexistent/test/path");
		expect(snap.unsupported).toBeUndefined();
	});
});
