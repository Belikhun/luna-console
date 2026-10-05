// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The addon tools (`addons`, `addons-write` in `$shared/mcptools`): searching
 * providers, reading the pool, and installing, updating, pinning, deploying and
 * removing plugins and mods. Each adapter makes the same bridge calls the
 * plugin routes make (`web/src/routes/api/plugins/**`), in the same order:
 * load the registry and the lock, change them, save, deploy, persist port
 * allocations.
 *
 * The pool is cluster-wide, so a token limited to some instances may read it
 * but not change it: one install can land on every instance a wildcard covers.
 */

import { loadCluster, loadLock, managedInstances, saveCluster, saveLock } from '$core/config';
import {
	checkUpdates,
	deploy,
	getVersionsForEntry,
	installFromProvider,
	loadersFor,
	pinVersion,
	projectTypeFor,
	removePlugin,
	setChannel,
	unpinVersion,
	updatePlugins
} from '$core/plugins';
import type { DeployAction } from '$core/plugins';
import { carriesMcRequirement, effectiveTargets, entriesOf, familyMatches, familyOf, pluginNameOf } from '$core/families';
import { displayNameOf, ensureAliases, pluginUsageReport, removeInstanceJars } from '$core/pluginstate';
import { coversMc, getProject, getVersions, isReleaseChannel, remoteRefFor, searchProvider } from '$core/services/providers';
import type { ReleaseChannel } from '$core/services/providers';
import { ensurePortAllocations } from '$core/ports';
import { getAllStatuses } from '$core/instances';
import { installJar } from '$core/jarinstall';
import type { ClusterConfig, PluginFamily, PluginsLock, ProviderId } from '$core/types';
import { pushEvent } from '$lib/server/luna';
import { readUpload } from '$lib/server/agent/uploads';
import { ToolError } from './errors';
import type { ToolArgs, ToolContext, ToolHandler } from './errors';

/** Versions addon_versions returns, newest first. */
const VERSION_LIMIT = 40;

/** Search hits addon_search returns. */
const SEARCH_LIMIT = 15;

function str(args: ToolArgs, key: string): string {
	return String(args[key] ?? '');
}

function list(args: ToolArgs, key: string): string[] | undefined {
	const value = args[key];

	return Array.isArray(value)
		? value.map(String)
		: undefined;
}

function family(args: ToolArgs, fallback?: PluginFamily): PluginFamily | undefined {
	const value = args.family;

	return typeof value === 'string'
		? (value as PluginFamily)
		: fallback;
}

/** The pool is shared by every instance, so changing it needs a token that reaches all of them. */
function requireWholeCluster(ctx: ToolContext): void {
	if (ctx.principal.scope.instances !== null) {
		throw new ToolError('this token is limited to some instances, and the addon pool is shared by all of them, so it cannot change addons');
	}
}

/** Resolve a plugin name or entry key to an entry key, refusing one the lock does not have. */
function requireEntry(lock: PluginsLock, name: string): string {
	if (lock.plugins[name]) {
		return name;
	}

	const keys = entriesOf(lock, name);

	if (keys.length === 1) {
		return keys[0]!;
	}

	if (keys.length > 1) {
		throw new ToolError(`"${name}" has several builds (${keys.join(', ')}); name one of them`);
	}

	throw new ToolError(`no addon "${name}" in the pool; call addons_list for the names`);
}

/** Deploy, persist, and say what changed and which running servers need a restart to load it. */
async function deployAndReport(
	cfg: ClusterConfig,
	lock: PluginsLock,
	opts: { plugin?: string; instances?: string[] } = {}
): Promise<{ changes: Array<Pick<DeployAction, 'instance' | 'file' | 'action'>>; skipped: Array<Pick<DeployAction, 'instance' | 'file' | 'action'>>; needRestart: string[] }> {
	const actions = await deploy(cfg, lock, opts);

	await ensurePortAllocations(cfg, lock);
	await saveCluster(cfg);
	await saveLock(lock);

	const changed = actions.filter(
		(action) => !['unchanged', 'missing-variant', 'incompatible'].includes(action.action)
	);
	const skipped = actions.filter((action) => ['missing-variant', 'incompatible'].includes(action.action));
	const statuses = await getAllStatuses(cfg);
	const needRestart = [...new Set(changed.map((action) => action.instance))].filter(
		(name) => statuses.find((status) => status.name === name)?.state !== 'stopped'
	);

	const brief = (action: DeployAction) => ({ instance: action.instance, file: action.file, action: action.action });

	return { changes: changed.map(brief), skipped: skipped.map(brief), needRestart };
}

