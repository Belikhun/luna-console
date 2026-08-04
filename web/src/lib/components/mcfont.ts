/**
 * The game's own font, measured and drawn the way the client does it.
 *
 * Minecraft's font is a set of bitmap sheets, not an outline font: every glyph
 * is a cell of pixels, and how wide it is is not written down anywhere — the
 * client scans each cell for its rightmost lit column and takes that plus one.
 * So does this, off the decoded sheet, which is why the daemon ships the sheet
 * definitions and not a width table.
 *
 * The payoff is that text in the preview is set in the same glyphs, at the same
 * advances, as the text a player will read. A monospace stand-in gets the size
 * roughly right and every line break and every column wrong.
 */

import type { FontAtlas, FontBitmapProvider, FontUnihexOverride, FontUnihexProvider } from '$shared/mcassets';

import { loadTexture, unihexUrl } from './mcassets';

/** One drawable glyph, in game pixels. */
export interface Glyph {
	/** The decoded sheet it lives on */
	sheet: CanvasImageSource;
	/** Source rectangle within the sheet, in sheet pixels */
	sx: number;
	sy: number;
	sw: number;
	sh: number;
	/** Drawn size in game pixels */
	width: number;
	height: number;
	/** Game pixels above the baseline the glyph's top edge sits at */
	ascent: number;
	/** Game pixels the cursor moves after drawing it */
	advance: number;
	/** What bold costs this glyph — the sheets pay a pixel, unifont half of one */
	boldOffset: number;
}

export interface McFont {
	/** The glyph for a codepoint, or undefined when nothing covers it */
	glyph(codepoint: number): Glyph | undefined;
	/** Advance for a codepoint, bold included, falling back for unknown ones */
	advance(codepoint: number, bold?: boolean): number;
	/** Height of one line of text, in game pixels */
	readonly lineHeight: number;
	/** Of these codepoints, the ones nothing loaded draws and a fallback may */
	missing(codepoints: Iterable<number>): number[];
	/** Fetch them from the fallback bundle; true when at least one arrived */
	load(codepoints: number[]): Promise<boolean>;
}

/** What the client leaves for a codepoint it cannot draw. */
const UNKNOWN_ADVANCE = 6;
const LINE_HEIGHT = 9;

