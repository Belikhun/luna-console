// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { modpackVersions } from '$core/modpack';
import { errorMessage } from '$lib/server/http';

/** GET ?slug= → every published version of a pack, newest first. */
export async function GET({ url }) {
	const slug = url.searchParams.get('slug');

	if (!slug) {
		throw error(400, 'slug required');
	}

	try {
		return json({ versions: await modpackVersions(slug) });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
