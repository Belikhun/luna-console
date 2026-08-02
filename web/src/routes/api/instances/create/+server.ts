import { json, error } from '@sveltejs/kit';
import { loadCluster, saveCluster, loadLock, saveLock } from '$core/config';
import { createInstance } from '$core/admin';
import { deploy } from '$core/plugins';
import { ensurePortAllocations } from '$core/ports';
import { syncVelocityToml } from '$core/proxy';
import { parseJavaArgs, validateJavaArgs, validateSettings } from '$core/settings';
import { pushEvent } from '$lib/server/mrds';
import { startJob } from '$lib/server/jobs';
import { errorMessage } from '$lib/server/http';

/**
 * POST { name, mcVersion, memory?, profile?, port?, register?, settings?, javaArgs? }
 *
 * Creating an instance downloads a server jar, so it answers with a job id
 * instead of blocking: the client watches /api/jobs/<id>?stream for the same
 * progress tree the CLI renders. Anything cheap enough to check up front —
 * setting values, JVM flags — is rejected here, so the client gets a 400 rather
 * than a job that fails a second later.
 */
export async function POST({ request }) {
	const body = await request.json();
	const settings: Record<string, string> = body.settings ?? {};
	const javaArgs = Array.isArray(body.javaArgs)
		? body.javaArgs.map(String)
		: parseJavaArgs(String(body.javaArgs ?? ''));

	if (typeof body.name !== 'string' || !body.name) {
		throw error(400, 'name required');
	}

	if (typeof body.mcVersion !== 'string' || !body.mcVersion) {
		throw error(400, 'mcVersion required');
	}

	const badSettings = validateSettings(settings);

	if (badSettings.length) {
		throw error(400, badSettings.map((problem) => problem.error).join('; '));
	}

	const badArgs = validateJavaArgs(javaArgs);

	if (badArgs) {
		throw error(400, badArgs);
	}

	if (Array.isArray(body.pluginGroups) && body.pluginGroups.length) {
		const lock = await loadLock();
		const unknown = body.pluginGroups.filter((name: string) => !lock.groups?.[name]);

		if (unknown.length) {
			throw error(400, `unknown plugin group(s): ${unknown.join(', ')}`);
		}
	}

	const register = body.register !== false;

	const job = startJob('instance-create', body.name, `Create ${body.name}`, async (reporter) => {
		const cfg = await loadCluster();
		const lock = await loadLock();

		// same phase weighting as the CLI: the jar download dominates the wall clock
		reporter.weighOwn(0);

		const files = reporter.child('Server files', 6);
		const plugins = reporter.child('Plugins', 2);
		const ports = reporter.child('Port allocations', 1);
		const proxy = reporter.child('Proxy registration', 1);

		try {
			const res = await createInstance(cfg, body.name, {
				mcVersion: body.mcVersion,
				memory: body.memory || undefined,
				profile: body.profile || undefined,
				port: body.port ? Number(body.port) : undefined,
				register,
				settings,
				javaArgs,
				pluginGroups: Array.isArray(body.pluginGroups) ? body.pluginGroups.map(String) : undefined,
				pluginOverrides:
					body.pluginOverrides && typeof body.pluginOverrides === 'object'
						? Object.fromEntries(
								Object.entries(body.pluginOverrides).map(([key, value]) => [key, !!value])
							)
						: undefined,
				daemon: typeof body.daemon === 'string' && body.daemon ? body.daemon : undefined,
				reporter: files
			});

			await saveCluster(cfg);

			// wildcard-targeted plugins apply to the new instance right away
			const deployed = await plugins.task(
				{ start: 'deploying wildcard-targeted plugins' },
				(step) => deploy(cfg, lock, { instances: [body.name], reporter: step })
			);

			const changed = deployed.filter((action) => action.action !== 'unchanged').length;

			plugins.complete(
				deployed.length ? `${changed} of ${deployed.length} jar(s) changed` : 'none target this instance'
			);

			await ports.task({ start: 'allocating plugin ports', done: 'plugin ports allocated' }, async () => {
				await ensurePortAllocations(cfg, lock);
				await saveCluster(cfg);
				await saveLock(lock);
			});

			let velocityUpdated = false;

			if (register) {
				await proxy.task({ start: 'registering in velocity.toml' }, async (step) => {
					velocityUpdated = (await syncVelocityToml(cfg)).changed;

					step.report(
						1,
						'okay',
						velocityUpdated
							? 'velocity.toml updated — reload the proxy to apply'
							: 'velocity.toml already up to date'
					);
				});
			} else {
				proxy.complete('not registered — standalone instance');
			}

			pushEvent(body.name, 'action', `instance created (paper ${body.mcVersion}, port ${res.port})`);

			return {
				name: res.name,
				port: res.port,
				build: res.build.build,
				pluginsDeployed: changed,
				velocityUpdated
			};
		} catch (err) {
			pushEvent(body.name, 'error', `create failed: ${errorMessage(err)}`);

			throw err;
		}
	});

	return json({ ok: true, job });
}
