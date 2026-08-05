import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock, saveCluster } from '$core/config';
import { deploy, uploadJar } from '$core/plugins';
import { ensureAliases } from '$core/pluginstate';
import { ensurePortAllocations } from '$core/ports';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * POST { plugin, family, targets?, data } → pool a jar uploaded from the
 * console and deploy it to its targets. `data` is the jar base64-encoded -
 * JSON rather than multipart for the same CSRF reason as the pack uploads.
 * Targets may be empty: pooling without deploying is a first-class choice.
 */
export async function POST({ request }) {
	const body = await request.json();
	const plugin = String(body.plugin ?? '');
	const data = String(body.data ?? '');
	const family = body.family === 'velocity' || body.family === 'universal' ? body.family : 'paper';

	if (!plugin || !data) {
		throw error(400, 'plugin and data are required');
	}

	const cfg = await loadCluster();
	const lock = await loadLock();

	try {
		const res = await uploadJar(cfg, lock, {
			plugin,
			family,
			targets: Array.isArray(body.targets) ? body.targets.map(String) : [],
			dataBase64: data
		});

		// the jar's own descriptor (name, version, authors) comes from the file
		await ensureAliases(lock);
		await saveLock(lock);

		const actions = await deploy(cfg, lock, { plugin: res.name });

		await ensurePortAllocations(cfg, lock);
		await saveCluster(cfg);
		await saveLock(lock);

		pushEvent('plugins', 'action', `uploaded ${res.name}`);

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
