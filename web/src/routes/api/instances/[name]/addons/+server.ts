// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, saveCluster, loadLock, saveLock } from '$core/config';
import { deploy, installFromProvider, projectTypeFor, uploadJar } from '$core/plugins';
import { setPluginOverride } from '$core/families';
import { ensureAliases, supersedeAddons } from '$core/pluginstate';
import { ensurePortAllocations } from '$core/ports';
import { getProject, isReleaseChannel } from '$core/services/providers';
import { PLUGIN_FAMILIES } from '$core/types';
import type { PluginFamily, ProviderId } from '$core/types';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * Put one addon on one instance, from whichever of the three places it comes.
 *
 * One route rather than three because the interesting half is the same for all
 * of them: the addon has to reach the pool, then this instance's targets, then
 * its directory, and any copy of the same addon already there has to go or the
 * server loads it twice. Splitting that across an upload route, a targets PATCH
 * and a provider install is what made "add a plugin to this backend" a
 * three-screen errand in the first place.
 *
 * POST body:
 *   { source: 'upload',   plugin, family, data,                deploy?, supersede? }
 *   { source: 'pool',     plugin,                              deploy?, supersede? }
 *   { source: 'provider', provider, slug, id?, family, channel?, deploy?, supersede? }
 *
 * `supersede` is `{ plugins?, files? }` exactly as the collisions route reported
 * them; it runs *after* the new addon is in place, so a failure never leaves the
 * instance with neither copy.
 */
export async function POST({ params, request }) {
	const body = await request.json();
	const name = params.name;
	const cfg = await loadCluster();
	const lock = await loadLock();

	if (!cfg.instances[name]) {
		throw error(404, `unknown instance: ${name}`);
	}

	const deployHere = body.deploy !== false;
	const targets = deployHere ? [name] : [];

	let entryName = '';
	let holdbacks: unknown[] = [];

	try {
		if (body.source === 'upload') {
			const family = familyOf(body.family);
			const res = await uploadJar(cfg, lock, {
				plugin: String(body.plugin ?? ''),
				family,
				targets,
				dataBase64: String(body.data ?? '')
			});

			entryName = res.name;
		} else if (body.source === 'pool') {
			const plugin = String(body.plugin ?? '');

			if (!plugin) {
				throw error(400, 'plugin is required');
			}

			// a pooled addon reaches one instance through its own override, not by
			// editing the entry's targets: targets are cluster-wide, and adding one
			// instance there is not what the operator asked for
			setPluginOverride(cfg, lock, name, plugin, deployHere ? true : null);
			entryName = plugin;
		} else if (body.source === 'provider') {
			const family = familyOf(body.family);
			const provider = (body.provider ?? 'modrinth') as ProviderId;
			const channel = typeof body.channel === 'string' ? body.channel : undefined;

			if (channel !== undefined && !isReleaseChannel(channel)) {
				throw error(400, `unknown channel: ${channel}`);
			}

			const project = await getProject(provider, body.id ?? body.slug, projectTypeFor(family));

			if (!project) {
				throw error(404, `${provider} project "${body.slug ?? body.id}" not found`);
			}

			const res = await installFromProvider(cfg, lock, provider, project, family, targets, {
				...(channel ? { channel } : {})
			});

			entryName = res.name;
			holdbacks = res.resolution.holdbacks;
		} else {
			throw error(400, "source must be 'upload', 'pool' or 'provider'");
		}

		await ensureAliases(lock);
		await saveLock(lock);

		const actions = await deploy(cfg, lock, { instances: [name] });

		await ensurePortAllocations(cfg, lock);
		await saveCluster(cfg);
		await saveLock(lock);

		// only now: the new copy is on disk, so removing the old one cannot leave
		// this instance without the addon at all
		let removed: string[] = [];

		if (body.supersede) {
			const outcome = await supersedeAddons(cfg, lock, name, {
				plugins: body.supersede.plugins,
				files: body.supersede.files
			});

			removed = outcome.removed;

			await saveCluster(cfg);
			await saveLock(lock);
		}

		const deployed = actions.filter((action) => action.action !== 'unchanged').length;

		pushEvent(
			name,
			'action',
			`added ${entryName} from ${body.source}` +
				(removed.length ? ` (superseded ${removed.join(', ')})` : '')
		);

		return json({ ok: true, name: entryName, deployed, removed, holdbacks });
	} catch (err) {
		// a SvelteKit HttpError already carries its own status; anything else is a
		// refusal from core and reads as a bad request
		if (err && typeof err === 'object' && 'status' in err) {
			throw err;
		}

		throw error(400, errorMessage(err));
	}
}

/** The family a body names, defaulting to paper and refusing the undeployable one. */
function familyOf(value: unknown): Exclude<PluginFamily, 'universal'> {
	const family = typeof value === 'string' && PLUGIN_FAMILIES.includes(value as PluginFamily)
		? (value as PluginFamily)
		: 'paper';

	// "universal" describes a jar that carries two descriptors; upstream never
	// publishes one, and an upload declares it deliberately on the pool screen
	return family === 'universal' ? 'paper' : family;
}
