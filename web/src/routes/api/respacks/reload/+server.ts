// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';
import { loadCluster } from '$core/config';
import { reloadResourcePacks } from '$core/respacks';
import { pushEvent } from '$lib/server/luna';

/** POST → ask the running proxy to re-read the packs directory. */
export async function POST() {
	const cfg = await loadCluster();
	const sent = await reloadResourcePacks(cfg);

	if (sent) {
		pushEvent('packs', 'action', 'resource pack reload sent to the proxy');
	}

	return json({ ok: true, sent });
}
