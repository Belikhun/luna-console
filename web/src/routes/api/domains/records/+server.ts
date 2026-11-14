// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { baseDomainRecords, hostnameRecords } from '$core/domains';
import { errorMessage } from '$lib/server/http';

/** GET ?name= | ?base= → the live records at one hostname, or under one whole base domain (the default one without `base`). */
export async function GET({ url }) {
	const name = url.searchParams.get('name')?.trim();
	const base = url.searchParams.get('base')?.trim() || undefined;

	try {
		return json(name ? await hostnameRecords(name) : await baseDomainRecords(base));
	} catch (err) {
		throw error(502, errorMessage(err));
	}
}
