import { json, error } from '@sveltejs/kit';
import { saveCluster } from '$core/config';
import { getStatus, buildJavaCommand } from '$core/instances';
import { deleteInstance } from '$core/admin';
import { syncVelocityToml } from '$core/proxy';
import {
	loadCluster,
	managedInstances,
	instanceStatus,
	readHostMemMb,
	pushEvent
} from '$lib/server/luna';
import { startJob } from '$lib/server/jobs';
import { errorMessage } from '$lib/server/http';

/** GET → full detail for one instance, including its resolved java command line. */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const inst = managedInstances(cfg)[params.name];

	if (!inst) {
		throw error(404, `unknown instance: ${params.name}`);
	}

	return json({
		...(await instanceStatus(params.name)),
		javaCommand: buildJavaCommand(cfg, inst),
		java: inst.java ?? null,
		hostMemMb: await readHostMemMb()
	});
}

/**
 * DELETE ?purge=true → deregister, optionally deleting the instance directory.
 * A purge walks a whole world directory, so this answers with a job whose
 * progress names what is currently being removed.
 */
export async function DELETE({ params, url }) {
	const cfg = await loadCluster();
	const name = params.name;

	if (name === 'proxy') {
		throw error(400, 'cannot delete the proxy');
	}

	if (!cfg.instances[name]) {
		throw error(404, `unknown instance: ${name}`);
	}

	// external instances run elsewhere, so there is no local state to probe
	const status = cfg.instances[name]!.external ? undefined : await getStatus(cfg, name);

	if (status && status.state !== 'stopped') {
		throw error(409, `${name} is running — stop it first`);
	}

	const purge = url.searchParams.get('purge') === 'true';

	// captured before deregistration wipes it — the deleting row still says
	// which machine the purge is running on
	const owner = cfg.instances[name]!.daemon ?? null;

	const job = startJob('instance-delete', name, `Delete ${name}`, async (reporter) => {
		reporter.weighOwn(0);

		const removal = reporter.child('Instance', 4);
		const proxy = reporter.child('Proxy registration', 1);

		try {
			await deleteInstance(cfg, name, purge, removal);
			await saveCluster(cfg);

			const sync = await proxy.task({ start: 'updating velocity.toml' }, async (step) => {
				const out = await syncVelocityToml(cfg);

				step.report(
					1,
					'okay',
					out.changed ? 'velocity.toml updated' : 'velocity.toml already up to date'
				);

				return out;
			});

			pushEvent(name, 'action', `instance deleted${purge ? ' (directory purged)' : ''}`);

			return { purged: purge, velocityUpdated: sync.changed };
		} catch (err) {
			pushEvent(name, 'error', `delete failed: ${errorMessage(err)}`);

			throw err;
		}
	}, { daemon: owner });

	return json({ ok: true, job });
}
