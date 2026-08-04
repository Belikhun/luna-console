/**
 * A MiniMessage renderer, enough of one to show an admin what a string will
 * look like in game.
 *
 * This is a preview, not a reimplementation: the editor only ever edits the
 * source string, so anything this does not understand still round-trips
 * untouched. Two rules it does follow exactly, because getting them wrong makes
 * the preview lie:
 *
 *  - placeholders are substituted **before** parsing, the way the plugin does
 *    it, so a `%server_display%` whose value is itself a gradient renders as one;
 *  - item names and lore are deserialized with a leading `<!italic>`, so the
 *    default here is upright text rather than Minecraft's italic lore.
 *
 * Input is never trusted to be well-formed. A tag that does not lex is text.
 */

export interface MmSpan {
	text: string;
	/** Resolved `#rrggbb`, absent means "inherit the context's colour" */
	color?: string;
	bold?: boolean;
	italic?: boolean;
	underlined?: boolean;
	strikethrough?: boolean;
	obfuscated?: boolean;
	/** Set on a `%name%` run when rendering in highlight mode */
	placeholder?: string;
	/** A placeholder the plugin would not resolve */
	unknownPlaceholder?: boolean;
}

export type MmLine = MmSpan[];

/** The sixteen legacy chat colours, by their MiniMessage names. */
export const NAMED_COLORS: Record<string, string> = {
	black: "#000000",
	dark_blue: "#0000aa",
	dark_green: "#00aa00",
	dark_aqua: "#00aaaa",
	dark_red: "#aa0000",
	dark_purple: "#aa00aa",
	gold: "#ffaa00",
	gray: "#aaaaaa",
	grey: "#aaaaaa",
	dark_gray: "#555555",
	dark_grey: "#555555",
	blue: "#5555ff",
	green: "#55ff55",
	aqua: "#55ffff",
	red: "#ff5555",
	light_purple: "#ff55ff",
	yellow: "#ffff55",
	white: "#ffffff",
};

const DECORATIONS: Record<string, keyof MmSpan> = {
	b: "bold",
	bold: "bold",
	i: "italic",
	em: "italic",
	italic: "italic",
	u: "underlined",
	underlined: "underlined",
	st: "strikethrough",
	strikethrough: "strikethrough",
	obf: "obfuscated",
	obfuscated: "obfuscated",
};

/** Tags that style nothing here but whose contents must still render. */
const TRANSPARENT_TAGS = new Set([
	"hover",
	"click",
	"insert",
	"insertion",
	"font",
	"key",
	"lang",
	"tr",
	"translate",
	"selector",
	"score",
	"nbt",
	"shadow",
]);

interface TextNode {
	type: "text";
	text: string;
}

interface TagNode {
	type: "tag";
	name: string;
	args: string[];
	children: MmNode[];
}

type MmNode = TextNode | TagNode;

interface Style {
	color?: string;
	bold?: boolean;
	italic?: boolean;
	underlined?: boolean;
	strikethrough?: boolean;
	obfuscated?: boolean;
}

// the leading `!` is the negation form, `<!italic>`; `#` is the `<#rrggbb>` shorthand
const TAG_PATTERN = /^<(\/?)([!a-zA-Z_#][a-zA-Z0-9_#-]*)((?::(?:'[^']*'|"[^"]*"|[^<>])*)?)>/;

function splitArgs(raw: string): string[] {
	if (!raw) {
		return [];
	}

	const args: string[] = [];
	let current = "";
	let quote: string | null = null;

	// skip the leading ':'
	for (let index = 1; index < raw.length; index++) {
		const char = raw[index] as string;

		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}

			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;

			continue;
		}

		if (char === ":") {
			args.push(current);
			current = "";

			continue;
		}

		current += char;
	}

	args.push(current);

	return args;
}

/** Build a tolerant tree; anything that is not a valid tag stays text. */
function parseNodes(source: string): MmNode[] {
	const rootChildren: MmNode[] = [];
	const stack: TagNode[] = [];
	let buffer = "";

	const target = (): MmNode[] => (stack.length > 0 ? (stack[stack.length - 1] as TagNode).children : rootChildren);

	const flush = (): void => {
		if (buffer) {
			target().push({ type: "text", text: buffer });
			buffer = "";
		}
	};

	let index = 0;

	while (index < source.length) {
		const char = source[index] as string;

		if (char !== "<") {
			buffer += char;
			index++;

			continue;
		}

		const match = TAG_PATTERN.exec(source.slice(index));

		if (!match) {
			buffer += char;
			index++;

			continue;
		}

		const [whole, slash, rawName, rawArgs] = match as unknown as [string, string, string, string];
		const closing = slash === "/";
		let name = rawName.toLowerCase();
		let args = splitArgs(rawArgs ?? "");
		let negated = false;

		if (name.startsWith("!")) {
			negated = true;
			name = name.slice(1);
		}

		// `<#rrggbb>` is shorthand for `<color:#rrggbb>`
		if (name.startsWith("#")) {
			args = [name];
			name = "color";
		}

		flush();

		if (closing) {
			// pop to the innermost matching tag; an unmatched close is just noise
			for (let depth = stack.length - 1; depth >= 0; depth--) {
				if ((stack[depth] as TagNode).name === name) {
					stack.length = depth;

					break;
				}
			}

			index += whole.length;

			continue;
		}

		if (negated) {
			// `<!italic>` turns a decoration off for the rest of the scope
			const node: TagNode = { type: "tag", name: `!${name}`, args, children: [] };
			target().push(node);
			stack.push(node);
			index += whole.length;

			continue;
		}

		const node: TagNode = { type: "tag", name, args, children: [] };
		target().push(node);

		// `reset`, `br` and `newline` carry no content
		if (name !== "reset" && name !== "br" && name !== "newline") {
			stack.push(node);
		}

		index += whole.length;
	}

	flush();

	return rootChildren;
}

