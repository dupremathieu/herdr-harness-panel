import { colors as c, formatDuration, progressBar } from "./lib/format";
import type { PanelSnapshot } from "./model";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Left label, right value, padded to width (ANSI-aware). */
function row(label: string, value: string, width: number): string {
	const pad = Math.max(1, width - strip(label).length - strip(value).length);
	return `${c.gray(label)}${" ".repeat(pad)}${value}`;
}

function header(title: string, width: number): string[] {
	return ["", c.dim("─".repeat(width)), c.bold(title)];
}

const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function until(epochSec: number): string {
	const ms = epochSec * 1000 - Date.now();
	if (ms <= 0) return "now";
	const h = Math.floor(ms / 3600000);
	const m = Math.floor((ms % 3600000) / 60000);
	return h > 0 ? `${h}h${m}m` : `${m}m`;
}

/** Pure: snapshot -> lines. Sections absent from the snapshot are skipped. */
export function renderPanel(s: PanelSnapshot, width: number): string[] {
	const out: string[] = [];
	const w = Math.max(20, width - 1);

	out.push(c.bold(`${s.harness}`) + (s.model?.name ? c.gray(" · ") + c.peach(s.model.name) : ""));
	if (s.model?.effort || s.model?.fast)
		out.push(c.gray(`effort ${s.model.effort ?? "-"}${s.model.fast ? " ⚡" : ""}`));

	if (s.unsupported) {
		out.push("", c.yellow("no adapter yet"), c.gray("see SPEC.md"));
	}

	if (s.session) {
		out.push(...header("Session", w));
		const { ctxPct, ctxTokens, cost, durationMs } = s.session;
		if (ctxPct !== undefined) {
			out.push(
				row(
					"Context",
					`${ctxTokens !== undefined ? `${k(ctxTokens)} · ` : ""}${ctxPct}%`,
					w,
				),
				progressBar(ctxPct),
			);
		}
		if (cost !== undefined) out.push(row("Cost", money(cost), w));
		if (durationMs !== undefined) out.push(row("Duration", formatDuration(durationMs), w));
	}

	if (s.project) {
		out.push(...header("Project", w));
		out.push(row("dir", c.lightGray(s.project.cwd.split("/").pop() || "/"), w));
		if (s.project.branch) out.push(row("branch", c.lightGray(s.project.branch), w));
		if (s.project.worktree) out.push(row("worktree", c.peach(s.project.worktree), w));
	}

	for (const u of s.usage ?? []) {
		out.push(...header(`Usage · ${u.provider}`, w));
		for (const win of u.windows)
			out.push(
				row(
					win.label + (win.resetsAt ? ` (${until(win.resetsAt)})` : ""),
					win.detail ?? `${win.pct}%`,
					w,
				),
			);
	}

	if (s.turn) {
		const t = s.turn;
		out.push(...header("Turn stats", w));
		if (t.tokPerSec !== undefined) out.push(row("Response", `~${t.tokPerSec} tok/s`, w));
		if (t.modelMs !== undefined) out.push(row("Model time", secs(t.modelMs), w));
		if (t.toolMs !== undefined) out.push(row("Tool time", secs(t.toolMs), w));
		if (t.steps !== undefined) out.push(row("Steps", String(t.steps), w));
		if (t.tokensIn !== undefined || t.tokensOut !== undefined)
			out.push(row("Tokens", `${k(t.tokensIn ?? 0)} ↑ · ${k(t.tokensOut ?? 0)} ↓`, w));
		if (t.cacheHit !== undefined) out.push(row("Cache", c.green(`${t.cacheHit}%`), w));
		if (t.cost !== undefined) out.push(row("Cost", money(t.cost), w));
	}

	if (s.subagents?.length) {
		out.push(...header(`Subagents · ${s.subagents.length}`, w));
		for (const a of s.subagents.slice(-8)) {
			const st =
				a.status === "running" ? c.yellow("…") : a.status === "error" ? c.red("✗") : c.green("✓");
			const name = a.name.length > w - 4 ? `${a.name.slice(0, w - 5)}…` : a.name;
			out.push(`${st} ${name}`);
		}
	}

	if (s.mcp) {
		const count = s.mcp.up !== undefined ? `${s.mcp.up}/${s.mcp.total}` : String(s.mcp.total);
		out.push(...header(`MCP · ${count}`, w));
		for (const m of s.mcp.servers ?? [])
			out.push(`${m.up === false ? c.red("○") : c.gray("●")} ${m.name}`);
	}
	return out;
}
