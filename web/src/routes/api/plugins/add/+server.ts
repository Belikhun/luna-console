import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock, saveCluster } from '$core/config';
import { installFromModrinth, deploy } from '$core/plugins';
import { getProject } from '$core/services/modrinth';
import { ensurePortAllocations } from '$core/ports';
import { pushEvent } from '$lib/server/mrds';
import { errorMessage } from '$lib/server/http';

/** POST { slug, loader, targets } */
export async function POST({ request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadLock();
	const project = await getProject(body.slug);

	if (!project) {
		throw error(404, `modrinth project "${body.slug}" not found`);
	}

	const loader = body.loader === 'velocity' ? 'velocity' : 'paper';

	try {
		const res = await installFromModrinth(cfg, lock, project, loader, body.targets);

		await saveLock(lock);

		const actions = await deploy(cfg, lock, { plugin: res.name });

		await ensurePortAllocations(cfg, lock);
		await saveCluster(cfg);
		await saveLock(lock);

		pushEvent('plugins', 'action', `installed ${res.name}`);

		return json({
			ok: true,
			name: res.name,
			groups: res.resolution.groups.map((group) => ({
				version: group.version.version_number,
				targets: group.targets,
				isPrimary: group.isPrimary
			})),
			holdbacks: res.resolution.holdbacks,
			deployed: actions.filter((action) => action.action !== 'unchanged').length
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
