import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { firstLine, parseCodexMcpConfig, parseCodexSession } from "../src/adapters/codex";

const fixture = readFileSync(resolve(import.meta.dir, "../fixtures/codex/session.jsonl"), "utf8");

describe("Codex adapter parsers", () => {
	it("extracts model, context, duration and last-turn usage", () => {
		const parsed = parseCodexSession(fixture);
		expect(parsed.model).toEqual({ name: "gpt-6-mini", effort: "medium" });
		expect(parsed.session).toMatchObject({ ctxTokens: 120, ctxMax: 128000, durationMs: 6100 });
		expect(parsed.turn).toMatchObject({ tokensIn: 120, tokensOut: 16, steps: 1, toolMs: 2000, modelMs: 2100 });
		expect(parsed.turn?.cacheHit).toBe(25);
	});

	it("finds configured MCP server sections without reading values", () => {
		expect(parseCodexMcpConfig('[mcp_servers.alpha]\ncommand = "demo"\n[mcp_servers.beta]\n')).toEqual(["alpha", "beta"]);
	});

	it("handles malformed JSONL without throwing", () => {
		expect(parseCodexSession("garbage\n{}\n").turn).toBeUndefined();
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
