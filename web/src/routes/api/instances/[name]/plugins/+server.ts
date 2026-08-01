import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, expandTargets, managedInstances } from '$core/config';
import { assignedVersion } from '$core/plugins';

/** GET → the plugins this instance runs, with the version it actually gets. */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const lock = await loadLock();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	const rows = [];

	for (const [name, entry] of Object.entries(lock.plugins)) {
		if (!expandTargets(cfg, entry.targets).includes(params.name)) {
			continue;
		}

		const version = assignedVersion(entry, params.name);

		rows.push({
			name,
			file: entry.file,
			source: entry.source,
			loader: entry.loader,
			autoUpdate: entry.autoUpdate,
			version: version ?? null,
			pinned: entry.pins?.[params.name] !== undefined,
			variant: version !== undefined && version !== entry.installed?.versionNumber
		});
	}

	return json({ plugins: rows.sort((a, b) => a.name.localeCompare(b.name)) });
}
