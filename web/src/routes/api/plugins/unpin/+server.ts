import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock } from '$core/config';
import { unpinVersion } from '$core/plugins';
import { errorMessage } from '$lib/server/http';

/** POST { name, targets? } */
export async function POST({ request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadLock();

	try {
		const removed = unpinVersion(cfg, lock, body.name, body.targets);

		await saveLock(lock);

		return json({ ok: true, removed });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
