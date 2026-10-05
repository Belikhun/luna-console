// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { searchModpacks } from '$core/modpack';

/** GET ?q=&loader= → Modrinth modpacks luna can host, for the install dialog. */
export async function GET({ url }) {
	const query = url.searchParams.get('q');

	if (!query) {
		throw error(400, 'q required');
	}

	const loader = url.searchParams.get('loader');

	try {
		return json({ hits: await searchModpacks(query, loader ? [loader] : undefined) });
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : String(err));
	}
}
