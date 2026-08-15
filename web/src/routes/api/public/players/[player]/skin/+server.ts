// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import { publicSnapshot } from '$lib/server/publicsnapshot';
import { skinResponse } from '$lib/server/skins';

/**
 * GET → a player's skin PNG for the public page's online lists.
 *
 * Same pixels and same cache as the console's route; the difference is the
 * gate, and the caching. A skin is public information the game hands to every
 * client in the lobby, so a shared cache may hold it, which the console's own
 * route deliberately does not allow for its private responses.
 */
export async function GET({ params }) {
	if (!(await publicSnapshot())) {
		throw error(404, 'not found');
	}

	return await skinResponse(params.player, 'public, max-age=600');
}
