// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Serving the extracted Minecraft assets.
 *
 * These live here rather than in the routes because two route trees serve them:
 * the console's gated one, and the public page's, which draws the same block
 * icons on its server cards. The bytes are Minecraft's own textures and an
 * index of them, so nothing here is cluster information; the public mirror is
 * still gated on the page being switched on, since a cluster that publishes
 * nothing should expose nothing.
 */

import { error } from '@sveltejs/kit';
import { existsSync } from 'node:fs';

import { loadCluster } from '$core/config';
import { pinnedMcVersion, registryPath, texturePath } from '$core/mcassets';

/**
 * The item registry: every material the console can draw, and how.
 *
 * Revalidated rather than cached outright. The index is rebuilt whenever the
 * assets are re-extracted or the code that indexes them changes, and a browser
 * told to hold it for an hour goes on drawing from the old one long after; so
 * the tag is checked every time and the body only sent when it has moved.
 */
export async function registryResponse(request: Request): Promise<Response> {
	const cfg = await loadCluster();
	const version = pinnedMcVersion(cfg);

	if (!version || !existsSync(registryPath(version))) {
		throw error(404, 'the Minecraft assets have not been extracted yet');
	}

	const file = Bun.file(registryPath(version));
	const tag = `"${version}-${file.lastModified}"`;

	const headers = {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-cache',
		ETag: tag
	};

	if (request.headers.get('if-none-match') === tag) {
		return new Response(null, { status: 304, headers });
	}

	return new Response(file.stream(), { headers });
}

/**
 * One texture, e.g. `item/compass`.
 *
 * A texture is immutable for a version and the version rides in the query, so
 * this can be cached hard without ever going stale.
 */
export async function textureResponse(path: string): Promise<Response> {
	const cfg = await loadCluster();
	const version = pinnedMcVersion(cfg);

	if (!version) {
		throw error(404, 'no Minecraft version is pinned');
	}

	// texturePath rejects anything that is not a plain png path under the version
	const resolved = texturePath(version, path);

	if (!resolved || !existsSync(resolved)) {
		throw error(404, 'no such texture');
	}

	return new Response(Bun.file(resolved).stream(), {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'public, max-age=31536000, immutable'
		}
	});
}
