// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock } from '$core/config';
import { checkUpdates, assignedVersion } from '$core/plugins';
import { pluginNameOf } from '$core/families';
import { startJob } from '$lib/server/jobs';
import { jsonBody } from '$lib/server/http';

/**
 * POST { names? } → a job resolving to what a `plugins update` would do, without
 * downloading anything.
 *
 * A job rather than a plain request: it is one provider round trip per lock
 * entry, so a full sweep outlasts a request and has live progress worth showing.
 */
export async function POST({ request }) {
	const { names } = await jsonBody(request);

	const job = startJob(
		'plugins-check',
		names?.length ? names.join(', ') : 'every addon',
		'Check for addon updates',
		async (reporter) => {
			const cfg = await loadCluster();
			const lock = await loadLock();
			const { candidates, skipped } = await checkUpdates(cfg, lock, names, { reporter });

			await saveLock(lock); // persist backfilled gameVersions

			return {
				candidates: candidates.map((cand) => ({
					name: cand.name,
					plugin: pluginNameOf(cand.name, cand.entry),
					family: cand.entry.family,
					provider: cand.entry.remote?.provider ?? cand.entry.source,
					installed: cand.entry.installed?.versionNumber ?? null,

					groups: cand.pendingGroups.map((group) => {
						// targets can sit on different versions today, so "current" is a set
						const current = [
							...new Set(
								group.changedTargets.map((target) => assignedVersion(cand.entry, target) ?? '?')
							)
						].join('/');

						return {
							version: group.version.version_number,
							isPrimary: group.isPrimary,
							targets: group.changedTargets.length ? group.changedTargets : group.targets,
							current
						};
					}),

					holdbacks: cand.resolution.holdbacks,
					pinned: cand.resolution.pinned
				})),

				skipped
			};
		}
	);

	return json({ job });
}
