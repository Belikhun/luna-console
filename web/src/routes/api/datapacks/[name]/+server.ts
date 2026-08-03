import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock } from '$core/config';
import { pruneAddon } from '$core/families';
import { deployDataPacks, removeDataPack } from '$core/datapacks';
import { loadPacksLock, savePacksLock } from '$core/packslock';
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

		if (typeof body.autoUpdate === 'boolean') {
			entry.autoUpdate = body.autoUpdate;
		}

		if (body.channel) {
			entry.channel = body.channel;

			if (entry.channel === 'release') {
				delete entry.channel;
			}
		}

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
