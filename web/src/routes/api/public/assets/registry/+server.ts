// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import { publicSnapshot } from '$lib/server/publicsnapshot';
import { registryResponse } from '$lib/server/mcassets';

/**
 * GET → the item registry, for the block icons on the public server cards.
 *
 * Same bytes as the console's route, gated on the page being published rather
 * than on a session.
 */
export async function GET({ request }) {
	if (!(await publicSnapshot())) {
		throw error(404, 'not found');
	}

	return await registryResponse(request);
}
