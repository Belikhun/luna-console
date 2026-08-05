import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock, saveCluster } from '$core/config';
import { installFromProvider, deploy, projectTypeFor } from '$core/plugins';
import { getProject } from '$core/services/providers';
import { ensurePortAllocations } from '$core/ports';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';
import type { ProviderId } from '$core/types';

/**
 * POST { slug, family, targets, provider?, id? }; `id` is the provider's
 * project id when the picker knows it (some providers cannot look a project
 * up by slug alone).
 */
export async function POST({ request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadLock();

	const family =
		body.family === 'velocity' || body.family === 'neoforge' ? body.family : 'paper';
	const provider = (body.provider ?? 'modrinth') as ProviderId;
	const project = await getProject(provider, body.id ?? body.slug, projectTypeFor(family));

	if (!project) {
		throw error(404, `${provider} project "${body.slug ?? body.id}" not found`);
	}

	try {
		const res = await installFromProvider(cfg, lock, provider, project, family, body.targets);

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
