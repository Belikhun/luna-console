// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import { isInstanceTab } from '$lib/components/instancetabs';

/**
 * Refuse a path segment that names no tab.
 *
 * The optional parameter matches anything, so without this a typo
 * (`/instances/survival/plugns`) would quietly render the default tab under a URL
 * that means nothing - and put that nonsense in the breadcrumb.
 *
 * A tab that exists but does not apply to *this* instance is a different case and
 * is deliberately not refused here: a proxy has no world, and a link that was
 * valid for one instance should degrade to the default rather than 404 on
 * another. The page settles that, because only it knows the software.
 */
export function load({ params }) {
	if (params.tab !== undefined && !isInstanceTab(params.tab)) {
		throw error(404, `no such tab: ${params.tab}`);
	}

	return {};
}
