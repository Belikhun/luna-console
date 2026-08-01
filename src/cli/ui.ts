import pc from "picocolors";

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

/** Warning line — the operation went through, but something needs attention. */
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
