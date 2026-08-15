// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { publicSnapshot } from '$lib/server/publicsnapshot';
import { resolveMapArt } from '$lib/server/mapart';

/**
 * GET → which tiles make this instance's card art.
 *
 * A static segment under `[instance]` and above the map proxy's `[...path]`,
 * which SvelteKit resolves first; the map itself has no `art` path of its own,
 * so nothing is shadowed.
 */
export async function GET({ params }) {
	if (!(await publicSnapshot())) {
		throw error(404, 'not found');
	}

	const art = await resolveMapArt(params.instance);

	if (!art) {
		throw error(404, 'no map for this instance');
	}

	return json(art, { headers: { 'Cache-Control': 'public, max-age=600' } });
}
