import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock } from '$core/config';
import { deployDataPacks, installDataPackFromModrinth } from '$core/datapacks';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { getProject } from '$core/services/modrinth';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * POST { slug, targets?, channel? } → install a data pack from Modrinth and
 * deploy it. Targets may be empty: a pack can reach its instances through an
 * addon group instead, and then there is no MC version to gate the install on.
 */
export async function POST({ request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadPacksLock();
	const project = await getProject(body.slug);

	if (!project) {
		throw error(404, `modrinth project "${body.slug}" not found`);
	}

	const targets = Array.isArray(body.targets) ? body.targets.map(String) : [];

	try {
		const res = await installDataPackFromModrinth(cfg, lock, project, targets, {
			channel: body.channel
		});

		await savePacksLock(lock);

		const actions = await deployDataPacks(cfg, lock, {
			pack: res.name,
			groups: (await loadLock()).groups
		});

		pushEvent(
			'packs',
			'action',
			`data pack ${res.name} installed (${res.entry.installed?.versionNumber})`
		);

		return json({
			ok: true,
			name: res.name,
			entry: res.entry,
			deployed: actions.filter((action) => action.action !== 'unchanged').length
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
