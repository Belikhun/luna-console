import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock } from '$core/config';
import { pinVersion, getVersionsForEntry } from '$core/plugins';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/** How many versions the pin dialog offers — the list is newest-first. */
const VERSION_LIMIT = 40;

/** GET ?name= — list available provider versions for the pin dialog */
export async function GET({ url }) {
	const name = url.searchParams.get('name');

	if (!name) {
		throw error(400, 'name required');
	}

	const lock = await loadLock();
	const entry = lock.plugins[name];

	if (!entry?.remote) {
		throw error(400, 'this plugin has no provider');
	}

	const versions = await getVersionsForEntry(entry);

	return json({
		versions: versions.slice(0, VERSION_LIMIT).map((version) => ({
			versionNumber: version.version_number,
			channel: version.version_type,
			gameVersions: version.game_versions,
			date: version.date_published
		}))
	});
}

/** POST { name, version, targets, force? } */
export async function POST({ request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadLock();

	try {
		const res = await pinVersion(cfg, lock, body.name, body.version, body.targets, !!body.force);

		await saveLock(lock);

		pushEvent(
			'plugins',
			'action',
			`pinned ${body.name}@${res.version.version_number} on ${body.targets.join(',')}`
		);

		return json({
			ok: true,
			version: res.version.version_number,
			incompatible: res.incompatible
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