/** Pool and deploy a jar from bytes or a URL; shared by the URL and attachment tools. */
async function installFromBytes(
	args: ToolArgs,
	ctx: ToolContext,
	source: { url?: string; dataBase64?: string; fileName?: string }
): Promise<unknown> {
	requireWholeCluster(ctx);

	const cfg = await loadCluster();
	const lock = await loadLock();
	const result = await installJar(cfg, lock, {
		...source,
		plugin: typeof args.plugin === 'string' && args.plugin ? args.plugin : undefined,
		family: family(args),
		targets: list(args, 'targets') ?? []
	});

	await ensureAliases(lock);
	await saveLock(lock);

	const deployed = await deployAndReport(cfg, lock, { plugin: result.name });

	pushEvent('plugins', 'action', `installed ${result.name} (${ctx.actor})`);

	return {
		name: result.name,
		declared: {
			name: result.inspection.meta.name ?? null,
			version: result.inspection.meta.version ?? null,
			families: result.inspection.families
		},
		file: result.inspection.fileName,
		bytes: result.inspection.size,
		...deployed
	};
}

export const ADDON_HANDLERS: Record<string, ToolHandler> = {
	async addons_list(args) {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const kind = str(args, 'kind');
		const search = str(args, 'search').toLowerCase();

		return Object.entries(lock.plugins)
			.filter(([key, entry]) => {
				const isMod = ['neoforge', 'fabric', 'forge'].includes(familyOf(entry));

				if (kind === 'mods' && !isMod) {
					return false;
				}

				if (kind === 'plugins' && isMod) {
					return false;
				}

				return !search || key.toLowerCase().includes(search) || displayNameOf(key, entry).toLowerCase().includes(search);
			})
			.map(([key, entry]) => ({
				key,
				name: displayNameOf(key, entry),
				family: familyOf(entry),
				source: entry.remote?.provider ?? entry.source,
				version: entry.installed?.versionNumber ?? null,
				targets: entry.targets,
				deployedTo: effectiveTargets(cfg, lock, key),
				autoUpdate: entry.autoUpdate,
				channel: entry.channel ?? 'release',
				pins: entry.pins && Object.keys(entry.pins).length ? entry.pins : undefined
			}));
	},

	async addon_info(args) {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = str(args, 'name');
		const plugin = lock.plugins[name]
			? pluginNameOf(name, lock.plugins[name]!)
			: name;
		const keys = entriesOf(lock, plugin);

		if (!keys.length) {
			throw new ToolError(`no addon "${name}" in the pool; call addons_list for the names`);
		}

		return {
			plugin,
			builds: keys.map((key) => {
				const entry = lock.plugins[key]!;

				return {
					key,
					family: familyOf(entry),
					name: displayNameOf(key, entry),
					description: entry.meta?.description ?? null,
					source: entry.remote?.provider ?? entry.source,
					project: entry.remote?.slug ?? null,
					version: entry.installed?.versionNumber ?? null,
					gameVersions: entry.installed?.gameVersions ?? [],
					variants: Object.values(entry.variants ?? {}).map((variant) => ({
						version: variant.versionNumber,
						gameVersions: variant.gameVersions ?? []
					})),
					pins: entry.pins ?? {},
					targets: entry.targets,
					autoUpdate: entry.autoUpdate,
					channel: entry.channel ?? 'release'
				};
			}),
			usage: pluginUsageReport(cfg, lock, plugin).map((row) => ({
				instance: row.instance,
				build: row.entry,
				version: row.version,
				pinned: row.pinned || undefined,
				disabled: row.disabled || undefined,
				via: row.origin
			}))
		};
	},

	async addon_search(args) {
		const fam = family(args, 'paper')!;
		const provider = (str(args, 'provider') || 'modrinth') as ProviderId;
		const hits = await searchProvider(provider, str(args, 'query'), projectTypeFor(fam), loadersFor(fam));

		return hits.slice(0, SEARCH_LIMIT).map((hit) => ({
			slug: hit.slug,
			id: hit.project_id,
			title: hit.title,
			description: hit.description,
			downloads: hit.downloads,
			gameVersions: hit.versions?.slice(-6),
			provider
		}));
	},

	async addon_versions(args) {
		const cfg = await loadCluster();
		const instance = str(args, 'instance');
		const inst = managedInstances(cfg)[instance];

		if (!inst) {
			throw new ToolError(`unknown instance "${instance}"; call cluster_status for the list`);
		}

		let versions;
		let fam: PluginFamily;

		if (typeof args.name === 'string' && args.name) {
			const lock = await loadLock();
			const entry = lock.plugins[requireEntry(lock, args.name)]!;

			if (!entry.remote) {
				throw new ToolError('this addon was not installed from a provider, so there are no versions to list');
			}

			fam = familyOf(entry);
			versions = await getVersionsForEntry(entry);
		} else {
			fam = family(args, 'paper')!;

			const provider = (str(args, 'provider') || 'modrinth') as ProviderId;
			const project = await getProject(provider, str(args, 'slug'), projectTypeFor(fam));

			if (!project) {
				throw new ToolError(`${provider} has no project "${str(args, 'slug')}"`);
			}

			versions = await getVersions(remoteRefFor(provider, project), projectTypeFor(fam), loadersFor(fam));
		}

		const mc = carriesMcRequirement(inst.software) && familyMatches(fam, inst.software)
			? inst.mcVersion
			: undefined;

		return {
			instance,
			mcVersion: mc ?? null,
			versions: [...versions]
				.sort((left, right) => new Date(right.date_published).getTime() - new Date(left.date_published).getTime())
				.slice(0, VERSION_LIMIT)
				.map((version) => ({
					id: version.id,
					version: version.version_number,
					channel: version.version_type ?? 'release',
					gameVersions: version.game_versions,
					date: version.date_published,
					compatible: mc === undefined || version.game_versions.length === 0
						? null
						: coversMc(version.game_versions, mc)
				}))
		};
	},

	async addon_check_updates(args) {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const { candidates, skipped } = await checkUpdates(cfg, lock, list(args, 'names'));

		await saveLock(lock);

		return {
			updates: candidates.map((candidate) => ({
				key: candidate.name,
				installed: candidate.entry.installed?.versionNumber ?? null,
				moves: candidate.pendingGroups.map((group) => ({
					to: group.version.version_number,
					targets: group.changedTargets.length ? group.changedTargets : group.targets
				})),
				holdbacks: candidate.resolution.holdbacks,
				pinned: candidate.resolution.pinned
			})),
			skipped
		};
	},

	async addon_install(args, ctx) {
		requireWholeCluster(ctx);

		const fam = family(args, 'paper')!;

		if (fam === 'universal') {
			throw new ToolError('providers publish one build per platform; pick paper or velocity rather than universal');
		}

		const provider = (str(args, 'provider') || 'modrinth') as ProviderId;
		const project = await getProject(provider, str(args, 'slug'), projectTypeFor(fam));

		if (!project) {
			throw new ToolError(`${provider} has no project "${str(args, 'slug')}"; try addon_search`);
		}

		const channel = typeof args.channel === 'string'
			? args.channel as ReleaseChannel
			: undefined;
		const cfg = await loadCluster();
		const lock = await loadLock();
		const result = await installFromProvider(cfg, lock, provider, project, fam, list(args, 'targets') ?? [], {
			...(channel ? { channel } : {})
		});

		await saveLock(lock);

		const deployed = await deployAndReport(cfg, lock, { plugin: result.name });

		pushEvent('plugins', 'action', `installed ${result.name} (${ctx.actor})`);

		return {
			name: result.name,
			versions: result.resolution.groups.map((group) => ({
				version: group.version.version_number,
				targets: group.targets
			})),
			holdbacks: result.resolution.holdbacks,
			...deployed
		};
	},

	async addon_install_url(args, ctx) {
		return await installFromBytes(args, ctx, { url: str(args, 'url') });
	},

	async addon_install_upload(args, ctx) {
		const staged = await readUpload(str(args, 'upload'));

		if (!staged) {
			throw new ToolError('that attachment is unknown or expired (attachments last an hour); ask the operator to attach the file again');
		}

		return await installFromBytes(args, ctx, {
			dataBase64: Buffer.from(staged.bytes).toString('base64'),
			fileName: staged.upload.name
		});
	},

	async addon_configure(args, ctx) {
		requireWholeCluster(ctx);

		const cfg = await loadCluster();
		const lock = await loadLock();
		const key = requireEntry(lock, str(args, 'name'));
		const entry = lock.plugins[key]!;
		const before = effectiveTargets(cfg, lock, key);

		if (typeof args.autoUpdate === 'boolean') {
			entry.autoUpdate = args.autoUpdate;
		}

		if (typeof args.channel === 'string') {
			if (!isReleaseChannel(args.channel)) {
				throw new ToolError(`unknown channel "${args.channel}"`);
			}

			setChannel(lock, key, args.channel);
		}

		const targets = list(args, 'targets');
		const removed: string[] = [];

		if (targets) {
			entry.targets = targets;

			// deploy only adds, so instances the new targets no longer cover are
			// cleared here, or the jar would stay behind on them
			const after = new Set(effectiveTargets(cfg, lock, key));

			for (const instance of before.filter((name) => !after.has(name))) {
				removed.push(...(await removeInstanceJars(cfg, lock, instance, pluginNameOf(key, entry))).map((file) => `${instance}/${file}`));
			}
		}

		await saveLock(lock);

		const deployed = await deployAndReport(cfg, lock, { plugin: key });

		pushEvent('plugins', 'action', `configured ${key} (${ctx.actor})`);

		return {
			key,
			targets: entry.targets,
			deployedTo: effectiveTargets(cfg, lock, key),
			autoUpdate: entry.autoUpdate,
			channel: entry.channel ?? 'release',
			removed,
			...deployed
		};
	},

	async addon_update(args, ctx) {
		requireWholeCluster(ctx);

		const cfg = await loadCluster();
		const lock = await loadLock();
		const deployAfter = args.deploy !== false;
		const outcome = await updatePlugins(cfg, lock, { names: list(args, 'names'), deploy: deployAfter });

		await saveLock(lock);
		await saveCluster(cfg);

		if (outcome.applied.length) {
			pushEvent('plugins', 'action', `updated ${[...new Set(outcome.applied.map((entry) => entry.name))].join(', ')} (${ctx.actor})`);
		}

		const statuses = await getAllStatuses(cfg);
		const changed = outcome.actions.filter((action) => action.action === 'updated' || action.action === 'installed');

		return {
			applied: outcome.applied,
			deployed: deployAfter,
			needRestart: [...new Set(changed.map((action) => action.instance))].filter(
				(name) => statuses.find((status) => status.name === name)?.state !== 'stopped'
			)
		};
	},

	async addon_pin(args, ctx) {
		requireWholeCluster(ctx);

		const cfg = await loadCluster();
		const lock = await loadLock();
		const key = requireEntry(lock, str(args, 'name'));
		const result = await pinVersion(cfg, lock, key, str(args, 'version'), list(args, 'targets') ?? [], args.force === true);

		await saveLock(lock);

		const deployed = await deployAndReport(cfg, lock, { plugin: key });

		pushEvent('plugins', 'action', `pinned ${key}@${result.version.version_number} (${ctx.actor})`);

		return { key, version: result.version.version_number, incompatible: result.incompatible, ...deployed };
	},

	async addon_unpin(args, ctx) {
		requireWholeCluster(ctx);

		const cfg = await loadCluster();
		const lock = await loadLock();
		const key = requireEntry(lock, str(args, 'name'));
		const unpinned = unpinVersion(cfg, lock, key, list(args, 'targets'));

		await saveLock(lock);

		const deployed = await deployAndReport(cfg, lock, { plugin: key });

		return { key, unpinned, ...deployed };
	},

	async addon_deploy(args, ctx) {
		requireWholeCluster(ctx);

		const cfg = await loadCluster();
		const lock = await loadLock();
		const name = typeof args.name === 'string' && args.name
			? requireEntry(lock, args.name)
			: undefined;

		return await deployAndReport(cfg, lock, { plugin: name, instances: list(args, 'instances') });
	},

	async addon_remove(args, ctx) {
		requireWholeCluster(ctx);

		const cfg = await loadCluster();
		const lock = await loadLock();
		const key = requireEntry(lock, str(args, 'name'));
		const from = list(args, 'from');
		const result = await removePlugin(cfg, lock, key, from?.length ? from : undefined);

		await saveLock(lock);

		pushEvent('plugins', 'action', `removed ${key} from ${result.deletedFrom.join(',') || '(none)'}${result.entryRemoved ? ' + pool' : ''} (${ctx.actor})`);

		return { key, removedFrom: result.deletedFrom, droppedFromPool: result.entryRemoved };
	}
};
