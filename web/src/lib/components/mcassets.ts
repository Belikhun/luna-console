/**
 * The Minecraft item registry, as the browser uses it.
 *
 * One fetch per page load, shared by every item the editor draws; a chest page
 * is 45 items and the material picker lists a thousand more, so each of them
 * asking independently would be absurd. The shapes come from `$shared` so the
 * daemon that builds the registry and the canvas that draws it cannot drift.
 */

import type { McAssetRegistry } from '$shared/mcassets';

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

/** The registry, or null when the assets have not been extracted yet. */
export function loadRegistry(): Promise<McAssetRegistry | null> {
	if (cached) {
		return Promise.resolve(cached);
	}

	if (!pending) {
		pending = fetch('/api/mc/assets/registry')
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

	return `/api/mc/assets/texture/${path}.png${stamp}`;
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

	return `/api/mc/assets/font/${encodeURIComponent(file)}?cps=${list}${stamp}`;
}

/** The chest background the inventory is drawn on. */
export const CHEST_TEXTURE_URL = '/api/mc/assets/gui';

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
