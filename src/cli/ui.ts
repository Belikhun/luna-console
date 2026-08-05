import pc from "picocolors";

import type { ProgressReporter, ProgressSnapshot, ProgressStatus } from "../client/core/progress";

export { pc };

export const Sym = {
	ok: pc.green("●"),
	bad: pc.red("●"),
	warn: pc.yellow("●"),
	off: pc.dim("○"),
	arrow: pc.dim("→"),
	check: pc.green("✔"),
	cross: pc.red("✘"),
	dot: pc.dim("·"),
};

/** Neutral status line. */
export function info(msg: string): void {
	console.log(`${pc.blue("i")} ${msg}`);
}

/** Success line. */
export function ok(msg: string): void {
	console.log(`${Sym.check} ${msg}`);
}

/** Warning line: the operation went through, but something needs attention. */
export function warn(msg: string): void {
	console.log(`${pc.yellow("!")} ${pc.yellow(msg)}`);
}

/** Failure line, on stderr. */
export function fail(msg: string): void {
	console.error(`${Sym.cross} ${pc.red(msg)}`);
}

/** Visible width, ignoring ANSI escapes. */
export function width(s: string): number {
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Right-pad to a visible width, so colour codes don't skew the columns. */
function pad(s: string, w: number): string {
	return s + " ".repeat(Math.max(0, w - width(s)));
}

export interface TableOpts {
	head?: string[];
	indent?: string;
}

/** Render rows as a column-aligned table. Ragged rows are padded with blanks. */
export function table(rows: string[][], opts: TableOpts = {}): string {
	const all = opts.head
		? [opts.head.map((head) => pc.bold(pc.dim(head.toUpperCase()))), ...rows]
		: rows;

	if (all.length === 0) {
		return "";
	}

	const cols = Math.max(...all.map((row) => row.length));

	const widths = Array.from({ length: cols }, (_unused, col) =>
		Math.max(...all.map((row) => width(row[col] ?? ""))),
	);

	const indent = opts.indent ?? "  ";

	return all
		.map((row) => {
			const cells = widths.map((cellWidth, col) => pad(row[col] ?? "", cellWidth));

			return (indent + cells.join("  ")).trimEnd();
		})
		.join("\n");
}

/** Print a table built by `table`. */
export function printTable(rows: string[][], opts: TableOpts = {}): void {
	console.log(table(rows, opts));
}

/** Human-readable byte count, one decimal below 100 of a unit. */
export function fmtBytes(n: number): string {
	if (n < 1024) {
		return `${n} B`;
	}

	const units = ["KB", "MB", "GB", "TB"];
	let value = n / 1024;
	let unit = 0;

	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}

	return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** Coarse duration, dropping to the two most significant units. */
export function fmtDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);

	if (seconds < 60) {
		return `${seconds}s`;
	}

	const minutes = Math.floor(seconds / 60);

	if (minutes < 60) {
		return `${minutes}m ${seconds % 60}s`;
	}

	const hours = Math.floor(minutes / 60);

	if (hours < 48) {
		return `${hours}h ${minutes % 60}m`;
	}

	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** `old → new` version transition, dimmed on the left. */
export function versionDiff(from: string | undefined, to: string): string {
	return `${pc.dim(from ?? "?")} ${Sym.arrow} ${pc.green(to)}`;
}

/** Simple inline spinner for long operations. */
export class Spinner {
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	private frame = 0;
	private timer?: Timer;
	private text = "";

	/** Begin animating. Falls back to one plain line when stdout is not a TTY. */
	start(text: string): this {
		this.text = text;

		if (!process.stdout.isTTY) {
			console.log(`... ${text}`);

			return this;
		}

		this.timer = setInterval(() => {
			const glyph = pc.cyan(this.frames[this.frame++ % this.frames.length]!);

			process.stdout.write(`\r\x1b[2K${glyph} ${this.text}`);
		}, 80);

		return this;
	}

	/** Replace the trailing label without restarting the animation. */
	update(text: string): void {
		this.text = text;

		if (!process.stdout.isTTY) {
			console.log(`... ${text}`);
		}
	}

