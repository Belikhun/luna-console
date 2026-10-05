// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The modpack tools (in `addons` / `addons-write`): searching Modrinth for
 * packs, listing a pack's versions, provisioning an instance from one and
 * moving an instance to another version. Install and update run as console
 * jobs, like the install route does, so the provisioning row shows on every
 * open console; the call then waits on the job for as long as a tool call can
 * reasonably hold, and otherwise hands back the job id.
 */

import { loadCluster, loadLock, saveCluster } from '$core/config';
import { completeProvision, installModpack, modpackVersions, searchModpacks, updateModpack } from '$core/modpack';
import { listDaemons } from '$client/daemon';
import { startJob } from '$lib/server/jobs';
import type { JobView } from '$lib/jobs';
import { pushEvent } from '$lib/server/luna';
import { optBool, optInt, optStr, requireWholeCluster, str } from './args';
import { ToolError } from './errors';
import type { ToolHandler } from './errors';
import { awaitJob } from './jobs';

/** How long a call waits on the job before answering with "still running". */
const JOB_WAIT_MS = 10 * 60 * 1000;

/** Search hits modpack_search returns. */
const SEARCH_LIMIT = 15;

/** The job's outcome as a tool result: its return value, its error, or the fact that it is still going. */
function settle(job: JobView, stillRunning: string): unknown {
	if (job.state === 'running') {
		return { running: true, job: job.id, note: stillRunning };
	}

	if (job.state === 'failed') {
		throw new ToolError(job.error ?? 'the job failed');
	}

	return job.result ?? { done: true, job: job.id };
}

/** The daemon name as a machine option: the primary's own name means "here". */
async function machineOption(name: string | undefined): Promise<string | undefined> {
	if (!name || name === 'primary') {
		return undefined;
	}

	const rows = await listDaemons();
	const row = rows.find((daemon) => daemon.name === name);

	if (!row) {
		throw new ToolError(`unknown machine "${name}"; call fleet_status for the names`);
	}

	return row.mode === 'primary'
		? undefined
		: name;
}

export const MODPACK_HANDLERS: Record<string, ToolHandler> = {
	async modpack_search(args) {
		const loader = optStr(args, 'loader');

		try {
			const hits = await searchModpacks(str(args, 'query'), loader ? [loader] : undefined);

			return hits.slice(0, SEARCH_LIMIT);
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	},

	async modpack_versions(args) {
		try {
			return await modpackVersions(str(args, 'slug'));
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	},

	async modpack_install(args, ctx) {
		requireWholeCluster(ctx, 'the instance list');

		const name = str(args, 'name').trim();
		const slug = str(args, 'slug').trim();

		if (!/^[a-z0-9_-]+$/.test(name)) {
			throw new ToolError('the instance name must be lowercase letters, digits, - or _');
		}

		const cfg = await loadCluster();

		if (cfg.instances[name]) {
			throw new ToolError(`an instance named "${name}" already exists`);
		}

		const daemon = await machineOption(optStr(args, 'machine'));
		const register = optBool(args, 'register') !== false;

		const job = startJob('modpack-install', name, `Install modpack ${slug} as ${name}`, async (reporter) => {
			const fresh = await loadCluster();
			const lock = await loadLock();

			reporter.weighOwn(0);

			const pack = reporter.child('Modpack', 10);
			const plugins = reporter.child('Plugins', 2);
			const packs = reporter.child('Packs', 1);
			const ports = reporter.child('Port allocations', 1);
			const proxy = reporter.child('Proxy registration', 1);

			try {
				const result = await installModpack(fresh, name, {
					slug,
					versionId: optStr(args, 'version'),
					memory: optStr(args, 'memory'),
					port: optInt(args, 'port'),
					profile: optStr(args, 'profile'),
					daemon,
					register,
					skipOptional: optBool(args, 'skipOptional') === true,
					reporter: pack
				});

				await saveCluster(fresh);

				const outcome = await completeProvision(fresh, lock, name, { plugins, packs, ports, proxy }, register);

				pushEvent(name, 'action', `instance created from modpack ${result.modpack.name} ${result.modpack.versionNumber} by ${ctx.actor}`);

				return {
					instance: name,
					software: result.software,
					mcVersion: result.mcVersion,
					loaderVersion: result.loaderVersion ?? null,
					port: result.port,
					modpack: result.modpack,
					packFiles: result.files,
					overrides: result.overrides,
					clientOnlySkipped: result.clientOnly,
					launchFilesSkipped: result.skipped,
					removed: result.removed,
					clientOverridesSkipped: result.clientOverrides,
					poolCopiesWithheld: result.withheld,
					dependenciesFetched: result.rescued,
					dependenciesUnresolved: result.unresolved,
					forwardingMod: outcome.forwarding.slug ?? null,
					addonsDeployed: outcome.pluginsChanged,
					velocityUpdated: outcome.velocityUpdated,
					note: result.unresolved.length > 0
						? `the server mods need ${result.unresolved.join(', ')}, which neither the pack nor Modrinth supplied; the server will not start until they are added (addon_install can add a mod by slug)`
						: 'the server is created but not started; instance_start it, then read instance_logs for the first boot'
				};
			} catch (err) {
				pushEvent(name, 'error', `modpack install failed: ${(err as Error).message}`);

				throw err;
			}
		}, { daemon: daemon ?? null, software: 'modpack' });

		return settle(await awaitJob(job, JOB_WAIT_MS), 'still installing; the pack is large. Check cluster_status for the new instance in a few minutes, or cluster_events for a failure');
	},

	async modpack_update(args, ctx) {
		const name = str(args, 'instance');
		const cfg = await loadCluster();

		if (!cfg.instances[name]) {
			throw new ToolError(`unknown instance "${name}"; call cluster_status for the list`);
		}

		if (!cfg.instances[name]?.modpack) {
			throw new ToolError(`${name} was not created from a modpack, so there is no pack to update`);
		}

		const job = startJob('modpack-update', name, `Update modpack on ${name}`, async (reporter) => {
			const fresh = await loadCluster();

			try {
				const result = await updateModpack(fresh, name, {
					versionId: optStr(args, 'version'),
					force: optBool(args, 'force') === true,
					skipOptional: optBool(args, 'skipOptional') === true,
					reporter
				});

				await saveCluster(fresh);
				pushEvent(name, 'action', `modpack moved to ${result.to.versionNumber} by ${ctx.actor}`);

				return {
					instance: name,
					from: result.from?.versionNumber ?? null,
					to: result.to.versionNumber,
					versionChanged: result.versionChanged,
					mcVersion: result.mcVersion,
					loaderVersion: result.loaderVersion,
					packFiles: result.files,
					overrides: result.overrides,
					staleRemoved: result.removed,
					launchFilesSkipped: result.skipped,
					poolCopiesWithheld: result.withheld,
					dependenciesFetched: result.rescued,
					dependenciesUnresolved: result.unresolved,
					note: 'start the server with instance_start and read instance_logs for the first boot on the new version'
				};
			} catch (err) {
				pushEvent(name, 'error', `modpack update failed: ${(err as Error).message}`);

				throw err;
			}
		});

		return settle(await awaitJob(job, JOB_WAIT_MS), 'still updating; check cluster_events in a few minutes');
	}
};
