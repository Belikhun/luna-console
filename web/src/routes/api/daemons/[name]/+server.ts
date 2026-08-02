import { json, error } from '@sveltejs/kit';

import { loadCluster, saveCluster } from '$core/config';
import { listDaemons } from '$client/daemon';
import { pushEvent } from '$lib/server/mrds';

/** DELETE → drop a follower daemon's registration (must be offline and own nothing). */
export async function DELETE({ params }) {
	const cfg = await loadCluster();
	const name = params.name;

	if (!cfg.daemons?.[name]) {
		throw error(404, `unknown daemon: ${name}`);
	}

	const live = (await listDaemons()).find((row) => row.name === name);

	if (live?.online) {
		throw error(409, `daemon "${name}" is currently connected — stop it first`);
	}

	const owned = Object.entries(cfg.instances)
		.filter(([, inst]) => inst.daemon === name)
		.map(([instName]) => instName);

	if (owned.length > 0) {
		throw error(409, `daemon "${name}" still owns ${owned.join(', ')} — reassign or delete those instances first`);
	}

	delete cfg.daemons[name];
	await saveCluster(cfg);

	pushEvent('daemon', 'action', `daemon registration "${name}" removed`);

	return json({ ok: true });
}
