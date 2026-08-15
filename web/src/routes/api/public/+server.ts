// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { publicSnapshot } from '$lib/server/publicsnapshot';

/**
 * GET → everything the public page renders, in one document.
 *
 * 404 rather than 403 when the page is off: a cluster that has not published
 * one should look like a cluster that has no such feature, not like a locked
 * door with something behind it.
 */
export async function GET() {
	const snapshot = await publicSnapshot();

	if (!snapshot) {
		throw error(404, 'not found');
	}

	return json(snapshot, {
		headers: {
			// short and shared: every visitor gets the same document, and a couple
			// of seconds of staleness is invisible against a five second sampler
			'Cache-Control': 'public, max-age=2'
		}
	});
}
