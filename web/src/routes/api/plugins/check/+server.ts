import { json } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock } from '$core/config';
import { checkUpdates, assignedVersion } from '$core/plugins';
import { jsonBody } from '$lib/server/http';

/** POST { names? } → what a `plugins update` would do, without downloading. */
export async function POST({ request }) {
	const { names } = await jsonBody(request);
	const cfg = await loadCluster();
	const lock = await loadLock();
	const { candidates, skipped } = await checkUpdates(cfg, lock, names);

	await saveLock(lock); // persist backfilled gameVersions

	return json({
		candidates: candidates.map((cand) => ({
			name: cand.name,

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
	});
}