function normalizeHex(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	const text = value.trim().toLowerCase();
	const named = NAMED_COLORS[text];

	if (named) {
		return named;
	}

	const hex = text.startsWith("#") ? text.slice(1) : text;

	if (/^[0-9a-f]{6}$/.test(hex)) {
		return `#${hex}`;
	}

	if (/^[0-9a-f]{3}$/.test(hex)) {
		return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
	}

	return undefined;
}

function mixHex(from: string, to: string, ratio: number): string {
	const read = (hex: string, offset: number): number => parseInt(hex.slice(offset, offset + 2), 16);
	const clamp = Math.min(1, Math.max(0, ratio));
	const channel = (offset: number): string => {
		const value = Math.round(read(from, offset) + (read(to, offset) - read(from, offset)) * clamp);

		return value.toString(16).padStart(2, "0");
	};

	return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** Position `ratio` along a multi-stop gradient. */
function gradientColor(stops: string[], ratio: number): string {
	if (stops.length === 1) {
		return stops[0] as string;
	}

	const scaled = Math.min(1, Math.max(0, ratio)) * (stops.length - 1);
	const index = Math.min(stops.length - 2, Math.floor(scaled));

	return mixHex(stops[index] as string, stops[index + 1] as string, scaled - index);
}

function hsvToHex(hue: number): string {
	const sector = (hue % 1) * 6;
	const offset = sector - Math.floor(sector);
	const values = [1, 1 - offset, 0, 0, offset, 1];
	const pick = (shift: number): string =>
		Math.round(255 * (values[(Math.floor(sector) + shift) % 6] as number))
			.toString(16)
			.padStart(2, "0");

	return `#${pick(0)}${pick(4)}${pick(2)}`;
}

/** Count the characters a subtree will actually draw. */
function visibleLength(nodes: MmNode[]): number {
	let total = 0;

	for (const node of nodes) {
		if (node.type === "text") {
			total += [...node.text].length;

			continue;
		}

		if (node.name === "br" || node.name === "newline") {
			total += 1;

			continue;
		}

		total += visibleLength(node.children);
	}

	return total;
}

interface Char {
	char: string;
	style: Style;
}

function renderNodes(nodes: MmNode[], style: Style, base: Style, out: Char[]): void {
	for (const node of nodes) {
		if (node.type === "text") {
			for (const char of node.text) {
				out.push({ char, style: { ...style } });
			}

			continue;
		}

		const { name, args, children } = node;

		if (name === "br" || name === "newline") {
			out.push({ char: "\n", style: { ...style } });

			continue;
		}

		if (name === "reset") {
			// a reset drops back to the context the string started in
			style = { ...base };

			continue;
		}

		if (name === "color" || name === "colour" || name === "c") {
			const color = normalizeHex(args[0]);
			renderNodes(children, { ...style, color: color ?? style.color }, base, out);

			continue;
		}

		if (NAMED_COLORS[name]) {
			renderNodes(children, { ...style, color: NAMED_COLORS[name] }, base, out);

			continue;
		}

		const decoration = DECORATIONS[name];

		if (decoration) {
			renderNodes(children, { ...style, [decoration]: true }, base, out);

			continue;
		}

		if (name.startsWith("!")) {
			const off = DECORATIONS[name.slice(1)];

			renderNodes(children, off ? { ...style, [off]: false } : style, base, out);

			continue;
		}

		if (name === "gradient" || name === "rainbow") {
			const inner: Char[] = [];
			renderNodes(children, style, base, inner);

			const stops = args.map((arg) => normalizeHex(arg)).filter((color): color is string => !!color);
			// a trailing numeric argument is the phase, not a stop
			const phase = Number.parseFloat(args[args.length - 1] ?? "");
			const shift = Number.isFinite(phase) && stops.length < args.length ? phase : 0;
			// a gradient must land exactly on its last stop, so it spans the gaps
			// between characters; a rainbow must not wrap back to its first hue
			const total = name === "rainbow" ? Math.max(1, inner.length) : Math.max(1, inner.length - 1);

			inner.forEach((entry, index) => {
				const ratio = index / total;

				if (name === "rainbow") {
					entry.style.color = hsvToHex(ratio + shift);
				} else if (stops.length > 0) {
					entry.style.color = gradientColor(stops, ratio + shift);
				}
			});

			out.push(...inner);

			continue;
		}

		if (TRANSPARENT_TAGS.has(name)) {
			renderNodes(children, style, base, out);

			continue;
		}

		// an unknown tag is content the plugin would have styled somehow; showing
		// its children unstyled beats dropping the text
		renderNodes(children, style, base, out);
	}
}

const PLACEHOLDER_PATTERN = /%([a-zA-Z0-9_]+)%/g;

/** Every `%placeholder%` a string references, in order, without duplicates. */
export function extractPlaceholders(source: string): string[] {
	const out: string[] = [];

	for (const match of (source ?? "").matchAll(PLACEHOLDER_PATTERN)) {
		const name = match[1] as string;

		if (!out.includes(name)) {
			out.push(name);
		}
	}

	return out;
}

export interface RenderOptions {
	/** Substituted before parsing, exactly as the plugin does it */
	values?: Record<string, string>;
	/** Lore and item names are deserialized with `<!italic>`; default false */
	italicDefault?: boolean;
	/** Colour inherited by text that sets none */
	baseColor?: string;
	/** Mark `%name%` runs so the editor can highlight them */
	markPlaceholders?: boolean;
	/** Placeholders the plugin resolves; the rest are flagged when marking */
	knownPlaceholders?: readonly string[];
}

/** Group a character run into the fewest spans that keep its styling. */
function toSpans(chars: Char[], marks: Map<number, { name: string; unknown: boolean }>): MmLine[] {
	const lines: MmLine[] = [];
	let line: MmLine = [];
	let current: MmSpan | null = null;

	const sameStyle = (span: MmSpan, style: Style, mark: { name: string; unknown: boolean } | undefined): boolean =>
		span.color === style.color &&
		!!span.bold === !!style.bold &&
		!!span.italic === !!style.italic &&
		!!span.underlined === !!style.underlined &&
		!!span.strikethrough === !!style.strikethrough &&
		!!span.obfuscated === !!style.obfuscated &&
		span.placeholder === mark?.name;

	chars.forEach((entry, index) => {
		if (entry.char === "\n") {
			if (current) {
				line.push(current);
				current = null;
			}

			lines.push(line);
			line = [];

			return;
		}

		const mark = marks.get(index);

		if (current && sameStyle(current, entry.style, mark)) {
			current.text += entry.char;

			return;
		}

		if (current) {
			line.push(current);
		}

		current = { text: entry.char };

		if (entry.style.color) {
			current.color = entry.style.color;
		}

		for (const key of ["bold", "italic", "underlined", "strikethrough", "obfuscated"] as const) {
			if (entry.style[key]) {
				current[key] = true;
			}
		}

		if (mark) {
			current.placeholder = mark.name;

			if (mark.unknown) {
				current.unknownPlaceholder = true;
			}
		}
	});

	if (current) {
		line.push(current);
	}

	lines.push(line);

	return lines;
}

/**
 * Render a MiniMessage string into styled spans, one array per line.
 *
 * @param opts.values when given, placeholders are substituted first, so the
 *                    preview shows real numbers; when absent the tokens survive
 *                    and can be highlighted instead
 */
export function renderMiniMessage(source: string, opts: RenderOptions = {}): MmLine[] {
	let text = source ?? "";

	if (opts.values) {
		for (const [key, value] of Object.entries(opts.values)) {
			text = text.split(`%${key}%`).join(value ?? "");
		}
	}

	const base: Style = {
		italic: opts.italicDefault === true,
	};

	if (opts.baseColor) {
		base.color = opts.baseColor;
	}

	const chars: Char[] = [];
	renderNodes(parseNodes(text), { ...base }, base, chars);

	const marks = new Map<number, { name: string; unknown: boolean }>();

	if (opts.markPlaceholders) {
		// walk the rendered characters looking for the token text, so a placeholder
		// inside a styled run is still marked
		const rendered = chars.map((entry) => entry.char).join("");
		const known = opts.knownPlaceholders ?? [];

		for (const match of rendered.matchAll(PLACEHOLDER_PATTERN)) {
			const name = match[1] as string;
			const start = match.index ?? 0;

			for (let offset = 0; offset < match[0].length; offset++) {
				marks.set(start + offset, { name, unknown: known.length > 0 && !known.includes(name) });
			}
		}
	}

	return toSpans(chars, marks);
}

/** The plain text a string renders to, with tags and placeholders resolved. */
export function renderPlain(source: string, opts: RenderOptions = {}): string {
	return renderMiniMessage(source, opts)
		.map((line) => line.map((span) => span.text).join(""))
		.join("\n");
}
