import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock } from '$core/config';
import { removePlugin } from '$core/plugins';
import { pushEvent } from '$lib/server/mrds';

/** PATCH { autoUpdate?, targets? } */
export async function PATCH({ params, request }) {
	const body = await request.json();
	const lock = await loadLock();
	const entry = lock.plugins[params.name];

	if (!entry) {
		throw error(404, 'unknown plugin');
	}

	if (typeof body.autoUpdate === 'boolean') {
		entry.autoUpdate = body.autoUpdate;
	}

	if (Array.isArray(body.targets)) {
		entry.targets = body.targets;
	}

	await saveLock(lock);

	return json({ ok: true });
}

/** DELETE ?from=a,b — remove from targets (or everywhere) */
export async function DELETE({ params, url }) {
	const cfg = await loadCluster();
	const lock = await loadLock();

	if (!lock.plugins[params.name]) {
		throw error(404, 'unknown plugin');
	}

	const from = url.searchParams.get('from')?.split(',').filter(Boolean);
	const res = await removePlugin(cfg, lock, params.name, from?.length ? from : undefined);

	await saveLock(lock);

	const where = res.deletedFrom.join(',') || '(none)';
	const pool = res.entryRemoved ? ' + pool' : '';

	pushEvent('plugins', 'action', `removed ${params.name} from ${where}${pool}`);

	return json({ ok: true, ...res });
}
