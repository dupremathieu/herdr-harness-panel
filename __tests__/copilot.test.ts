import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { parseEvents, parseQuota } from "../src/adapters/copilot";
import { renderPanel } from "../src/render";

const read = (f: string) => readFileSync(new URL(`../fixtures/copilot/${f}`, import.meta.url), "utf-8");

describe("copilot parseEvents", () => {
	const p = parseEvents(read("events.jsonl"));
	it("reads the latest model and effort", () => {
		expect(p.model).toEqual({ name: "model-b", effort: "high" });
	});
	it("computes the current turn, excluding human-wait tools", () => {
		expect(p.turn).toMatchObject({ steps: 2, tokensOut: 200, toolMs: 30000, modelMs: 20000, tokPerSec: 10 });
	});
	it("tracks subagents", () => {
		expect(p.subagents).toEqual([{ name: "Explore Agent", status: "done" }]);
	});
	it("survives garbage", () => {
		expect(parseEvents("nope\n{}")).toEqual({});
	});
});

describe("copilot parseQuota", () => {
	it("keeps only limited quotas and reports credits left", () => {
		const u = parseQuota(JSON.parse(read("user.json")));
		expect(u?.provider).toBe("GitHub Copilot");
		expect(u?.windows).toHaveLength(1);
		expect(u?.windows[0]).toMatchObject({ label: "AI credits", pct: 1, detail: "74264 / 75000 left" });
		expect(u?.windows[0].resetsAt).toBe(Date.UTC(2026, 9, 1) / 1000);
	});
	it("returns undefined for unexpected payloads", () => {
		expect(parseQuota({})).toBeUndefined();
		expect(parseQuota(null)).toBeUndefined();
	});
	it("renders the detail instead of a bare percentage", () => {
		const u = parseQuota(JSON.parse(read("user.json")))!;
		const out = renderPanel({ harness: "copilot", usage: [u] }, 50).join("\n");
		expect(out).toContain("74264 / 75000 left");
	});
});
