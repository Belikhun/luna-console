import { json } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock, saveCluster } from '$core/config';
import { checkUpdates, applyUpdate, deploy } from '$core/plugins';
import { ensurePortAllocations } from '$core/ports';
import { pushEvent } from '$lib/server/luna';
import { jsonBody } from '$lib/server/http';

/** POST { names?, deploy? }; download updates (and optionally deploy). */
export async function POST({ request }) {
	const body = await jsonBody(request);
	const cfg = await loadCluster();
	const lock = await loadLock();
	const { candidates } = await checkUpdates(cfg, lock, body.names);
	const applied: Array<{ name: string; version: string; targets: string[] }> = [];

	for (const cand of candidates.filter((cand) => cand.pendingGroups.length)) {
		await applyUpdate(lock, cand);

		for (const group of cand.pendingGroups) {
			applied.push({
				name: cand.name,
				version: group.version.version_number,
				targets: group.targets
			});
		}
	}

	await saveLock(lock);

	let deployed = 0;

	if (body.deploy && applied.length) {
		// only what this call updated: an unqualified update sweeps the pool, but a
		// named one must not push unrelated jars nobody asked about
		const entries = body.names?.length
			? [...new Set(applied.map((entry) => entry.name))]
			: [undefined];

		for (const plugin of entries) {
			const actions = await deploy(cfg, lock, { plugin });

			deployed += actions.filter((action) => action.action !== 'unchanged').length;
		}

		await ensurePortAllocations(cfg, lock);
		await saveCluster(cfg);
	}

	if (applied.length) {
		const names = [...new Set(applied.map((entry) => entry.name))].join(', ');

		pushEvent('plugins', 'action', `updated: ${names}`);
	}

	return json({ ok: true, applied, deployed });
}
