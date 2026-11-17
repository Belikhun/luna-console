// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Surgical reading of long text for the MCP tools: a window of lines by
 * offset and limit, lines matching a regular expression with context around
 * them, and a time window over lines that start with a timestamp. A model
 * reads the part of a log, a file or a diff it needs instead of the whole
 * thing, and every answer says where it stopped so the next call continues.
 *
 * Lines come back numbered as `<n>\t<text>`. With context around matches, a
 * matching line is `<n>:\t<text>`, a context line `<n>-\t<text>`, and groups
 * that do not touch are parted by a `--` line, as grep prints them. The
 * notes it returns are model-facing protocol text, like the tool catalog.
 */

/** What part of a text to read. */
export interface TextWindowOptions {
	/** First line to read or search from, 1-based; negative counts from the end */
	offset?: number;
	/** Most lines returned; with a pattern, most matching lines */
	limit?: number;
	/** A JavaScript regular expression; only matching lines (and their context) come back */
	pattern?: string;
	/** Match upper and lower case exactly (default: ignore case) */
	matchCase?: boolean;
	/** Return the lines that do not match instead */
	invert?: boolean;
	/** Lines shown before and after each match */
	context?: number;
	/** Only lines stamped at or after this epoch ms (needs `stamped`) */
	since?: number;
	/** Only lines stamped before this epoch ms (needs `stamped`) */
	until?: number;
	/**
	 * Lines start with an ISO 8601 timestamp; a line without one (a stack
	 * trace's continuation) takes the time of the line before it
	 */
	stamped?: boolean;
	/** Longest line kept, in characters; longer ones are cut */
	maxLineChars?: number;
	/** What the text is, for the first note ("app.ts", "release r12") */
	label?: string;
	/** Default `limit` when none is given */
	defaultLimit?: number;
}

/** A window of a text, rendered for the model. */
export interface TextWindow {
	/** The notes line, then the lines */
	text: string;
	/** Lines in the whole text */
	total: number;
	/** Lines returned, context included */
	returned: number;
	/** Matching lines in the searched range, when a pattern was given */
	matches?: number;
	/** The offset that continues where this window stopped; absent at the end */
	next?: number;
}

/** Lines one window returns when the tool names no default. */
export const TEXT_WINDOW_DEFAULT_LIMIT = 400;

/** Most lines one window returns. */
export const TEXT_WINDOW_MAX_LIMIT = 5000;

/** Longest line kept unless a tool says otherwise. */
export const TEXT_WINDOW_LINE_CHARS = 2000;

/** Most context lines around one match. */
export const TEXT_WINDOW_MAX_CONTEXT = 50;

/** An ISO 8601 timestamp at the very start of a line, as server logs and docker write them. */
const LEADING_STAMP = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?/;

/** A relative time back from now: "90s", "15m", "2h", "3d", "1w". */
const RELATIVE = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i;

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * A point in time from what a model writes: an ISO 8601 date or timestamp,
 * epoch milliseconds or seconds, or a span back from now ("15m", "2h", "3d").
 * Null when it is none of them.
 */
export function parseInstant(value: string | number | undefined | null, now = Date.now()): number | null {
	if (value === undefined || value === null || value === "") {
		return null;
	}

	if (typeof value === "number") {
		return Number.isFinite(value)
			? (value < 1e11 ? value * 1000 : value)
			: null;
	}

	const text = value.trim();
	const relative = RELATIVE.exec(text);

	if (relative) {
		return now - Number(relative[1]) * UNIT_MS[relative[2]!.toLowerCase()]!;
	}

	if (/^\d{9,14}$/.test(text)) {
		const number = Number(text);

		return number < 1e11
			? number * 1000
			: number;
	}

	const parsed = Date.parse(text);

	return Number.isFinite(parsed)
		? parsed
		: null;
}

/** The epoch ms a line's leading timestamp names, or null when it has none. */
export function lineStamp(line: string): number | null {
	const match = LEADING_STAMP.exec(line);

	if (!match) {
		return null;
	}

	const parsed = Date.parse(match[1]!.replace(" ", "T"));

	return Number.isFinite(parsed)
		? parsed
		: null;
}

/**
 * Compile a model's pattern. A bad one throws with the reason, worded for the
 * model, so a tool can hand it back as is.
 */
export function compilePattern(pattern: string, matchCase = false): RegExp {
	try {
		return new RegExp(pattern, matchCase
			? ""
			: "i");
	} catch (error) {
		throw new Error(`pattern is not a valid regular expression: ${(error as Error).message}`);
	}
}

/** Split a text into lines; a final newline ends the last line rather than starting an empty one. */
export function splitLines(text: string): string[] {
	const lines = text.split(/\r?\n/);

	if (lines.length > 1 && lines[lines.length - 1] === "") {
		lines.pop();
	}

	return lines;
}

function clip(line: string, max: number): { text: string; cut: boolean } {
	return line.length > max
		? { text: `${line.slice(0, max)}…`, cut: true }
		: { text: line, cut: false };
}

/** The 0-based index the window starts at, from a 1-based or negative offset. */
function startIndex(offset: number | undefined, total: number): number {
	if (offset === undefined || offset === 0) {
		return 0;
	}

	return offset < 0
		? Math.max(0, total + offset)
		: Math.min(total, offset - 1);
}

