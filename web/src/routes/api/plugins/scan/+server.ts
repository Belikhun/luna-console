import { json } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock } from '$core/config';
import { scan } from '$core/plugins';
import { pushEvent } from '$lib/server/luna';

/** POST → rescan the pool and instance folders, rebuilding the lockfile. */
export async function POST() {
	const cfg = await loadCluster();
	const lock = await loadLock();
	const report = await scan(cfg, lock);

	await saveLock(lock);

	pushEvent(
		'plugins',
		'action',
		`scan: ${report.added.length} added, ${report.identified.length} identified`
	);

	return json({ ok: true, report });
}
