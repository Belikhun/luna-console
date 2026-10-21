// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { describeResources } from '$core/resources';
import { jsonBody } from '$lib/server/http';
import { filterAllowed } from '$lib/server/authz';

/**
 * POST { ids: string[] } → each resource's record (placeholders when
 * unrecorded), for the ones whose tags the account may read: `tag:Describe` is
 * decided per resource, as tagging one is.
 */
export async function POST({ request, locals }) {
	const body = await jsonBody(request);
	const ids: string[] = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 500) : [];
	const readable = await filterAllowed(locals, 'tag:Describe', ids, (id) => id);

	return json({ resources: await describeResources(readable) });
}
