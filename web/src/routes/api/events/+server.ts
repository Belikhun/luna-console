// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';
import { getEvents } from '$lib/server/luna';

/** GET ?instance= → the cluster event log, newest first (from the daemon). */
export async function GET({ url }) {
	return json({ events: await getEvents(url.searchParams.get('instance') ?? undefined) });
}
