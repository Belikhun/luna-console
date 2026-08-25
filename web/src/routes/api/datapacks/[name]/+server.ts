// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock } from '$core/config';
import { pruneAddon } from '$core/families';
import { deployDataPacks, removeDataPack, updateDataPack } from '$core/datapacks';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { isReleaseChannel } from '$core/services/providers';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * PATCH { targets?, autoUpdate?, channel? } → edit a data pack's deployment
 * policy. A target change deploys immediately, adding and removing world
 * copies to match.
 */
export async function PATCH({ params, request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadPacksLock();
	const entry = lock.datapacks[params.name];

	if (!entry) {
		throw error(404, `unknown data pack: ${params.name}`);
	}

	try {
		if (Array.isArray(body.targets)) {
			entry.targets = body.targets.map((target: unknown) => String(target));
		}

		if (typeof body.channel === 'string' && !isReleaseChannel(body.channel)) {
			throw error(400, `unknown channel: ${body.channel}`);
		}

		// core owns the two update-policy fields, including the rule that
		// "release" is stored as absence; this route used to reimplement it
		updateDataPack(lock, params.name, {
			...(typeof body.autoUpdate === 'boolean' ? { autoUpdate: body.autoUpdate } : {}),
			...(typeof body.channel === 'string' ? { channel: body.channel } : {})
		});

		await savePacksLock(lock);

		let deployed = 0;

		if (Array.isArray(body.targets)) {
			const actions = await deployDataPacks(cfg, lock, {
				pack: params.name,
				groups: (await loadLock()).groups
			});

			deployed = actions.filter((action) => action.action !== 'unchanged').length;
		}

		pushEvent('packs', 'action', `data pack ${params.name} updated`);

		return json({ ok: true, entry, deployed });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE ?from=a,b → remove from those worlds only; without it, everywhere + pool. */
export async function DELETE({ params, url }) {
	const cfg = await loadCluster();
	const lock = await loadPacksLock();
	const rawFrom = url.searchParams.get('from');
	const from = rawFrom
		? rawFrom.split(',').map((target) => target.trim()).filter(Boolean)
		: undefined;

	try {
		const plugins = await loadLock();
		const res = await removeDataPack(cfg, lock, params.name, from, plugins.groups);

		await savePacksLock(lock);

		// a pack that is gone must not linger as a phantom group member
		if (res.entryRemoved && pruneAddon(plugins, 'datapacks', params.name)) {
			await saveLock(plugins);
		}

		pushEvent('packs', 'action', `data pack ${params.name} removed`);

		return json({ ok: true, ...res });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
