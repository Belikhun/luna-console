// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * One public server's page.
 *
 * The gate is the flag, not the link. An instance that did not opt in must 404
 * here even though nothing on the site points at it; otherwise the opt-in is
 * only a decision about the grid, and anyone who guesses a name walks around it.
 */

import { error } from '@sveltejs/kit';

import { publicSnapshot } from '$lib/server/publicsnapshot';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const snapshot = await publicSnapshot();

	if (!snapshot) {
		throw error(404, 'not found');
	}

	const card = snapshot.instances.find((instance) => instance.name === params.instance);

	if (!card) {
		throw error(404, 'not found');
	}

	return { card };
};
