// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import { publicSnapshot } from '$lib/server/publicsnapshot';
import { textureResponse } from '$lib/server/mcassets';

/** GET → one texture, for the block icons on the public server cards. */
export async function GET({ params }) {
	if (!(await publicSnapshot())) {
		throw error(404, 'not found');
	}

	return await textureResponse(params.path ?? '');
}
