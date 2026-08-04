import { error } from '@sveltejs/kit';
import { existsSync } from 'node:fs';

import { loadCluster } from '$core/config';
import { pinnedMcVersion, texturePath } from '$core/mcassets';

/** GET → one item or block texture, e.g. `/api/mc/assets/texture/item/compass.png`. */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const version = pinnedMcVersion(cfg);

	if (!version) {
		throw error(404, 'no Minecraft version is pinned');
	}

	// texturePath rejects anything that is not a plain png path under the version
	const path = texturePath(version, params.path ?? '');

	if (!path || !existsSync(path)) {
		throw error(404, 'no such texture');
	}

	return new Response(Bun.file(path).stream(), {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'public, max-age=31536000, immutable'
		}
	});
}
