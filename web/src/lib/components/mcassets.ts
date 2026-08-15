// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The Minecraft item registry, as the browser uses it.
 *
 * One fetch per page load, shared by every item the editor draws; a chest page
 * is 45 items and the material picker lists a thousand more, so each of them
 * asking independently would be absurd. The shapes come from `$shared` so the
 * daemon that builds the registry and the canvas that draws it cannot drift.
 */

import { materialKey, renderFor, type McAssetRegistry } from '$shared/mcassets';

export type {
	GuiTransform,
	ItemRender,
	McAssetRegistry,
	McAssetState,
	ModelDirection,
	ModelElement,
	ModelFace,
	ModelGeometry
} from '$shared/mcassets';
export { materialKey, renderFor } from '$shared/mcassets';

let pending: Promise<McAssetRegistry | null> | null = null;
let cached: McAssetRegistry | null = null;

/**
 * Where the asset routes live.
 *
 * The console reads them through its own gated tree. The public page serves the
 * same bytes from an ungated mirror, so it points this at that mirror instead;
 * without it, every block icon on a public card would 401 for a visitor who has
 * no session, which is all of them.
 */
let assetBase = '/api/mc/assets';

/** Point the asset URLs at a different tree; the public page's own mirror. */
export function setAssetBase(base: string): void {
	if (base === assetBase) {
		return;
	}

	assetBase = base;
	resetRegistry();
}

/** The registry, or null when the assets have not been extracted yet. */
export function loadRegistry(): Promise<McAssetRegistry | null> {
	if (cached) {
		return Promise.resolve(cached);
	}

	if (!pending) {
		pending = fetch(`${assetBase}/registry`)
			.then((res) => (res.ok ? (res.json() as Promise<McAssetRegistry>) : null))
			.then((registry) => {
				cached = registry;
				assetVersion = registry?.version ?? '';

				return registry;
			})
			.catch(() => null);
	}

	return pending;
}

/** Forget the cached registry, after extracting a different version. */
export function resetRegistry(): void {
	cached = null;
	pending = null;
}

// A texture is immutable for a version but its path is not; `font/ascii.png` is
// a different picture in a different version; so the version rides along in the
// query and the response can be cached hard without ever going stale.
let assetVersion = '';

/** Where a texture path like `item/compass` is served from. */
export function textureUrl(path: string): string {
	const stamp = assetVersion ? `?v=${encodeURIComponent(assetVersion)}` : '';

	return `${assetBase}/texture/${path}.png${stamp}`;
}

/**
 * Where a batch of unifont rows is served from.
 *
 * Codepoints go in the query rather than the path because the bundle is eight
 * megabytes and the browser wants a dozen glyphs out of it; one request per
 * character would be worse than one request per text block by an order of
 * magnitude.
 */
export function unihexUrl(file: string, codepoints: number[]): string {
	const stamp = assetVersion ? `&v=${encodeURIComponent(assetVersion)}` : '';
	const list = codepoints.map((codepoint) => codepoint.toString(16)).join(',');

	return `${assetBase}/font/${encodeURIComponent(file)}?cps=${list}${stamp}`;
}

/** The chest background the inventory is drawn on. */
export const CHEST_TEXTURE_URL = '/api/mc/assets/gui';

/**
 * Which face of a material stands in for it as a flat picture.
 *
 * A model carries a texture per named face, and there is no "the" texture; the
 * side is what a block looks like from eye level, so that is the pick, with the
 * usual fallbacks behind it for models that name their faces differently.
 */
const TILE_FACES = ['side', 'all', 'top', 'north', 'end', 'particle'];

const patternCache = new Map<string, Promise<string | null>>();

/**
 * One material's texture as a data URI, ready to tile as a CSS background.
 *
 * Cropped to the first frame rather than used as the file stands: an animated
 * texture is a vertical strip of frames, and tiling the strip would repeat a
 * column of every frame at once instead of the block. Sixteen pixels square
 * either way, so the caller supplies the scale and `image-rendering: pixelated`.
 *
 * Returns null for a material with no drawable texture, which is the caller's
 * cue to leave the backdrop plain rather than draw a broken one.
 */
export function tilePatternUrl(item: string | undefined): Promise<string | null> {
	const key = materialKey(item);
	const existing = patternCache.get(key);

	if (existing) {
		return existing;
	}

	const promise = buildPattern(item);

	patternCache.set(key, promise);

	return promise;
}

async function buildPattern(item: string | undefined): Promise<string | null> {
	const registry = await loadRegistry();
	const render = renderFor(registry, item);

	if (!render) {
		return null;
	}

	const path =
		render.kind === 'flat'
			? render.layers?.[0]
			: TILE_FACES.map((face) => render.textures?.[face]).find(Boolean);

	if (!path) {
		return null;
	}

	const image = await loadTexture(path.replace(/^minecraft:/, ''));

	if (!image?.width) {
		return null;
	}

	const canvas = document.createElement('canvas');
	canvas.width = image.width;
	canvas.height = image.width;

	const ctx = canvas.getContext('2d');

	if (!ctx) {
		return null;
	}

	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(image, 0, 0, image.width, image.width, 0, 0, image.width, image.width);

	return canvas.toDataURL();
}

const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

/** Load a texture once, whoever asks for it. */
export function loadTexture(path: string): Promise<HTMLImageElement | null> {
	const url = textureUrl(path);
	const existing = imageCache.get(url);

	if (existing) {
		return existing;
	}

	const promise = new Promise<HTMLImageElement | null>((resolve) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => resolve(null);
		image.src = url;
	});

	imageCache.set(url, promise);

	return promise;
}
