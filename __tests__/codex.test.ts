import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCodexMcpConfig, parseCodexSession } from "../src/adapters/codex";

const fixture = readFileSync(resolve(import.meta.dir, "../fixtures/codex/session.jsonl"), "utf8");

describe("Codex adapter parsers", () => {
	it("extracts model, context, duration and last-turn usage", () => {
		const parsed = parseCodexSession(fixture);
		expect(parsed.model).toEqual({ name: "gpt-6-mini", effort: "medium" });
		expect(parsed.session).toMatchObject({ ctxTokens: 150, ctxMax: 128000, durationMs: 6100 });
		expect(parsed.turn).toMatchObject({ tokensIn: 150, tokensOut: 16, steps: 1, toolMs: 2000, modelMs: 2100 });
		expect(parsed.turn?.cacheHit).toBe(20);
	});

	it("finds configured MCP server sections without reading values", () => {
		expect(parseCodexMcpConfig('[mcp_servers.alpha]\ncommand = "demo"\n[mcp_servers.beta]\n')).toEqual(["alpha", "beta"]);
	});

	it("handles malformed JSONL without throwing", () => {
		expect(parseCodexSession("garbage\n{}\n").turn).toBeUndefined();
	});
});
