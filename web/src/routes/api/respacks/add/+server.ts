import { json, error } from '@sveltejs/kit';
import { loadCluster } from '$core/config';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { installResourcePackFromModrinth } from '$core/respacks';
import { getProject } from '$core/services/modrinth';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/** POST { slug, channel? } → install a resource pack from Modrinth. */
export async function POST({ request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadPacksLock();
	const project = await getProject(body.slug);

	if (!project) {
		throw error(404, `modrinth project "${body.slug}" not found`);
	}

	try {
		const row = await installResourcePackFromModrinth(cfg, lock, project, {
			channel: body.channel
		});

		await savePacksLock(lock);
		pushEvent('packs', 'action', `resource pack ${row.key} installed (${row.versionNumber})`);

		return json({ ok: true, pack: row });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
