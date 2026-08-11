// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, saveCluster, loadLock, saveLock } from '$core/config';
import { createInstance, ensureForwardingMod } from '$core/admin';
import { deploy } from '$core/plugins';
import { ensurePortAllocations } from '$core/ports';
import { syncVelocityToml } from '$core/proxy';
import {
	parseJavaAgents,
	parseJavaArgs,
	validateJavaAgents,
	validateJavaArgs,
	validateSettings
} from '$core/settings';
import { validateRuntimeId } from '$core/runtimes';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { applyAddonGroups } from '$core/addons';
import { SOFTWARE_IDS, hasProvider } from '$core/software';
import type { Software } from '$core/types';
import { listStatuses, pushEvent } from '$lib/server/luna';
import { listJobs, startJob } from '$lib/server/jobs';
import { errorMessage } from '$lib/server/http';

/**
 * A placeholder row for an instance that only exists as a running job; a
 * create that has not registered yet, or a purge outliving the registry entry.
 */
function ghostRow(
	name: string,
	state: 'provisioning' | 'deleting',
	daemon: string | null,
	software = 'paper'
): Record<string, unknown> {
	return {
		name,
		state,
		software,
		mcVersion: null,
		port: null,
		address: null,
		memory: '',
		profile: '',
		javaPid: null,
		uptimeMs: null,
		players: null,
		pingVersion: null,
		cpu: null,
		rssMb: null,
		tps: null,
		heapUsedMb: null,
		heapMaxMb: null,
		lunaStatus: null,
		lunaDisplayName: null,
		lastHeartbeatMs: null,
		ports: {},
		proxy: null,
		external: null,
		daemon,
		dir: '',
		checks: []
	};
}

/**
 * GET → live status of every instance, for the instances table. Rows caught
 * mid-provision or mid-delete are overlaid with that transient state, so every
 * open console sees the transition; not just the browser that started it.
 */
export async function GET() {
	const data = (await listStatuses()) as { instances: Array<Record<string, unknown>> };

	const running = (kind: string) => listJobs(kind).filter((job) => job.state === 'running');

	const creating = running('instance-create');
	const deleting = running('instance-delete');

	for (const row of data.instances) {
		if (deleting.some((job) => job.target === row.name)) {
			row.state = 'deleting';
		} else if (creating.some((job) => job.target === row.name)) {
			row.state = 'provisioning';
		}
	}

	for (const job of creating) {
		if (job.target && !data.instances.some((row) => row.name === job.target)) {
			// the job's meta names the target machine and the software being laid
			// down; nothing else knows either until the registry entry exists
			const daemon = (job.meta?.daemon as string | null) ?? null;
			const software = (job.meta?.software as string | undefined) ?? 'paper';

			data.instances.push(ghostRow(job.target, 'provisioning', daemon, software));
		}
	}

	for (const job of deleting) {
		if (job.target && !data.instances.some((row) => row.name === job.target)) {
			const daemon = (job.meta?.daemon as string | null) ?? null;

			data.instances.push(ghostRow(job.target, 'deleting', daemon));
		}
	}

	return json(data);
}

/**
 * POST { name, software?, mcVersion?, loaderVersion?, memory?, profile?, port?,
 * register?, settings?, javaArgs?, addonGroups?, pluginOverrides?, daemon? }
 *
 * Creation lives on the collection, never at /api/instances/create: a static
 * segment there outranks [name], so the cluster's real `create` instance would
 * be unreachable; any verb-named route under this one is the same trap.
 *
 * Creating an instance downloads a server jar, so it answers with a job id
 * instead of blocking: the client watches /api/jobs/<id>?stream for the same
 * progress tree the CLI renders. Anything cheap enough to check up front -
 * setting values, JVM flags; is rejected here, so the client gets a 400 rather
 * than a job that fails a second later.
 */
