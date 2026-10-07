// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { checkDomainProvider } from '$core/domains';

/** POST → one call to the provider: does the credential and the whitelisted IP work. */
export async function POST() {
	return json(await checkDomainProvider());
}
