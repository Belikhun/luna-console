// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock, saveCluster } from '$core/config';
import { installFromProvider, deploy, projectTypeFor } from '$core/plugins';
import { getProject, isReleaseChannel } from '$core/services/providers';
import { ensurePortAllocations } from '$core/ports';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';
import type { PluginFamily, ProviderId } from '$core/types';
import { PLUGIN_FAMILIES } from '$core/types';

/**
 * POST { slug, family, targets, provider?, id?, channel? }; `id` is the
 * provider's project id when the picker knows it (some providers cannot look a
 * project up by slug alone).
 *
 * An absent `channel` is not the same as `"release"`: absent lets the installer
 * fall back to beta and then alpha for a project that has never cut a stable
 * release, while an explicit value forbids going past it.
 */
export async function POST({ request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadLock();

	// "universal" is declared by hand on an upload, never chosen for a provider
	// install: upstream publishes one artifact per ecosystem
	const family: Exclude<PluginFamily, 'universal'> =
		PLUGIN_FAMILIES.includes(body.family) && body.family !== 'universal' ? body.family : 'paper';
	const provider = (body.provider ?? 'modrinth') as ProviderId;
	const project = await getProject(provider, body.id ?? body.slug, projectTypeFor(family));

	if (!project) {
		throw error(404, `${provider} project "${body.slug ?? body.id}" not found`);
	}

	const channel = typeof body.channel === 'string' ? body.channel : undefined;

	if (channel !== undefined && !isReleaseChannel(channel)) {
		throw error(400, `unknown channel: ${channel}`);
	}

	try {
		const res = await installFromProvider(cfg, lock, provider, project, family, body.targets, {
			...(channel ? { channel } : {})
		});

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