/** Which lines fall inside the time window, by index; null when no window is asked for. */
function inTime(lines: string[], options: TextWindowOptions): boolean[] | null {
	if (!options.stamped || (options.since === undefined && options.until === undefined)) {
		return null;
	}

	const out: boolean[] = [];
	let last: number | null = null;

	for (const line of lines) {
		last = lineStamp(line) ?? last;

		out.push(last === null
			? options.since === undefined
			: (options.since === undefined || last >= options.since) && (options.until === undefined || last < options.until));
	}

	return out;
}

/**
 * Read a window of `text`. Without a pattern, `limit` lines from `offset`.
 * With one, the first `limit` matching lines at or after `offset`, each with
 * `context` lines around it, and a count of every match in the searched range
 * so the model knows how many it has not seen.
 */
export function textWindow(text: string | string[], options: TextWindowOptions = {}): TextWindow {
	const lines = Array.isArray(text)
		? text
		: splitLines(text);
	const total = lines.length;
	const limit = Math.max(1, Math.min(options.limit ?? options.defaultLimit ?? TEXT_WINDOW_DEFAULT_LIMIT, TEXT_WINDOW_MAX_LIMIT));
	const maxChars = options.maxLineChars ?? TEXT_WINDOW_LINE_CHARS;
	const start = startIndex(options.offset, total);
	const timed = inTime(lines, options);
	const label = options.label
		? `${options.label}: `
		: "";
	let cut = 0;

	const render = (index: number, mark: string): string => {
		const shown = clip(lines[index]!, maxChars);

		if (shown.cut) {
			cut++;
		}

		return `${index + 1}${mark}\t${shown.text}`;
	};

	const tail = (notes: string[]): void => {
		if (cut > 0) {
			notes.push(`${cut} long line(s) cut at ${maxChars} characters`);
		}

		if (timed) {
			notes.push("time window applied to the lines' leading timestamps");
		}
	};

	if (options.pattern === undefined || options.pattern === "") {
		const picked: number[] = [];
		let index = start;

		while (index < total && picked.length < limit) {
			if (!timed || timed[index]) {
				picked.push(index);
			}

			index++;
		}

		// without a time window the lines are consecutive; with one they may skip
		const more = timed
			? timed.slice(index).some(Boolean)
			: index < total;
		const out = picked.map((at) => render(at, ""));
		const notes = [picked.length > 0
			? `${label}lines ${picked[0]! + 1}-${picked[picked.length - 1]! + 1} of ${total}`
			: `${label}no lines${timed ? " in the time window" : ""} at or after line ${start + 1} of ${total}`];

		if (timed) {
			notes.push(`${picked.length} line(s) returned`);
		}

		if (more) {
			notes.push(`more follows; continue with offset ${index + 1}`);
		}

		tail(notes);

		return {
			text: [notes.join("; "), ...out].join("\n"),
			total,
			returned: picked.length,
			next: more
				? index + 1
				: undefined
		};
	}

	const regex = compilePattern(options.pattern, options.matchCase === true);
	const context = Math.max(0, Math.min(options.context ?? 0, TEXT_WINDOW_MAX_CONTEXT));
	const hits: number[] = [];
	let matches = 0;
	let stopAt: number | null = null;

	for (let index = start; index < total; index++) {
		if (timed && !timed[index]) {
			continue;
		}

		if (regex.test(lines[index]!) === (options.invert === true)) {
			continue;
		}

		matches++;

		if (hits.length < limit) {
			hits.push(index);
		} else if (stopAt === null) {
			stopAt = index;
		}
	}

	const out: string[] = [];
	const isHit = new Set(hits);
	let shownTo = -1;
	let returned = 0;

	for (const hit of hits) {
		const from = Math.max(start, hit - context, shownTo + 1);
		const to = Math.min(total - 1, hit + context);

		if (context > 0 && out.length > 0 && from > shownTo + 1) {
			out.push("--");
		}

		for (let index = from; index <= to; index++) {
			out.push(render(index, context > 0
				? (isHit.has(index) ? ":" : "-")
				: ""));
			returned++;
		}

		shownTo = Math.max(shownTo, to);
	}

	const range = `lines ${start + 1}-${total}`;
	const notes = [matches === 0
		? `${label}no line matches /${options.pattern}/ in ${range} of ${total}`
		: `${label}${hits.length} of ${matches} matching line(s) in ${range} of ${total}`];

	if (stopAt !== null) {
		notes.push(`more matches follow; continue with offset ${stopAt + 1}`);
	}

	tail(notes);

	return {
		text: [notes.join("; "), ...out].join("\n"),
		total,
		returned,
		matches,
		next: stopAt === null
			? undefined
			: stopAt + 1
	};
}

/** One kept line of a streamed query, as `core/configfiles.ts` returns it. */
export interface NumberedLine {
	line: number;
	text: string;
	/** False on a context line */
	match: boolean;
}

/**
 * Render lines a streamed query kept in the same shape `textWindow` uses:
 * `<n>\t<text>`, or `<n>:` and `<n>-` when there was context, with `--`
 * between groups that do not touch. `pad` right-aligns the numbers.
 */
export function renderLines(lines: NumberedLine[], marked: boolean, pad = 0): string {
	const out: string[] = [];
	let previous: number | null = null;

	for (const entry of lines) {
		if (marked && previous !== null && entry.line > previous + 1) {
			out.push("--");
		}

		const mark = marked
			? (entry.match ? ":" : "-")
			: "";

		out.push(`${String(entry.line).padStart(pad)}${mark}\t${entry.text}`);
		previous = entry.line;
	}

	return out.join("\n");
}
