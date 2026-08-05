<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * A MiniMessage string, set in Minecraft's own font.
	 *
	 * The font is bitmap sheets rather than outlines, so this draws it the way the
	 * client draws it: glyph by glyph onto a canvas, at the advances measured off
	 * the sheets. A web font can only approximate that; every glyph would be the
	 * wrong width, so every line break and every column in the preview would be
	 * somewhere the player will not see it.
	 *
	 * The styling is the client's too: bold is the glyph stamped twice a pixel
	 * apart, italic is a one-pixel shear over the glyph's height, and the shadow
	 * is the whole run again, one pixel down and right, at a quarter of each
	 * glyph's own colour.
	 */

	import { onDestroy } from 'svelte';

	import { renderMiniMessage, type MmLine, type MmSpan } from '$shared/minimessage';

	import { loadRegistry } from './mcassets';
	import { loadFont, type McFont } from './mcfont';

	interface Props {
		source: string;
		/** Substituted before parsing, exactly as the plugin does it */
		values?: Record<string, string>;
		/** Item names and lore are deserialized with `<!italic>` */
		italicDefault?: boolean;
		/** Colour for text that sets none; lore grey, name white */
		baseColor?: string;
		/** Mark `%name%` runs instead of substituting them */
		markPlaceholders?: boolean;
		knownPlaceholders?: readonly string[];
		/** Render on one line, collapsing any line breaks */
		inline?: boolean;
		/** Draw the game's drop shadow; on for tooltips and chat, off for labels */
		shadow?: boolean;
		/** Wrap at this many game pixels; unset fits the text to its container */
		wrap?: number;
		/** Game pixels between line tops; the font's own is 9, a tooltip's is 10 */
		pitch?: number;
		/** One game pixel, as a CSS length */
		unit?: string;
	}

	const {
		source,
		values,
		italicDefault = false,
		baseColor,
		markPlaceholders = false,
		knownPlaceholders,
		inline = false,
		shadow = false,
		wrap,
		pitch = 9,
		unit = 'var(--gui-px, 0.125rem)'
	}: Props = $props();

	// The line box is nine pixels with the baseline seven down, which is where the
	// `ascii` sheet hangs. `accented` is twelve tall hung ten up, so it overshoots
	// both edges; the padding is what stops it being clipped, and is taken back
	// out with a negative margin so the box still occupies one line in the flow.
	const LINE = 9;
	const BASELINE = 7;
	const PAD_TOP = 4;
	const PAD_BOTTOM = 3;

	let font: McFont | null = $state(null);
	let canvas: HTMLCanvasElement | undefined = $state();
	let probe: HTMLSpanElement | undefined = $state();
	let observed = $state(0);
	let tick = $state(0);
	// bumped when a fallback glyph arrives, which changes what the layout measures
	let glyphs = $state(0);
	// how many game pixels fit across the container, measured; a caller that knows
	// better says so, and a shrink-to-fit parent has to, or the two would chase
	// each other
	let room = $state(0);
	let timer: ReturnType<typeof setInterval> | undefined;

	$effect(() => {
		void loadRegistry()
			.then((registry) => loadFont(registry?.font))
			.then((loaded) => (font = loaded));
	});

	const lines: MmLine[] = $derived(
		renderMiniMessage(source ?? '', { values, italicDefault, baseColor, markPlaceholders, knownPlaceholders })
	);

	interface Placed {
		codepoint: number;
		span: MmSpan;
		/** game pixels from the block's left edge */
		x: number;
		row: number;
		advance: number;
	}

	interface Layout {
		placed: Placed[];
		width: number;
		rows: number;
	}

	/**
	 * Lay the spans out into positioned glyphs, breaking at spaces.
	 *
	 * Words are held back until they are known to fit, which is what makes the
	 * break land between words rather than inside one.
	 */
	function layout(current: McFont): Layout {
		const placed: Placed[] = [];
		const limit = inline ? Number.POSITIVE_INFINITY : (wrap ?? (room > 0 ? room : Number.POSITIVE_INFINITY));
		let row = 0;
		let x = 0;
		let width = 0;
		let word: Array<{ codepoint: number; span: MmSpan; advance: number }> = [];
		let wordWidth = 0;

		const flush = (): void => {
			if (word.length === 0) {
				return;
			}

			if (x > 0 && x + wordWidth > limit) {
				row++;
				x = 0;
			}

			for (const entry of word) {
				placed.push({ ...entry, x, row });
				x += entry.advance;
			}

			width = Math.max(width, x);
			word = [];
			wordWidth = 0;
		};

		for (const [index, line] of lines.entries()) {
			if (index > 0 && !inline) {
				flush();
				row++;
				x = 0;
			}

			for (const span of line) {
				for (const char of Array.from(span.text)) {
					const codepoint = char.codePointAt(0) ?? 32;
					const advance = current.advance(codepoint, span.bold);

					// a newline inside a span is a break the parser leaves in place;
					// it is a line ending, not a glyph six pixels wide
					if (char === '\n') {
						if (inline) {
							continue;
						}

						flush();
						row++;
						x = 0;

						continue;
					}

					if (char === ' ') {
						flush();

						// a break that lands on a space eats it, rather than carrying
						// the gap to the start of the next line
						if (x > 0) {
							placed.push({ codepoint, span, x, row, advance });
							x += advance;
							width = Math.max(width, x);
						}

						continue;
					}

					// a word longer than the whole line has to break somewhere
					if (wordWidth + advance > limit && wordWidth > 0) {
						flush();
						row++;
						x = 0;
					}

					word.push({ codepoint, span, advance });
					wordWidth += advance;
				}
			}
		}

		flush();

		return { placed, width: Math.ceil(width), rows: row + 1 };
	}

	/**
	 * A codepoint no sheet covers; a box character ruling a description line, a
	 * name in a script the sheets skip; is drawn from the fallback bundle, which
	 * is far too large to load up front and is asked for a codepoint at a time.
	 * The tick is what lays the block out again once the glyphs land.
	 */
	$effect(() => {
		const current = font;

		if (!current) {
			return;
		}

		const codepoints = new Set<number>();

		for (const line of lines) {
			for (const span of line) {
				for (const char of Array.from(span.text)) {
					const codepoint = char.codePointAt(0);

					if (codepoint !== undefined) {
						codepoints.add(codepoint);
					}
				}
			}
		}

		void current.load(Array.from(codepoints)).then((arrived) => {
			if (arrived) {
				glyphs += 1;
			}
		});
	});

	const shape: Layout = $derived.by(() => {
		void glyphs;

		return font ? layout(font) : { placed: [], width: 0, rows: 1 };
	});
	const blockH = $derived(shape.rows * pitch);
	const hasObfuscated = $derived(shape.placed.some((glyph) => glyph.span.obfuscated));

	$effect(() => {
		if (!hasObfuscated) {
			clearInterval(timer);
			timer = undefined;

			return;
		}

		timer = setInterval(() => (tick += 1), 80);

		return () => clearInterval(timer);
	});

	onDestroy(() => clearInterval(timer));

	/** Glyphs grouped by advance, so a scrambled one keeps its width. */
	let scramblePool: Map<number, number[]> | null = null;

	function scrambleFor(current: McFont, codepoint: number, seed: number): number {
		if (!scramblePool) {
			scramblePool = new Map();

			// the printable ASCII range is what the client scrambles within, and it
			// covers every advance the effect needs
			for (let candidate = 0x21; candidate <= 0x7e; candidate++) {
				const advance = current.advance(candidate);
				const bucket = scramblePool.get(advance) ?? [];
				bucket.push(candidate);
				scramblePool.set(advance, bucket);
			}
		}

		const bucket = scramblePool.get(current.advance(codepoint));

		if (!bucket || bucket.length === 0) {
			return codepoint;
		}

		return bucket[(seed * 31 + codepoint * 17) % bucket.length] ?? codepoint;
	}

	function darken(color: string): string {
		const clean = color.replace('#', '');
		const full = clean.length === 3 ? clean.split('').map((part) => part + part).join('') : clean;
		const value = Number.parseInt(full.slice(0, 6), 16);

		if (!Number.isFinite(value)) {
			return 'rgb(63,63,63)';
		}

		const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];

		return `rgb(${channels.map((channel) => Math.round(channel * 0.25)).join(',')})`;
	}

	// one scratch tile, reused: a glyph is stamped white then filled through its
	// own alpha, which is the cheapest way to colour a sheet that has no colour
	let scratch: HTMLCanvasElement | undefined;

	function stamp(
		ctx: CanvasRenderingContext2D,
		glyph: NonNullable<ReturnType<McFont['glyph']>>,
		color: string,
		dx: number,
		dy: number,
		unitPx: number,
		italic: boolean
	): void {
		scratch ??= document.createElement('canvas');

		const width = Math.max(1, Math.round(glyph.width * unitPx));
		const height = Math.max(1, Math.round(glyph.height * unitPx));

		if (scratch.width < width || scratch.height < height) {
			scratch.width = Math.max(scratch.width, width);
			scratch.height = Math.max(scratch.height, height);
		}

		const tile = scratch.getContext('2d');

		if (!tile) {
			return;
		}

		tile.setTransform(1, 0, 0, 1, 0, 0);
		tile.globalCompositeOperation = 'source-over';
		tile.clearRect(0, 0, scratch.width, scratch.height);
		tile.imageSmoothingEnabled = false;
		tile.drawImage(glyph.sheet, glyph.sx, glyph.sy, glyph.sw, glyph.sh, 0, 0, width, height);
		tile.globalCompositeOperation = 'source-in';
		tile.fillStyle = color;
		tile.fillRect(0, 0, width, height);

		ctx.save();

		if (italic) {
			// a one-pixel lean over the glyph's height, measured from the baseline
			ctx.translate(dx, dy + height);
			ctx.transform(1, 0, -1 / glyph.height, 1, 0, 0);
			ctx.drawImage(scratch, 0, 0, width, height, 0, -height, width, height);
		} else {
			ctx.drawImage(scratch, 0, 0, width, height, dx, dy, width, height);
		}

		ctx.restore();
	}

	function paint(target: HTMLCanvasElement, current: McFont, unitPx: number, seed: number): void {
		const ctx = target.getContext('2d');

		if (!ctx) {
			return;
		}

		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, target.width, target.height);
		ctx.imageSmoothingEnabled = false;

		// the shadow is the whole run again, a pixel down and right; drawing it
		// first is what puts it behind rather than over
		const passes: Array<{ dx: number; dy: number; shade: boolean }> = shadow
			? [
					{ dx: 1, dy: 1, shade: true },
					{ dx: 0, dy: 0, shade: false }
				]
			: [{ dx: 0, dy: 0, shade: false }];

		for (const pass of passes) {
			for (const item of shape.placed) {
				const color = item.span.color ?? baseColor ?? '#ffffff';
				const paintColor = pass.shade ? darken(color) : color;
				const codepoint = item.span.obfuscated ? scrambleFor(current, item.codepoint, seed) : item.codepoint;
				const glyph = current.glyph(codepoint);
				const baseline = PAD_TOP + item.row * pitch + BASELINE;

				if (item.span.placeholder && !pass.shade) {
					ctx.fillStyle = item.span.unknownPlaceholder ? 'rgba(255,122,122,0.22)' : 'rgba(255,153,0,0.22)';
					ctx.fillRect(
						Math.round(item.x * unitPx),
						Math.round((baseline - BASELINE) * unitPx),
						Math.round(item.advance * unitPx),
						Math.round(LINE * unitPx)
					);
				}

				if (glyph) {
					const dx = Math.round((item.x + pass.dx) * unitPx);
					const dy = Math.round((baseline - glyph.ascent + pass.dy) * unitPx);

					stamp(ctx, glyph, paintColor, dx, dy, unitPx, item.span.italic === true);

					if (item.span.bold) {
						stamp(ctx, glyph, paintColor, dx + Math.round(unitPx), dy, unitPx, item.span.italic === true);
					}
				}

				ctx.fillStyle = paintColor;

				if (item.span.strikethrough) {
					ctx.fillRect(
						Math.round((item.x + pass.dx) * unitPx),
						Math.round((baseline - 3 + pass.dy) * unitPx),
						Math.round(item.advance * unitPx),
						Math.max(1, Math.round(unitPx))
					);
				}

				if (item.span.underlined) {
					ctx.fillRect(
						Math.round((item.x + pass.dx) * unitPx),
						Math.round((baseline + 2 + pass.dy) * unitPx),
						Math.round(item.advance * unitPx),
						Math.max(1, Math.round(unitPx))
					);
				}
			}
		}
	}

	// the element's size comes from CSS and changes with the chest; the backing
	// store has to follow it or the text is drawn at one size and shown at another
	$effect(() => {
		const target = canvas;
		const host = target?.parentElement;

		if (!target || !host || typeof ResizeObserver === 'undefined') {
			return;
		}

		const observer = new ResizeObserver(() => (observed += 1));
		observer.observe(target);
		observer.observe(host);

		return () => observer.disconnect();
	});

	// the probe is one game pixel wide in CSS, which is the only way to find out
	// what `--gui-px` actually resolved to; a custom property reads back as the
	// expression it was written as, not as a length
	$effect(() => {
		void observed;

		const marker = probe;
		const host = canvas?.parentElement;

		if (!marker || !host || wrap !== undefined || inline) {
			return;
		}

		const unitPx = marker.getBoundingClientRect().width;
		const next = unitPx > 0 ? Math.floor(host.clientWidth / unitPx) : 0;

		if (next > 0 && next !== room) {
			room = next;
		}
	});

	$effect(() => {
		const target = canvas;
		const current = font;
		const seed = tick;
		void shape;
		void observed;

		if (!target || !current) {
			return;
		}

		// One backing pixel per device pixel. Anything else; an integer scale that
		// the browser then resamples to fit; is what makes bitmap glyphs come out
		// soft, and at a GUI scale of 3.64 no integer fits.
		const box = target.getBoundingClientRect();

		if (box.width < 1) {
			return;
		}

		const ratio = window.devicePixelRatio || 1;
		const width = Math.max(1, Math.round(box.width * ratio));
		const height = Math.max(1, Math.round(box.height * ratio));

		if (target.width !== width || target.height !== height) {
			target.width = width;
			target.height = height;
		}

		paint(target, current, width / (shape.width + 1), seed);
	});
</script>

<span class="probe" bind:this={probe} style:--unit={unit}></span>

{#if font && shape.width > 0}
	<canvas
		bind:this={canvas}
		class="mctext"
		style:--unit={unit}
		style:--w={shape.width + 1}
		style:--h={blockH + PAD_TOP + PAD_BOTTOM}
		style:--pad-top={PAD_TOP}
		style:--pad-bottom={PAD_BOTTOM}
	></canvas>
{:else}
	<!-- assets not extracted yet: the text still has to be readable -->
	<span class="plain">{lines.map((line) => line.map((span) => span.text).join('')).join(' ')}</span>
{/if}

<style lang="scss">
	.mctext {
		display: block;
		width: calc(var(--unit) * var(--w));
		height: calc(var(--unit) * var(--h));
		// the padding exists so tall glyphs are not clipped; taking it back out
		// here keeps the box exactly as many lines tall as it has lines
		margin-top: calc(var(--unit) * var(--pad-top) * -1);
		margin-bottom: calc(var(--unit) * var(--pad-bottom) * -1);
		image-rendering: pixelated;
	}

	.probe {
		display: block;
		width: var(--unit);
		height: 0;
	}

	.plain {
		font-family: var(--font-mono);
		white-space: pre-wrap;
	}
</style>
