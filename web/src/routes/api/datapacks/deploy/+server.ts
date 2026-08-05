// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster } from '$core/config';
import { deployDataPacks } from '$core/datapacks';
import { loadPacksLock } from '$core/packslock';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/** POST { instances?, pack? } → sync worlds from the pool. */
export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	try {
		const actions = await deployDataPacks(cfg, lock, {
			instances: body.instances,
			pack: body.pack
		});

		const changed = actions.filter((action) => action.action !== 'unchanged');

		if (changed.length) {
			pushEvent('packs', 'action', `data pack deploy: ${changed.length} change(s)`);
		}

		return json({ ok: true, actions });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
