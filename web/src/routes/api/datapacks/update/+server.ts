import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock } from '$core/config';
import { applyDataPackUpdate, checkDataPackUpdates, deployDataPacks } from '$core/datapacks';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * POST { names?, apply? } → check data packs for Modrinth updates; with apply,
 * download them and redeploy the changed packs to their targets.
 */
export async function POST({ request }) {
	const body = await request.json().catch(() => ({}));
	const cfg = await loadCluster();
	const lock = await loadPacksLock();

	try {
		const groups = (await loadLock()).groups;
		const { updates, skipped } = await checkDataPackUpdates(cfg, lock, body.names, groups);

		if (!body.apply) {
			return json({ ok: true, updates, skipped, applied: [] });
		}

		let deployed = 0;

		for (const update of updates) {
			await applyDataPackUpdate(lock, update);

			const actions = await deployDataPacks(cfg, lock, { pack: update.name, groups });

			deployed += actions.filter((action) => action.action !== 'unchanged').length;
			pushEvent('packs', 'action', `data pack ${update.name} updated to ${update.to}`);
		}

		await savePacksLock(lock);

		return json({
			ok: true,
			updates,
			skipped,
			applied: updates.map((update) => update.name),
			deployed
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
