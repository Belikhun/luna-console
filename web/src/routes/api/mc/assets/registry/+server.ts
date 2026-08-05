// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';
import { existsSync } from 'node:fs';

import { loadCluster } from '$core/config';
import { pinnedMcVersion, registryPath } from '$core/mcassets';

/**
 * GET → the item registry: every material the editor can offer, and how each is
 * drawn.
 *
 * Revalidated rather than cached outright. The index is rebuilt whenever the
 * assets are re-extracted or the code that indexes them changes, and a browser
 * that had been told to hold it for an hour went on drawing from the old one
 * long after the rebuild; so the tag is checked every time and the body only
 * sent when it has actually moved.
 */
export async function GET({ request }) {
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