	/** Stop animating, clear the line, and optionally print a closing message. */
	stop(final?: string): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
			process.stdout.write("\r\x1b[2K");
		}

		if (final) {
			console.log(final);
		}
	}
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Cells in a node's progress bar. */
const BAR_CELLS = 12;

/** Repaint interval; a burst of reports must not cost a redraw each. */
const REPAINT_MS = 80;

/** Colour a status's own text, matching the info/ok/warn/fail lines above. */
function statusColor(status: ProgressStatus, text: string): string {
	switch (status) {
		case "okay":
			return pc.green(text);

		case "warn":
			return pc.yellow(text);

		case "error":
			return pc.red(text);

		case "info":
			return pc.cyan(text);
	}
}

/**
 * Live renderer for a ProgressReporter tree: one line per node, redrawn in
 * place, so a long operation reports every step it is waiting on rather than a
 * single opaque spinner. Falls back to one appended line per report when stdout
 * is not a TTY, which is what the console's terminal drawer and CI logs get.
 */
export class ProgressView {
	private root: ProgressReporter;
	private frame = 0;
	private painted = 0;
	private timer?: Timer;
	private live = false;

	constructor(root: ProgressReporter) {
		this.root = root;
	}

	/** Attach to the tree and start drawing. */
	start(): this {
		this.live = true;

		this.root.onUpdate((update) => {
			if (process.stdout.isTTY) {
				return;
			}

			// no cursor to move: report each step as its own line instead
			if (update.message) {
				const pct = `${Math.round(update.progress * 100)}%`.padStart(4);

				console.log(`${pc.dim(pct)} ${"  ".repeat(update.level - 1)}${update.message}`);
			}
		});

		if (process.stdout.isTTY) {
			this.timer = setInterval(() => this.paint(), REPAINT_MS);
			this.paint();
		}

		return this;
	}

	/** Final repaint, then release the lines and optionally print a closing message. */
	stop(final?: string): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}

		if (this.live && process.stdout.isTTY) {
			this.paint();
		}

		this.live = false;
		this.painted = 0;

		if (final) {
			console.log(final);
		}
	}

	private paint(): void {
		const lines = this.render(this.root.snapshot());

		// back up over the previous frame; every line is cleared before it is rewritten
		// so a shorter line cannot leave the tail of the old one behind
		const up = this.painted ? `\x1b[${this.painted}A` : "";

		process.stdout.write(`${up}${lines.map((line) => `\x1b[2K${line}`).join("\n")}\n`);

		this.painted = lines.length;
		this.frame += 1;
	}

	/** One line per node, depth-first, parents before their children. */
	private render(node: ProgressSnapshot, out: string[] = []): string[] {
		const indent = "  ".repeat(node.level - 1);
		const pct = `${Math.round(node.progress * 100)}%`.padStart(4);

		// a node that reached 100% having warned or failed is not a success: its own
		// status outranks being finished, or a failed step would render as a tick
		const glyph =
			node.status === "error"
				? Sym.cross
				: node.status === "warn"
					? Sym.warn
					: node.done
						? Sym.check
						: pc.cyan(SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]!);

		const tone = node.done && node.status === "info" ? "okay" : node.status;
		const filled = Math.round(node.progress * BAR_CELLS);

		const bar =
			statusColor(tone, "█".repeat(filled)) + pc.dim("░".repeat(BAR_CELLS - filled));

		const head = `  ${indent}${glyph} ${bar} ${pc.dim(pct)} ${node.name}`;

		// a pty with no size reports 0 columns, which would suppress every message
		const columns = process.stdout.columns || 80;
		const room = columns - width(head) - 4;
		const tail = node.message && room > 8 ? pc.dim(` · ${trim(node.message, room)}`) : "";

		out.push(head + tail);

		for (const child of node.children) {
			this.render(child, out);
		}

		return out;
	}
}

/** Shorten to a visible width, with an ellipsis when it does not fit. */
function trim(text: string, room: number): string {
	return text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`;
}
