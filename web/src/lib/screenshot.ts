// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What Mèo Béo's `console_screenshot` sees: the console as the operator has it
 * on screen right now (top bar, side nav, the page and whatever it scrolled
 * to), drawn from the live DOM in this browser, without the chat panel itself.
 *
 * The panel is filtered out of the render and then cropped off, because the
 * render keeps every element at the width it has on screen: dropping the panel
 * alone would leave an empty strip where it was.
 *
 * The render runs on the page's own thread, so it is kept small:
 *
 * - Only what can show is cloned. A subtree that is not displayed, hidden,
 *   transparent or clipped out of view (a hidden tab, rows scrolled away) is left out before the
 *   library walks it.
 * - Custom properties are never copied. Monaco puts about 1,550 `--vscode-*`
 *   colours on `:root` once an editor has opened, every element inherits
 *   them, and the library wrote all of them into each clone's inline style:
 *   75 kB per element and the page frozen for seconds while the SVG decoded
 *   (measured in harbor's codespace, whose copy of this module this is). The
 *   computed values the clone carries already have every `var()` resolved.
 * - Fonts are embedded by hand: only the faces the visible text and icons
 *   use, each fetched and encoded once per page load. The library's own pass
 *   missed icon fonts set on `::after` (Font Awesome) and re-encoded every
 *   face of a family on every capture.

 */

import { domToCanvas } from 'modern-screenshot';

/** The longest edge sent to the model; larger images are scaled down by the API anyway. */
const MAX_EDGE_PX = 1568;

const JPEG_QUALITY = 0.85;

export interface ConsoleShot {
	image: Blob;
	/** The page path, as the operator's address bar has it */
	page: string;
	/** The captured area in CSS pixels */
	width: number;
	height: number;
	/** Milliseconds from start to encoded image */
	ms: number;
}

interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** What the walk found: nodes to leave out and the font faces in use. */
interface RenderPlan {
	skip: Set<Node>;
	/** `family|weight|style`, family lowercased and unquoted */
	faces: Set<string>;
}

interface FontFace {
	family: string;
	weight: [number, number];
	style: string;
	url: string;
	format: string | null;
}

/** Each face's `@font-face` text with its file inlined, by file address: fetched once per page load. */
const embedded = new Map<string, Promise<string | null>>();

/** Every CSS property name that is not a custom property; read once. */
let styleProperties: string[] | null = null;

function intersects(a: Box, b: Box): boolean {
	return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function intersection(a: Box, b: Box): Box {
	return {
		left: Math.max(a.left, b.left),
		top: Math.max(a.top, b.top),
		right: Math.min(a.right, b.right),
		bottom: Math.min(a.bottom, b.bottom)
	};
}

function familiesOf(stack: string): string[] {
	return stack
		.split(',')
		.map((family) => family.trim().replace(/^["']|["']$/g, '').toLowerCase())
		.filter(Boolean);
}

function noteFont(plan: RenderPlan, style: CSSStyleDeclaration): void {
	const weight = Number.parseInt(style.fontWeight, 10) || 400;
	const italic = style.fontStyle === 'normal'
		? 'normal'
		: 'italic';

	for (const family of familiesOf(style.fontFamily)) {
		plan.faces.add(`${family}|${weight}|${italic}`);
	}
}

function hasText(element: Element): boolean {
	for (const node of element.childNodes) {
		if (node.nodeType === Node.TEXT_NODE && /\S/.test(node.nodeValue ?? '')) {
			return true;
		}
	}

	return false;
}

/** Whether a pseudo-element draws content (an icon glyph, a bullet). */
function pseudoShows(element: Element, which: '::before' | '::after'): CSSStyleDeclaration | null {
	const style = getComputedStyle(element, which);
	const content = style.content;

	return content && content !== 'none' && content !== 'normal'
		? style
		: null;
}

/**
 * Walk the visible tree once, deciding what the render leaves out. A subtree
 * goes when it cannot paint inside the area: not displayed, hidden (no
 * element in the console turns a descendant of a hidden one visible again),
 * fully transparent, or outside the box its clipping ancestors leave. An
 * element out of view that does not clip is still walked, since a positioned
 * child can land inside.
 */
function planRender(root: HTMLElement, area: Box): RenderPlan {
	const plan: RenderPlan = { skip: new Set(), faces: new Set() };

	const visit = (element: Element, clip: Box): void => {
		if (element instanceof HTMLElement && element.tagName === 'ASIDE' && element.classList.contains('agent')) {
			plan.skip.add(element);

			return;
		}

		const style = getComputedStyle(element);

		if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0' || style.contentVisibility === 'hidden') {
			plan.skip.add(element);

			return;
		}

		const own = style.position === 'fixed'
			? area
			: clip;

		// display: contents has no box of its own; its children are judged instead
		if (style.display === 'contents') {
			for (const child of element.children) {
				visit(child, own);
			}

			return;
		}

		const rect = element.getBoundingClientRect();
		const box: Box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
		const sized = rect.width > 0 && rect.height > 0;
		const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible';
		const outside = sized && !intersects(box, own);

		if (outside && (clips || element.childElementCount === 0)) {
			plan.skip.add(element);

			return;
		}

		if (hasText(element) || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
			noteFont(plan, style);
		}

		for (const which of ['::before', '::after'] as const) {
			const pseudo = pseudoShows(element, which);

			if (pseudo) {
				noteFont(plan, pseudo);
			}
		}

		// an SVG's insides are drawn as they are; nothing in there is worth pruning
		if (element instanceof SVGElement) {
			return;
		}

		const inner = clips && sized
			? intersection(own, box)
			: own;

		for (const child of element.children) {
			visit(child, inner);
		}
	};

	visit(root, area);

	return plan;
}

function parseWeight(value: string): [number, number] {
	const words: Record<string, number> = { normal: 400, bold: 700 };
	const parts = value
		.trim()
		.split(/\s+/)
		.map((part) => words[part] ?? (Number.parseInt(part, 10) || 400));
	const low = parts[0] ?? 400;

	return [low, parts[1] ?? low];
}

/** Every `@font-face` the page's own stylesheets declare, with absolute file addresses. */
function fontFaces(): FontFace[] {
	const faces: FontFace[] = [];

	const collect = (rules: CSSRuleList, base: string): void => {
		for (const rule of rules) {
			if (rule instanceof CSSFontFaceRule) {
				const source = /url\((["']?)([^"')]+)\1\)\s*(?:format\((["']?)([^"')]+)\3\))?/.exec(rule.style.getPropertyValue('src'));

				if (!source) {
					continue;
				}

				faces.push({
					family: familiesOf(rule.style.getPropertyValue('font-family'))[0] ?? '',
					weight: parseWeight(rule.style.getPropertyValue('font-weight') || '400'),
					style: (rule.style.getPropertyValue('font-style') || 'normal') === 'normal'
						? 'normal'
						: 'italic',
					url: new URL(source[2]!, base).href,
					format: source[4] ?? null
				});
			} else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule || rule instanceof CSSLayerBlockRule) {
				collect(rule.cssRules, base);
			}
		}
	};

	for (const sheet of document.styleSheets) {
		try {
			collect(sheet.cssRules, sheet.href ?? location.href);
		} catch {
			// a stylesheet from another origin cannot be read; the console loads none
		}
	}

	return faces;
}

/** The face a browser would pick for one weight and style of a family: same style first, then the nearest weight. */
function bestFace(faces: FontFace[], weight: number, style: string): FontFace | null {
	let best: FontFace | null = null;
	let bestScore = Infinity;

	for (const face of faces) {
		const distance = weight < face.weight[0]
			? face.weight[0] - weight
			: weight > face.weight[1]
				? weight - face.weight[1]
				: 0;
		const score = distance + (face.style === style ? 0 : 10_000);

		if (score < bestScore) {
			best = face;
			bestScore = score;
		}
	}

	return best;
}

async function readDataUrl(blob: Blob): Promise<string> {
	return await new Promise((resolve, reject) => {
		const reader = new FileReader();

		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error('read failed'));
		reader.readAsDataURL(blob);
	});
}

/** One face as an `@font-face` rule with its file inlined, cached for the page's life; null when the file did not load. */
function embedFace(face: FontFace): Promise<string | null> {
	const key = `${face.family}|${face.weight.join(' ')}|${face.style}|${face.url}`;
	let pending = embedded.get(key);

	if (!pending) {
		pending = (async () => {
			try {
				const response = face.url.startsWith('data:')
					? null
					: await fetch(face.url);

				if (response && !response.ok) {
					return null;
				}

				const data = response
					? await readDataUrl(await response.blob())
					: face.url;
				const format = face.format
					? ` format("${face.format}")`
					: '';

				return `@font-face { font-family: "${face.family}"; font-weight: ${face.weight.join(' ')}; font-style: ${face.style}; src: url(${data})${format}; }`;
			} catch {
				return null;
			}
		})();

		pending.then((text) => {
			// a failed file is tried again next time
			if (text === null) {
				embedded.delete(key);
			}
		});

		embedded.set(key, pending);
	}

	return pending;
}

/** The `@font-face` rules for the faces in use, files inlined; empty when none of the page's own fonts is used. */
async function fontCss(used: Set<string>): Promise<string> {
	const byFamily = new Map<string, FontFace[]>();

	for (const face of fontFaces()) {
		const list = byFamily.get(face.family) ?? [];

		list.push(face);
		byFamily.set(face.family, list);
	}

	const wanted = new Set<FontFace>();

	for (const entry of used) {
		const [family = '', weight = '400', style = 'normal'] = entry.split('|');
		const faces = byFamily.get(family);
		const face = faces
			? bestFace(faces, Number(weight), style)
			: null;

		if (face) {
			wanted.add(face);
		}
	}

	const rules = await Promise.all([...wanted].map(embedFace));

	return rules.filter((rule): rule is string => rule !== null).join('\n');
}

function propertyNames(): string[] {
	if (!styleProperties) {
		styleProperties = Array.from(getComputedStyle(document.documentElement)).filter((name) => !name.startsWith('--'));
	}

	return styleProperties;
}

/** Render the console beside the chat panel to a JPEG. `panelWidth` is the docked panel's width in CSS px. */
export async function captureConsole(panelWidth: number): Promise<ConsoleShot> {
	const started = performance.now();
	const root = document.querySelector<HTMLElement>('.app') ?? document.body;
	const width = Math.max(320, window.innerWidth - panelWidth);
	const height = window.innerHeight;
	const scale = Math.min(1, MAX_EDGE_PX / Math.max(width, height));
	const area: Box = { left: 0, top: 0, right: width, bottom: height };

	const plan = planRender(root, area);

	const cssText = await fontCss(plan.faces);

	const full = await domToCanvas(root, {
		scale,
		backgroundColor: getComputedStyle(document.body).backgroundColor,
		filter: (node) => !plan.skip.has(node),
		includeStyleProperties: propertyNames(),
		// an empty cssText would send the library back to scanning every stylesheet
		font: cssText
			? { cssText }
			: false
	});

	const cropped = document.createElement('canvas');

	cropped.width = Math.round(width * scale);
	cropped.height = Math.round(height * scale);

	cropped.getContext('2d')?.drawImage(full, 0, 0, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);

	const image = await new Promise<Blob>((resolve, reject) => {
		cropped.toBlob(
			(blob) => {
				if (blob) {
					resolve(blob);
				} else {
					reject(new Error('the browser could not encode the screenshot'));
				}
			},
			'image/jpeg',
			JPEG_QUALITY
		);
	});

	return {
		image,
		page: `${location.pathname}${location.search}`,
		width,
		height,
		ms: Math.round(performance.now() - started)
	};
}
