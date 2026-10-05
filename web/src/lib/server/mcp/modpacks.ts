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
import { completeProvision, inspectStagedMrpack, installModpack, modpackVersions, searchModpacks, stageMrpackFromUrl, updateModpack } from '$core/modpack';
import type { MrpackSummary } from '$core/modpack';
import { newStageToken } from '$core/world';
import { daemonFetch, pushEvent } from '$lib/server/luna';
import { readUpload } from '$lib/server/agent/uploads';
import { listDaemons } from '$client/daemon';
import { startJob } from '$lib/server/jobs';
import type { JobView } from '$lib/jobs';
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

/**
 * The loader a pack version runs on, so the provisioning row can say what is
 * being laid down before the pack's index has been read; the install itself
 * takes the loader from the index. Undefined when the lookup fails, which
 * leaves the row with the generic label rather than a wrong one.
 */
async function packLoader(slug: string, version: string | undefined): Promise<string | undefined> {
	try {
		const versions = await modpackVersions(slug);
		const pick = version
			? versions.find((entry) => entry.id === version || entry.versionNumber === version)
			: versions.find((entry) => entry.runnable && entry.channel === 'release') ?? versions.find((entry) => entry.runnable);

		return pick?.loaders.find((loader) => ['neoforge', 'forge', 'fabric'].includes(loader));
	} catch {
		return undefined;
	}
}

/** A pack given as a file: staged on the primary, by token, with what its index says. */
interface StagedPack {
	token: string;
	summary: MrpackSummary;
}

/**
 * Put an attached or linked .mrpack into the daemon's staging area. An
 * attachment is streamed there the way the console's upload is (an MCP body
 * is far too small for a pack), a URL is fetched by the daemon itself with
 * every redirect checked; either way the install then takes a token, which a
 * follower can pull. Undefined when the call names neither.
 */
async function stagePack(upload: string | undefined, url: string | undefined): Promise<StagedPack | undefined> {
	if (upload && url) {
		throw new ToolError('give upload or url, not both');
	}

	if (url) {
		try {
			const staged = await stageMrpackFromUrl(url);

			return { token: staged.token, summary: staged.summary };
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	}

	if (!upload) {
		return undefined;
	}

	const staged = await readUpload(upload);

	if (!staged) {
		throw new ToolError('no such attachment, or it expired (attachments live for an hour); ask the operator to attach the file again');
	}

	if (!staged.upload.name.toLowerCase().endsWith('.mrpack')) {
		throw new ToolError(`${staged.upload.name} is not a .mrpack`);
	}

	const token = newStageToken();
	const response = await daemonFetch(`/files/stage/${encodeURIComponent(token)}`, {
		method: 'PUT',
		body: new Blob([staged.bytes as Uint8Array<ArrayBuffer>]),
		headers: { 'content-type': 'application/octet-stream' }
	});

	if (!response.ok) {
		throw new ToolError(`the daemon refused the upload (HTTP ${response.status})`);
	}

	try {
		return { token, summary: await inspectStagedMrpack(token) };
	} catch (err) {
		await daemonFetch(`/files/stage/${encodeURIComponent(token)}`, { method: 'DELETE' }).catch(() => undefined);

		throw new ToolError((err as Error).message);
	}
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
		const upload = optStr(args, 'upload')?.trim() || undefined;
		const url = optStr(args, 'url')?.trim() || undefined;

		if (!/^[a-z0-9_-]+$/.test(name)) {
			throw new ToolError('the instance name must be lowercase letters, digits, - or _');
		}

		if ([slug, upload, url].filter(Boolean).length !== 1) {
			throw new ToolError('name the pack exactly one way: slug, upload or url');
		}

		const cfg = await loadCluster();

		if (cfg.instances[name]) {
			throw new ToolError(`an instance named "${name}" already exists`);
		}

		const daemon = await machineOption(optStr(args, 'machine'));
		const register = optBool(args, 'register') !== false;
		const file = await stagePack(upload, url);
		const loader = file ? file.summary.software : await packLoader(slug, optStr(args, 'version'));
		const label = file ? `${file.summary.name} ${file.summary.versionId}` : slug;

		const job = startJob('modpack-install', name, `Install modpack ${label} as ${name}`, async (reporter) => {
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
					...(file ? { mrpackStage: file.token } : { slug, versionId: optStr(args, 'version') }),
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
		}, { daemon: daemon ?? null, software: loader });

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

		const file = await stagePack(optStr(args, 'upload')?.trim() || undefined, optStr(args, 'url')?.trim() || undefined);

		if (!file && cfg.instances[name]?.modpack?.provider === 'file') {
			throw new ToolError(`${name} was installed from a .mrpack file, so the new version has to come as upload or url`);
		}

		const job = startJob('modpack-update', name, `Update modpack on ${name}`, async (reporter) => {
			const fresh = await loadCluster();

			try {
				const result = await updateModpack(fresh, name, {
					...(file ? { mrpackStage: file.token } : { versionId: optStr(args, 'version') }),
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
