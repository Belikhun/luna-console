// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The public page's gate and its first paint.
 *
 * One load for both screens, so the "is this cluster published at all" check
 * exists once. Server-rendered rather than fetched after paint, because this
 * page is the one the cluster shows to strangers and a flash of empty chrome is
 * the first thing they would see.
 */

import { error } from '@sveltejs/kit';

import { publicSnapshot } from '$lib/server/publicsnapshot';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async () => {
	const snapshot = await publicSnapshot();

	// 404, not 403: a cluster that has published nothing should look like one
	// with no such feature rather than like a locked door
	if (!snapshot) {
		throw error(404, 'not found');
	}

	return { snapshot };
};
