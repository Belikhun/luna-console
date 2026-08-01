import { json, error } from '@sveltejs/kit';
import { loadCluster, saveCluster, loadLock, saveLock } from '$core/config';
import { createInstance } from '$core/admin';
import { deploy } from '$core/plugins';
import { ensurePortAllocations } from '$core/ports';
import { syncVelocityToml } from '$core/proxy';
import { pushEvent } from '$lib/server/mrds';
import { errorMessage } from '$lib/server/http';

/** POST { name, mcVersion, memory?, profile?, port?, register? } */
export async function POST({ request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadLock();

	try {
		const res = await createInstance(cfg, body.name, {
			mcVersion: body.mcVersion,
			memory: body.memory || undefined,
			profile: body.profile || undefined,
			port: body.port ? Number(body.port) : undefined,
			register: body.register !== false
		});

		await saveCluster(cfg);

		// wildcard-targeted plugins apply to the new instance right away
		const deployed = await deploy(cfg, lock, { instances: [body.name] });

		await ensurePortAllocations(cfg, lock);
		await saveCluster(cfg);
		await saveLock(lock);

		let velocityUpdated = false;

		if (body.register !== false) {
			velocityUpdated = (await syncVelocityToml(cfg)).changed;
		}

		pushEvent(
			body.name,
			'action',
			`instance created (paper ${body.mcVersion}, port ${res.port})`
		);

		return json({
			ok: true,
			name: res.name,
			port: res.port,
			build: res.build.build,
			pluginsDeployed: deployed.filter((action) => action.action !== 'unchanged').length,
			velocityUpdated
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
