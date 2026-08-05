// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, managedInstances } from '$core/config';
import { adoptDataPack, deployDataPacks, instanceDataPackReport } from '$core/datapacks';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * GET → what this instance's world holds: managed packs (present, missing or
 * stale) and unmanaged zips someone dropped in by hand.
 */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	try {
		const report = await instanceDataPackReport(cfg, lock, params.name, (await loadLock()).groups);

		return json(report);
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/**
 * POST { action: 'deploy' } → sync this world from the pool.
 * POST { action: 'adopt', file } → pull a hand-dropped zip into the pool.
 */
export async function POST({ params, request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadPacksLock();
	const name = params.name;

	if (body.action !== 'deploy' && body.action !== 'adopt') {
		throw error(400, 'action must be "deploy" or "adopt"');
	}

	try {
		if (body.action === 'deploy') {
			const actions = await deployDataPacks(cfg, lock, {
				instances: [name],
				groups: (await loadLock()).groups
			});

			pushEvent(name, 'action', 'data packs deployed');

			return json({ ok: true, actions });
		}

		const res = await adoptDataPack(cfg, lock, name, String(body.file ?? ''));

		await savePacksLock(lock);
		pushEvent(name, 'action', `data pack ${res.name} adopted from this world`);

		return json({ ok: true, name: res.name, entry: res.entry });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
