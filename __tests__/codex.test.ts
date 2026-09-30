import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { firstLine, parseCodexMcpConfig, parseCodexModelContext, parseCodexSession } from "../src/adapters/codex";

const fixture = readFileSync(resolve(import.meta.dir, "../fixtures/codex/session.jsonl"), "utf8");

describe("Codex adapter parsers", () => {
	it("extracts model, context, duration and last-turn usage", () => {
		const parsed = parseCodexSession(fixture);
		expect(parsed.model).toEqual({ name: "gpt-6-mini", effort: "medium" });
		expect(parsed.session).toMatchObject({ ctxTokens: 120, ctxMax: 128000, durationMs: 6100 });
		expect(parsed.turn).toMatchObject({ tokensIn: 120, tokensOut: 16, steps: 1, toolMs: 2000 });
		expect(parsed.turn?.tokPerSec).toBeUndefined();
		expect(parsed.turn?.cacheHit).toBe(25);
	});

	it("finds configured MCP server sections without reading values", () => {
		expect(parseCodexMcpConfig('[mcp_servers.alpha]\ncommand = "demo"\n[mcp_servers.beta]\n')).toEqual(["alpha", "beta"]);
	});

	it("uses the model's full context window when the catalog provides it", () => {
		const catalog = JSON.stringify({ models: [{ slug: "gpt-6-sol", context_window: 272000, effective_context_window_percent: 95 }] });
		expect(parseCodexModelContext(catalog, "gpt-6-sol")).toBe(272000);
		expect(parseCodexModelContext(catalog, "unknown")).toBeUndefined();
	});

	it("handles malformed JSONL without throwing", () => {
		expect(parseCodexSession("garbage\n{}\n").turn).toBeUndefined();
	});

	it("keeps the full session duration when the journal head is outside the tail", () => {
		const tail = fixture.split("\n").slice(1).join("\n");
		expect(parseCodexSession(tail, Date.parse("2026-01-01T00:00:00.000Z")).session?.durationMs).toBe(6100);
	});

	it("reads quota windows and measures response speed without tool time", () => {
		const rows = [
			{ timestamp: "2026-01-01T00:00:00.000Z", type: "response_item", payload: { type: "message", role: "user" } },
			{ timestamp: "2026-01-01T00:00:04.800Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "call-1" } },
			{ timestamp: "2026-01-01T00:00:05.000Z", type: "token_usage_record", payload: { usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 } } },
			{ timestamp: "2026-01-01T00:00:09.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-1" } },
			{ timestamp: "2026-01-01T00:00:11.000Z", type: "token_usage_record", payload: { usage: { input_tokens: 110, cached_input_tokens: 30, output_tokens: 40 } } },
			{ timestamp: "2026-01-01T00:00:12.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 110 }, model_context_window: 200 }, rate_limits: { primary: { used_percent: 12, resets_at: 1767272400 }, secondary: { used_percent: 25, resets_at: 1767830400 } } } },
		];
		const parsed = parseCodexSession(rows.map((row) => JSON.stringify(row)).join("\n"));
		expect(parsed.session).toMatchObject({ ctxTokens: 110, ctxPct: 55 });
		expect(parsed.usage?.[0].windows).toEqual([
			{ label: "5h", pct: 12, resetsAt: 1767272400 },
			{ label: "7d", pct: 25, resetsAt: 1767830400 },
		]);
		expect(parsed.turn).toMatchObject({ tokensIn: 210, tokensOut: 90, modelMs: 7000, toolMs: 4200, steps: 2, tokPerSec: 20 });
	});

	it("reads session metadata lines larger than 8 KiB", () => {
		const dir = mkdtempSync(`${tmpdir()}/harness-panel-codex-`);
		const path = `${dir}/session.jsonl`;
		const meta = JSON.stringify({ type: "session_meta", payload: { cwd: "/work/demo", instructions: "x".repeat(20000) } });
		try {
			writeFileSync(path, `${meta}\n${fixture}`);
			expect(JSON.parse(firstLine(path)).payload.cwd).toBe("/work/demo");
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
