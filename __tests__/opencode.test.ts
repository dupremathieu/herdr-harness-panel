import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	opencodeAdapter,
	parseMcp,
	parseMessages,
	parseModelCatalog,
	parseService,
	parseSubagents,
} from "../src/adapters/opencode";
import { renderPanel } from "../src/render";

const FIX = join(import.meta.dir, "..", "fixtures", "opencode");
const fx = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf-8"));

const SESSION_ID = "ses_test0000000000000000";
const PW = "test-pass";

let server: ReturnType<typeof Bun.serve>;
let seenAuth = "";

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			seenAuth = req.headers.get("authorization") ?? "";
			const url = new URL(req.url);
			const p = url.pathname;
			const json = (o: unknown) => Response.json(o);
			if (p === "/api/session/active") return json(fx("active.json"));
			if (p === "/api/model") return json(fx("models.json"));
			if (p === "/api/mcp") return json(fx("mcp.json"));
			if (p.endsWith("/message")) return json(fx("messages.json"));
			if (p === "/api/session" && url.searchParams.has("parentID"))
				return json(fx("children.json"));
			if (p === "/api/session") return json(fx("session-list.json"));
			if (/^\/api\/session\/[^/]+$/.test(p)) return json(fx("session.json"));
			return new Response("not found", { status: 404 });
		},
	});
	process.env.HARNESS_PANEL_OPENCODE_URL = `http://127.0.0.1:${server.port}`;
	process.env.HARNESS_PANEL_OPENCODE_PASSWORD = PW;
});

afterAll(() => {
	server.stop(true);
	delete process.env.HARNESS_PANEL_OPENCODE_URL;
	delete process.env.HARNESS_PANEL_OPENCODE_PASSWORD;
});

describe("pure parsers", () => {
	it("parses the service file", () => {
		expect(parseService('{"url":"http://127.0.0.1:1/","password":"p"}')).toEqual({
			url: "http://127.0.0.1:1",
			password: "p",
		});
		expect(parseService("nope")).toBeNull();
		expect(parseService('{"url":"http://x"}')).toBeNull();
	});

	it("computes turn stats since the last user prompt", () => {
		const { turn } = parseMessages(fx("messages.json").data, 1000000009000);
		expect(turn).toEqual({
			steps: 2,
			tokensIn: 3000,
			tokensOut: 150,
			cacheHit: 90,
			cost: 0.003,
			modelMs: 1000,
			toolMs: 800,
			tokPerSec: 150,
		});
	});

	it("omits turn stats when no user prompt is in the page", () => {
		const assistants = fx("messages.json").data.filter(
			(m: { type: string }) => m.type !== "user",
		);
		expect(parseMessages(assistants).turn).toBeUndefined();
		expect(parseMessages("garbage").turn).toBeUndefined();
	});

	it("maps MCP statuses, model catalog and subagents", () => {
		expect(parseMcp(fx("mcp.json"))).toEqual({
			total: 2,
			up: 1,
			servers: [
				{ name: "demo", up: true },
				{ name: "offline", up: false },
			],
		});
		expect(parseMcp({ data: [] })).toBeUndefined();

		expect(
			parseModelCatalog(fx("models.json"), { id: "model-x", providerID: "prov" }),
		).toEqual({ name: "Model X", ctxMax: 200000 });
		expect(parseModelCatalog(fx("models.json"), { id: "nope", providerID: "x" })).toEqual(
			{},
		);

		expect(parseSubagents(fx("children.json"), fx("active.json"), SESSION_ID)).toEqual([
			{ name: "Explore code", status: "running", cost: 0.02 },
			{ name: "Check patch", status: "error", cost: 0.03 },
		]);
	});
});

describe("opencodeAdapter", () => {
	it("detects the opencode agent", () => {
		expect(opencodeAdapter.detect({ agent: "opencode", cwd: "/" })).toBe(true);
		expect(opencodeAdapter.detect({ agent: "claude", cwd: "/" })).toBe(false);
	});

	it("builds a full snapshot from the local server", async () => {
		const snap = await opencodeAdapter.snapshot({
			agent: "opencode",
			sessionId: SESSION_ID,
			cwd: "/work/project",
		});
		expect(snap.harness).toBe("opencode");
		expect(snap.unsupported).toBeUndefined();
		expect(snap.model).toEqual({ name: "Model X", effort: "high" });
		expect(snap.session).toMatchObject({
			ctxTokens: 2000,
			ctxMax: 200000,
			ctxPct: 1,
			cost: 0.0125,
		});
		expect(snap.session?.durationMs).toBeGreaterThanOrEqual(0);
		expect(snap.turn).toMatchObject({
			steps: 2,
			tokensIn: 3000,
			tokensOut: 150,
			cacheHit: 90,
			modelMs: 1000,
			toolMs: 800,
		});
		expect(snap.subagents).toEqual([
			{ name: "Explore code", status: "running", cost: 0.02 },
			{ name: "Check patch", status: "error", cost: 0.03 },
		]);
		expect(snap.mcp).toEqual({
			total: 2,
			up: 1,
			servers: [
				{ name: "demo", up: true },
				{ name: "offline", up: false },
			],
		});
		expect(seenAuth).toBe(`Basic ${btoa(`opencode:${PW}`)}`);

		const out = renderPanel(snap, 40).join("\n");
		expect(out).toContain("Subagents");
		expect(out).toContain("MCP");
	});

	it("falls back to the newest session for the cwd", async () => {
		const snap = await opencodeAdapter.snapshot({ agent: "opencode", cwd: "/work/project" });
		expect(snap.session?.ctxMax).toBe(200000);
		expect(snap.turn?.steps).toBe(2);
	});

	it("returns a minimal snapshot when no server is configured", async () => {
		const url = process.env.HARNESS_PANEL_OPENCODE_URL;
		const pass = process.env.HARNESS_PANEL_OPENCODE_PASSWORD;
		delete process.env.HARNESS_PANEL_OPENCODE_URL;
		delete process.env.HARNESS_PANEL_OPENCODE_PASSWORD;
		process.env.HARNESS_PANEL_OPENCODE_SERVICE = "/nonexistent/opencode/service.json";
		try {
			const snap = await opencodeAdapter.snapshot({ agent: "opencode", cwd: "/tmp" });
			expect(snap).toEqual({ harness: "opencode", project: { cwd: "/tmp" } });
		} finally {
			process.env.HARNESS_PANEL_OPENCODE_URL = url;
			process.env.HARNESS_PANEL_OPENCODE_PASSWORD = pass;
			delete process.env.HARNESS_PANEL_OPENCODE_SERVICE;
		}
	});
});