export async function POST({ request }) {
	const body = await request.json();
	const settings: Record<string, string> = body.settings ?? {};
	const javaArgs = Array.isArray(body.javaArgs)
		? body.javaArgs.map(String)
		: parseJavaArgs(String(body.javaArgs ?? ''));
	const javaAgents = Array.isArray(body.javaAgents)
		? body.javaAgents.map(String)
		: parseJavaAgents(String(body.javaAgents ?? ''));

	if (typeof body.name !== 'string' || !body.name) {
		throw error(400, 'name required');
	}

	if (typeof body.mcVersion !== 'string' || !body.mcVersion) {
		throw error(400, 'mcVersion required');
	}

	const software = (body.software ? String(body.software) : 'paper') as Software;

	if (!SOFTWARE_IDS.includes(software)) {
		throw error(400, `unknown software: ${software}`);
	}

	if (!hasProvider(software)) {
		throw error(409, `${software} has no download provider; it can only be adopted`);
	}

	const badSettings = validateSettings(settings);

	if (badSettings.length) {
		throw error(400, badSettings.map((problem) => problem.error).join('; '));
	}

	const badArgs = validateJavaArgs(javaArgs);

	if (badArgs) {
		throw error(400, badArgs);
	}

	const badAgents = validateJavaAgents(javaAgents);

	if (badAgents) {
		throw error(400, badAgents);
	}

	const runtime = body.runtime ? String(body.runtime) : undefined;
	const badRuntime = runtime ? validateRuntimeId(runtime) : undefined;

	if (badRuntime) {
		throw error(400, badRuntime);
	}

	if (Array.isArray(body.addonGroups) && body.addonGroups.length) {
		const lock = await loadLock();
		const unknown = body.addonGroups.filter((name: string) => !lock.groups?.[name]);

		if (unknown.length) {
			throw error(400, `unknown addon group(s): ${unknown.join(', ')}`);
		}
	}

	const register = body.register !== false;

	// the target machine rides on the job, so the provisioning row can say where
	// the instance is going before it exists in any registry
	const targetDaemon = typeof body.daemon === 'string' && body.daemon ? body.daemon : null;

	const job = startJob('instance-create', body.name, `Create ${body.name}`, async (reporter) => {
		const cfg = await loadCluster();
		const lock = await loadLock();

		// same phase weighting as the CLI: the jar download dominates the wall clock
		reporter.weighOwn(0);

		const files = reporter.child('Server files', 6);
		const plugins = reporter.child('Plugins', 2);
		const packs = reporter.child('Packs', 1);
		const ports = reporter.child('Port allocations', 1);
		const proxy = reporter.child('Proxy registration', 1);

		let forwarding: { installed: boolean; slug?: string; required: string[] } = { installed: false, required: [] };

		try {
			const res = await createInstance(cfg, body.name, {
				software,
				mcVersion: body.mcVersion,
				loaderVersion: body.loaderVersion ? String(body.loaderVersion) : undefined,
				memory: body.memory || undefined,
				profile: body.profile || undefined,
				port: body.port ? Number(body.port) : undefined,
				register,
				settings,
				javaArgs,
				javaAgents,
				autoRestart: body.autoRestart === undefined ? undefined : !!body.autoRestart,
				restartDelay:
					body.restartDelay === undefined ? undefined : Number(body.restartDelay),
				runtime,
				addonGroups: Array.isArray(body.addonGroups) ? body.addonGroups.map(String) : undefined,
				pluginOverrides:
					body.pluginOverrides && typeof body.pluginOverrides === 'object'
						? Object.fromEntries(
								Object.entries(body.pluginOverrides).map(([key, value]) => [key, !!value])
							)
						: undefined,
				daemon: targetDaemon ?? undefined,
				reporter: files
			});

			await saveCluster(cfg);

			// wildcard-targeted plugins apply to the new instance right away
			const deployed = await plugins.task(
				{ start: 'deploying wildcard-targeted plugins' },
				async (step) => {
					// a mod loader cannot speak modern forwarding on its own; the mod
					// that lets it is pooled here so the same deploy carries it in
					forwarding = await ensureForwardingMod(cfg, lock, body.name);
					await saveLock(lock);

					return await deploy(cfg, lock, { instances: [body.name], reporter: step });
				}
			);

			const changed = deployed.filter((action) => action.action !== 'unchanged').length;

			plugins.complete(
				deployed.length ? `${changed} of ${deployed.length} jar(s) changed` : 'none target this instance'
			);

			// the group's other two kinds: resource pack rules the proxy reads, and
			// the data packs the new world starts with
			await packs.task({ start: 'applying addon group packs' }, async (step) => {
				const packsLock = await loadPacksLock();
				const applied = await applyAddonGroups(cfg, packsLock, lock.groups, {
					instances: [body.name]
				});

				await savePacksLock(packsLock);

				const installed = applied.datapacks.filter(
					(action) => action.action !== 'unchanged'
				).length;

				step.report(
					1,
					'okay',
					installed || applied.respacks.length
						? `${applied.respacks.length} pack rule(s), ${installed} data pack(s)`
						: 'no packs for this instance'
				);
			});

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
							? 'velocity.toml updated; reload the proxy to apply'
							: 'velocity.toml already up to date'
					);
				});
			} else {
				proxy.complete('not registered; standalone instance');
			}

			pushEvent(
				body.name,
				'action',
				`instance created (${software} ${res.build.mcVersion ?? body.mcVersion}, port ${res.port})`
			);

			return {
				name: res.name,
				port: res.port,
				build: res.build.buildId,
				forwardingMod: forwarding.slug ?? null,
				requiredAddons: forwarding.required,
				pluginsDeployed: changed,
				velocityUpdated
			};
		} catch (err) {
			pushEvent(body.name, 'error', `create failed: ${errorMessage(err)}`);

			throw err;
		}
	}, { daemon: targetDaemon, software });

	return json({ ok: true, job });
}
