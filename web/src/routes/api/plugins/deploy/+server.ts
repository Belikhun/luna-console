// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';
import { loadCluster, loadLock, saveCluster, saveLock } from '$core/config';
import { deploy } from '$core/plugins';
import { ensurePortAllocations } from '$core/ports';
import { getAllStatuses } from '$core/instances';
import { pushEvent } from '$lib/server/luna';
import { jsonBody } from '$lib/server/http';

/** POST { instances?, plugin? } */
export async function POST({ request }) {
	const body = await jsonBody(request);
	const cfg = await loadCluster();
	const lock = await loadLock();
	const actions = await deploy(cfg, lock, { instances: body.instances, plugin: body.plugin });

	await ensurePortAllocations(cfg, lock);
	await saveCluster(cfg);

	// deploy may auto-assign an MC-fit variant to an instance; persist it
	await saveLock(lock);

	const changed = actions.filter(
		(action) => action.action !== 'unchanged' && action.action !== 'missing-variant'
	);

	const statuses = await getAllStatuses(cfg);

	// a running instance keeps the old jar loaded until it restarts
	const needRestart = [...new Set(changed.map((action) => action.instance))].filter(
		(name) => statuses.find((status) => status.name === name)?.state !== 'stopped'
	);

	if (changed.length) {
		pushEvent('plugins', 'action', `deployed ${changed.length} change(s)`);
	}

	return json({ ok: true, actions, needRestart });
}
