// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { redirect } from '@sveltejs/kit';

import { instanceTabPath } from '$lib/components/instancetabs';

/**
 * `/instances/<name>/players` is the crumb above a player's instance-scoped page,
 * and the breadcrumb links it; the players themselves are listed on the
 * "Players & access" tab, so that is where the link lands.
 */
export function load({ params }) {
	throw redirect(307, instanceTabPath(params.name, 'access'));
}
