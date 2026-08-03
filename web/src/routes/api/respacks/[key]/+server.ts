import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock } from '$core/config';
import { pruneAddon } from '$core/families';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { removeResourcePack, updateResourcePack } from '$core/respacks';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/** PATCH { name?, priority?, required?, enabled?, servers?, autoUpdate?, channel? } */
export async function PATCH({ params, request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	try {
		const row = await updateResourcePack(
			cfg,
			lock,
			params.key,
			{
				name: body.name,
				priority: body.priority,
				required: body.required,
				enabled: body.enabled,
				servers: body.servers,
				autoUpdate: body.autoUpdate,
				channel: body.channel
			},
			(await loadLock()).groups
		);

		await savePacksLock(lock);
		pushEvent('packs', 'action', `resource pack ${params.key} updated`);

		return json({ ok: true, pack: row });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE ?keepFile=true → remove the registration (and, by default, the zip). */
export async function DELETE({ params, url }) {
	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	try {
		const { removed } = await removeResourcePack(cfg, lock, params.key, {
			keepFile: url.searchParams.get('keepFile') === 'true'
		});

		await savePacksLock(lock);

		// a removed pack must not linger as a phantom group member
		const plugins = await loadLock();

		if (pruneAddon(plugins, 'respacks', params.key)) {
			await saveLock(plugins);
		}

		pushEvent('packs', 'action', `resource pack ${params.key} removed`);

		return json({ ok: true, removed });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
