import { error, json } from '@sveltejs/kit';
import { existsSync } from 'node:fs';

import { loadCluster } from '$core/config';
import { pinnedMcVersion, unihexPath } from '$core/mcassets';
import { unihexGlyphs } from '$lib/server/unihex';

/** How many codepoints one request may ask about — a tooltip needs a dozen. */
const LIMIT = 512;

/**
 * GET → the unifont rows for the codepoints a preview could not draw, e.g.
 * `/api/mc/assets/font/unifont?cps=258d,2500`.
 *
 * The bundle is far too large to hand over whole, and the browser only ever
 * misses the few characters the bitmap sheets do not cover, so it names them.
 */
export async function GET({ params, url }) {
	const cfg = await loadCluster();
	const version = pinnedMcVersion(cfg);

	if (!version) {
		throw error(404, 'no Minecraft version is pinned');
	}

	// unihexPath rejects anything that is not a plain bundle name
	const path = unihexPath(version, params.file ?? '');

	if (!path || !existsSync(path)) {
		throw error(404, 'no such font bundle');
	}

	const codepoints = (url.searchParams.get('cps') ?? '')
		.split(',')
		.map((part) => Number.parseInt(part, 16))
		.filter((codepoint) => Number.isFinite(codepoint) && codepoint > 0)
		.slice(0, LIMIT);

	return json(await unihexGlyphs(path, codepoints), {
		headers: {
			// the bundle is pinned to a version, and the version rides in the query
			'Cache-Control': 'public, max-age=31536000, immutable'
		}
	});
}
