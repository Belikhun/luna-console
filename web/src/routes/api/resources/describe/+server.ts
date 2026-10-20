// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { describeResources } from '$core/resources';
import { jsonBody } from '$lib/server/http';

/** POST { ids: string[] } → each resource's record (placeholders when unrecorded). */
export async function POST({ request }) {
	const body = await jsonBody(request);
	const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 500) : [];

	return json({ resources: await describeResources(ids) });
}
