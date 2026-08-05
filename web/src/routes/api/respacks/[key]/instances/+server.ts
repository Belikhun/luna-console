// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock } from '$core/config';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { reloadResourcePacks, setResourcePackForInstance } from '$core/respacks';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * POST { instance, on, reload? } → serve (or stop serving) this pack on one
 * backend, by editing the pack's server rules.
 *
 * The instance screen's own verb: an operator there is thinking "not on this
 * server", not "edit rule list", so the rule algebra stays in core and the
 * button sends the intent. Reloads the proxy by default, since a rule change
 * that has not reached the proxy has not happened.
 */
export async function POST({ params, request }) {
	const body = await request.json();
	const instance = String(body.instance ?? '');
	const on = body.on === true;

	if (!instance) {
		throw error(400, 'instance is required');
	}

	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	try {
		const { pack, groupConflict } = await setResourcePackForInstance(
			cfg,
			lock,
			params.key,
			instance,
			on,
			(await loadLock()).groups
		);

		await savePacksLock(lock);

		const reloaded = body.reload === false ? false : await reloadResourcePacks(cfg);

		pushEvent(
			instance,
			'action',
			`resource pack ${params.key} ${on ? 'served on' : 'withheld from'} ${instance}`
		);

		return json({ ok: true, pack, groupConflict, reloaded });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
