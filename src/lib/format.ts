const esc = (code: string) => (text: string | number) =>
	`\x1b[${code}m${text}\x1b[0m`;

export const colors = {
	bold: esc("1"),
	dim: esc("2"),
	gray: esc("90"),
	red: esc("31"),
	green: esc("32"),
	yellow: esc("33"),
	lightGray: esc("97"),
	peach: esc("38;2;222;115;86"),
};

export function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60000);
	const hours = Math.floor(minutes / 60);
	return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** Braille progress bar; color goes green -> yellow -> red with usage. */
export function progressBar(pct: number, length = 15): string {
	const levels = ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"];
	const steps = length * (levels.length - 1);
	const cur = Math.round((Math.max(0, Math.min(100, pct)) / 100) * steps);
	const full = Math.floor(cur / (levels.length - 1));
	const part = cur % (levels.length - 1);
	let bar = "⣿".repeat(full);
	if (full < length) bar += levels[part] + "⣀".repeat(length - full - 1);
	const color = pct >= 80 ? colors.red : pct >= 60 ? colors.yellow : colors.green;
	return color(bar);
}
