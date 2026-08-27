// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, loadLock, managedInstances } from '$core/config';
import { carriesMcRequirement, entriesOf, familyMatches, familyOf } from '$core/families';
import { getVersionsForEntry, loadersFor, projectTypeFor } from '$core/plugins';
import { coversMc, getProject, getVersions, remoteRefFor } from '$core/services/providers';
import { PLUGIN_FAMILIES } from '$core/types';
import type { PluginFamily, ProviderId } from '$core/types';
import { errorMessage } from '$lib/server/http';

/** How many versions the manual picker offers, newest first. */
const VERSION_LIMIT = 60;

/**
 * GET → the builds a provider offers for one addon, judged against one instance.
 *
 * This is what the add dialog's manual version picker reads. It exists beside
 * `/plugins/pin` because that one identifies its subject by lock entry, and half
 * of this dialog's subjects are not in the lock yet: a provider install being
 * chosen has only a slug. One endpoint serving both shapes keeps the picker's
 * rendering in one place.
 *
 * Query, one of:
 *   ?name=<lock key or plugin name>          a pooled addon
 *   ?provider=&slug=&id?=&family=            a provider project, pooled or not
 * plus ?instance=<name>, which is what `compatible` is judged against: whether
 * each build declares the instance's MC version. Builds that do not are still
 * listed - offering them is the point - just marked.
 */
export async function GET({ url }) {
	const cfg = await loadCluster();
	const instance = url.searchParams.get('instance') ?? '';
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw error(404, `unknown instance: ${instance}`);
	}

	const name = url.searchParams.get('name');

	try {
		let versions;
		let family: PluginFamily;

		if (name) {
			const lock = await loadLock();
			const key = lock.plugins[name] ? name : entriesOf(lock, name)[0];
			const entry = key ? lock.plugins[key] : undefined;

			if (!entry) {
				throw error(404, `unknown plugin: ${name}`);
			}

			if (!entry.remote) {
				throw error(400, 'this addon has no provider to list versions from');
			}

			family = familyOf(entry);
			versions = await getVersionsForEntry(entry);
		} else {
			const familyParam = url.searchParams.get('family') ?? 'paper';

			family =
				PLUGIN_FAMILIES.includes(familyParam as PluginFamily) && familyParam !== 'universal'
					? (familyParam as PluginFamily)
					: 'paper';

			const provider = (url.searchParams.get('provider') ?? 'modrinth') as ProviderId;
			const ref = url.searchParams.get('id') ?? url.searchParams.get('slug') ?? '';
			const project = await getProject(provider, ref, projectTypeFor(family));

			if (!project) {
				throw error(404, `${provider} project "${ref}" not found`);
			}

			versions = await getVersions(remoteRefFor(provider, project), projectTypeFor(family), loadersFor(family));
		}

		// A build with no declared game versions is not judged: nothing to judge by.
		const mc =
			carriesMcRequirement(inst.software) && familyMatches(family, inst.software)
				? inst.mcVersion
				: undefined;

		return json({
			mcVersion: mc ?? null,
			versions: [...versions]
				.sort((a, b) => new Date(b.date_published).getTime() - new Date(a.date_published).getTime())
				.slice(0, VERSION_LIMIT)
				.map((version) => ({
					// the id, not the number, is the unique handle: a project is free to
					// publish one build per MC version all under the same number
					id: version.id,
					versionNumber: version.version_number,
					channel: version.version_type ?? 'release',
					gameVersions: version.game_versions,
					date: version.date_published,
					compatible:
						mc === undefined || version.game_versions.length === 0
							? null
							: coversMc(version.game_versions, mc)
				}))
		});
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) {
			throw err;
		}

		throw error(400, errorMessage(err));
	}
}