/** Decode a sheet into a canvas so its pixels can be read and drawn. */
async function decode(path: string): Promise<{ canvas: HTMLCanvasElement; data: ImageData } | null> {
	const image = await loadTexture(path);

	if (!image) {
		return null;
	}

	const canvas = document.createElement('canvas');
	canvas.width = image.width;
	canvas.height = image.height;

	const ctx = canvas.getContext('2d', { willReadFrequently: true });

	if (!ctx) {
		return null;
	}

	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(image, 0, 0);

	return { canvas, data: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

/**
 * The client's own measurement: walk the cell's columns from the right and stop
 * at the first that has any lit pixel. A cell with nothing in it is not a glyph
 * at all, so a later provider — or the fallback — gets to answer for it.
 */
function trimmedWidth(data: ImageData, x0: number, y0: number, cellW: number, cellH: number): number {
	for (let x = cellW - 1; x >= 0; x--) {
		for (let y = 0; y < cellH; y++) {
			const alpha = data.data[((y0 + y) * data.width + (x0 + x)) * 4 + 3] ?? 0;

			if (alpha !== 0) {
				return x + 1;
			}
		}
	}

	return 0;
}

async function addBitmap(
	provider: FontBitmapProvider,
	glyphs: Map<number, Glyph>
): Promise<void> {
	const sheet = await decode(provider.file);

	if (!sheet) {
		return;
	}

	const rows = provider.rows;
	// a row is characters, not code units — the sheets carry codepoints above the
	// basic plane, and splitting on length would cut those in half
	const grid = rows.map((row) => Array.from(row));
	const columns = Math.max(...grid.map((row) => row.length));

	if (columns === 0) {
		return;
	}

	const cellW = Math.floor(sheet.canvas.width / columns);
	const cellH = Math.floor(sheet.canvas.height / grid.length);
	const scale = provider.height / cellH;

	for (const [row, chars] of grid.entries()) {
		for (const [column, char] of chars.entries()) {
			const codepoint = char.codePointAt(0);

			// the sheets pad their rows with NUL where a cell is unused
			if (codepoint === undefined || codepoint === 0 || glyphs.has(codepoint)) {
				continue;
			}

			const sx = column * cellW;
			const sy = row * cellH;
			const width = trimmedWidth(sheet.data, sx, sy, cellW, cellH);

			if (width === 0) {
				continue;
			}

			glyphs.set(codepoint, {
				sheet: sheet.canvas,
				sx,
				sy,
				sw: width,
				sh: cellH,
				width: Math.round(width * scale),
				height: provider.height,
				ascent: provider.ascent,
				advance: Math.round(width * scale) + 1,
				boldOffset: 1
			});
		}
	}
}

/** Every unifont glyph is sixteen rows tall, whatever its width. */
const UNIHEX_ROWS = 16;

/** Which columns of a unifont glyph count as the glyph, per the font definition. */
function boundsFor(codepoint: number, overrides: FontUnihexOverride[] | undefined): FontUnihexOverride | undefined {
	return overrides?.find((entry) => codepoint >= entry.from && codepoint <= entry.to);
}

/**
 * Turn one hex row into a drawable glyph.
 *
 * The dump is four bits a character, sixteen rows: `00:` for a blank row of an
 * eight-wide glyph, twice that for a sixteen-wide one. It is drawn at half the
 * resolution it is stored at, which is what lands unifont's own baseline — its
 * fourteenth row — on the same line the `ascii` sheet sits on.
 */
function decodeUnihex(bits: string, codepoint: number, overrides: FontUnihexOverride[] | undefined): Glyph | undefined {
	const step = bits.length / UNIHEX_ROWS;
	const width = step * 4;

	if (!Number.isInteger(step) || width < 1) {
		return undefined;
	}

	const lit: boolean[][] = [];

	for (let row = 0; row < UNIHEX_ROWS; row++) {
		const cells: boolean[] = [];

		for (let index = 0; index < step; index++) {
			// a nibble at a time, because a 32-column glyph would overflow the
			// bitwise operators if the row were parsed as one number
			const nibble = Number.parseInt(bits[row * step + index] ?? '0', 16);

			for (let bit = 3; bit >= 0; bit--) {
				cells.push(((nibble >> bit) & 1) === 1);
			}
		}

		lit.push(cells);
	}

	const override = boundsFor(codepoint, overrides);
	let left = override?.left ?? width;
	let right = override?.right ?? -1;

	if (!override) {
		for (const row of lit) {
			for (const [column, on] of row.entries()) {
				if (!on) {
					continue;
				}

				left = Math.min(left, column);
				right = Math.max(right, column);
			}
		}
	}

	// a row of zeroes is not a glyph — the client lets the next provider, or the
	// missing-glyph box, answer for that codepoint instead
	if (right < left) {
		return undefined;
	}

	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = UNIHEX_ROWS;

	const ctx = canvas.getContext('2d');

	if (!ctx) {
		return undefined;
	}

	const image = ctx.createImageData(width, UNIHEX_ROWS);

	for (const [row, cells] of lit.entries()) {
		for (const [column, on] of cells.entries()) {
			if (!on) {
				continue;
			}

			const offset = (row * width + column) * 4;
			image.data[offset] = 255;
			image.data[offset + 1] = 255;
			image.data[offset + 2] = 255;
			image.data[offset + 3] = 255;
		}
	}

	ctx.putImageData(image, 0, 0);

	const drawn = (right - left + 1) / 2;

	return {
		sheet: canvas,
		sx: left,
		sy: 0,
		sw: right - left + 1,
		sh: UNIHEX_ROWS,
		width: drawn,
		height: UNIHEX_ROWS / 2,
		ascent: 7,
		advance: drawn + 1,
		boldOffset: 0.5
	};
}

let pending: Promise<McFont | null> | null = null;

/**
 * Build the font from an atlas, once per page load.
 *
 * @param atlas the sheet definitions, straight out of the item registry
 * @returns the font, or null when the assets carry no usable one
 */
export function loadFont(atlas: FontAtlas | undefined): Promise<McFont | null> {
	if (!atlas || atlas.providers.length === 0) {
		return Promise.resolve(null);
	}

	if (!pending) {
		pending = build(atlas).catch(() => null);
	}

	return pending;
}

async function build(atlas: FontAtlas): Promise<McFont | null> {
	const glyphs = new Map<number, Glyph>();
	const spaces = new Map<number, number>();
	const fallbacks: FontUnihexProvider[] = [];

	for (const provider of atlas.providers) {
		if (provider.kind === 'space') {
			for (const [char, advance] of Object.entries(provider.advances)) {
				const codepoint = char.codePointAt(0);

				if (codepoint !== undefined && !spaces.has(codepoint)) {
					spaces.set(codepoint, advance);
				}
			}

			continue;
		}

		if (provider.kind === 'unihex') {
			fallbacks.push(provider);

			continue;
		}

		await addBitmap(provider, glyphs);
	}

	if (glyphs.size === 0) {
		return null;
	}

	// asking twice for a codepoint the bundle does not have would be a request per
	// repaint, so a codepoint is looked up once whether or not it was found
	const attempted = new Set<number>();
	const inflight = new Map<number, Promise<void>>();

	const missing = (codepoints: Iterable<number>): number[] => {
		const out: number[] = [];

		if (fallbacks.length === 0) {
			return out;
		}

		for (const codepoint of codepoints) {
			if (attempted.has(codepoint) || glyphs.has(codepoint) || spaces.has(codepoint) || out.includes(codepoint)) {
				continue;
			}

			out.push(codepoint);
		}

		return out;
	};

	const fetchBatch = async (codepoints: number[]): Promise<void> => {
		for (const source of fallbacks) {
			const wanted = codepoints.filter((codepoint) => !glyphs.has(codepoint));

			if (wanted.length === 0) {
				return;
			}

			try {
				const response = await fetch(unihexUrl(source.file, wanted));

				if (!response.ok) {
					continue;
				}

				const rows = (await response.json()) as Record<string, string>;

				for (const [key, bits] of Object.entries(rows)) {
					const codepoint = Number(key);
					const glyph = decodeUnihex(bits, codepoint, source.sizeOverrides);

					if (glyph) {
						glyphs.set(codepoint, glyph);
					}
				}
			} catch {
				// a fallback that cannot be reached leaves the codepoint undrawn,
				// which is what it already was
			}
		}
	};

	return {
		lineHeight: LINE_HEIGHT,
		glyph: (codepoint) => glyphs.get(codepoint),
		advance: (codepoint, bold = false) => {
			const space = spaces.get(codepoint);
			const glyph = glyphs.get(codepoint);
			const base = space ?? glyph?.advance ?? UNKNOWN_ADVANCE;

			// the client draws a bold glyph twice, a pixel apart, and pays for it
			return base + (bold && space === undefined ? (glyph?.boldOffset ?? 1) : 0);
		},
		missing,
		load: async (codepoints) => {
			const fresh = missing(codepoints);
			const waits: Array<Promise<void>> = [];

			if (fresh.length > 0) {
				const batch = fetchBatch(fresh).finally(() => {
					for (const codepoint of fresh) {
						inflight.delete(codepoint);
					}
				});

				for (const codepoint of fresh) {
					attempted.add(codepoint);
					inflight.set(codepoint, batch);
				}

				waits.push(batch);
			}

			// a second block wanting the same character joins the request already in
			// flight rather than starting another — and, crucially, still learns when
			// it lands, which is what makes it repaint
			for (const codepoint of codepoints) {
				const existing = inflight.get(codepoint);

				if (existing && !waits.includes(existing)) {
					waits.push(existing);
				}
			}

			if (waits.length === 0) {
				return false;
			}

			await Promise.all(waits);

			return Array.from(codepoints).some((codepoint) => glyphs.has(codepoint));
		}
	};
}
