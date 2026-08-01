import { json, error } from '@sveltejs/kit';
import { saveCluster } from '$core/config';
import { getStatus, buildJavaCommand } from '$core/instances';
import { deleteInstance } from '$core/admin';
import { syncVelocityToml } from '$core/proxy';
import {
	loadCluster,
	managedInstances,
	statusJson,
	ensureSampler,
	readHostMemMb,
	pushEvent
} from '$lib/server/mrds';

/** GET → full detail for one instance, including its resolved java command line. */
export async function GET({ params }) {
	ensureSampler();

	const cfg = await loadCluster();
	const inst = managedInstances(cfg)[params.name];

	if (!inst) {
		throw error(404, `unknown instance: ${params.name}`);
	}

	const status = await getStatus(cfg, params.name);

	return json({
		...statusJson(cfg, status),
		javaCommand: buildJavaCommand(cfg, inst),
		java: inst.java ?? null,
		hostMemMb: await readHostMemMb()
	});
}

/** DELETE ?purge=true → deregister, optionally deleting the instance directory. */
export async function DELETE({ params, url }) {
	const cfg = await loadCluster();

	if (params.name === 'proxy') {
		throw error(400, 'cannot delete the proxy');
	}

	if (!cfg.instances[params.name]) {
		throw error(404, `unknown instance: ${params.name}`);
	}

	// external instances run elsewhere, so there is no local state to probe
	const status = cfg.instances[params.name]!.external
		? undefined
		: await getStatus(cfg, params.name);

	if (status && status.state !== 'stopped') {
		throw error(409, `${params.name} is running — stop it first`);
	}

	const purge = url.searchParams.get('purge') === 'true';

	await deleteInstance(cfg, params.name, purge);
	await saveCluster(cfg);

	const sync = await syncVelocityToml(cfg);

	pushEvent(params.name, 'action', `instance deleted${purge ? ' (directory purged)' : ''}`);

	return json({ ok: true, purged: purge, velocityUpdated: sync.changed });
}
