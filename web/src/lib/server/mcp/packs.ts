// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The pack tools (`packs`, `packs-write` in `$shared/mcptools`): resource packs
 * luna-pack serves from the proxy, and data packs deployed into world folders.
 * Each adapter makes the bridge calls the matching console route makes
 * (`/api/respacks/**`, `/api/datapacks/**`), in the same order.
 *
 * `respack_push` is the one with no route behind it. A resend compares packs by
 * name, so a player already holding a pack is never sent its new bytes, and the
 * proxy keeps the hash it read at load time; pushing an update therefore means a
 * reload (re-hash) followed by a per-player `lunapack forceload`, which is the
 * order the operators settled on by hand.
 */

import { loadCluster, loadLock, saveLock } from '$core/config';
import { pruneAddon } from '$core/families';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import type { PacksLock } from '$core/packslock';
import {
	addResourcePackFile,
	applyResourcePackUpdate,
	checkResourcePackUpdates,
	installResourcePackFromProvider,
	listResourcePacksLive,
	reloadResourcePacks,
	removeResourcePack,
	replaceResourcePackFile,
	updateResourcePack
} from '$core/respacks';
import type { RespackRow } from '$core/respacks';
import {
	addDataPackFile,
	applyDataPackUpdate,
	checkDataPackUpdates,
	deployDataPacks,
	installDataPackFromProvider,
	listDataPacks,
	removeDataPack,
	updateDataPack
} from '$core/datapacks';
import { getProject, isReleaseChannel, searchProvider } from '$core/services/providers';
import type { ReleaseChannel } from '$core/services/providers';
import * as luna from '$core/services/luna';
import type { ClusterConfig, ProviderId } from '$core/types';
import { pushEvent } from '$lib/server/luna';
import { readUpload } from '$lib/server/agent/uploads';
import { optBool, optInt, optList, optStr, requireWholeCluster, str } from './args';
import { ToolError } from './errors';
import type { ToolArgs, ToolHandler } from './errors';

/** Search hits pack_search returns. */
const SEARCH_LIMIT = 15;

/** How long the proxy gets to re-read and re-hash the packs after a reload, before anyone is pushed. */
const REHASH_WAIT_MS = 2_000;

/** A Minecraft username that is safe to put in a proxy command. */
const PLAYER_NAME = /^[A-Za-z0-9_.]{1,32}$/;

function provider(args: ToolArgs): ProviderId {
	return (optStr(args, 'provider') ?? 'modrinth') as ProviderId;
}

function channel(args: ToolArgs): ReleaseChannel | undefined {
	const value = optStr(args, 'channel');

	if (value !== undefined && !isReleaseChannel(value)) {
		throw new ToolError(`unknown channel "${value}"; use release, beta or alpha`);
	}

	return value as ReleaseChannel | undefined;
}

async function respackRows(cfg: ClusterConfig, lock: PacksLock): Promise<RespackRow[]> {
	return (await listResourcePacksLive(cfg, lock, (await loadLock()).groups)).rows;
}

function respackBrief(row: RespackRow) {
	return {
		key: row.key,
		name: row.name,
		enabled: row.enabled,
		required: row.required,
		priority: row.priority,
		servers: row.servers,
		sentOn: row.matched,
		present: row.present,
		sizeBytes: row.sizeBytes,
		source: row.source,
		version: row.versionNumber ?? null,
		autoUpdate: row.autoUpdate,
		channel: row.channel ?? 'release',
		registeredByPlugin: !row.defFile && !!row.dynamic,
		groups: row.groups
	};
}

/** Apply the registration fields an install call may carry; returns the refreshed row. */
async function applyRegistration(cfg: ClusterConfig, lock: PacksLock, key: string, args: ToolArgs): Promise<RespackRow | null> {
	const patch = {
		enabled: optBool(args, 'enabled'),
		servers: optList(args, 'servers'),
		priority: optInt(args, 'priority'),
		required: optBool(args, 'required')
	};

	if (Object.values(patch).every((value) => value === undefined)) {
		return null;
	}

	return await updateResourcePack(cfg, lock, key, patch, (await loadLock()).groups);
}

/** A pack zip attached in the chat panel, as the base64 the pack functions take. */
async function attachment(args: ToolArgs): Promise<{ name: string; data: string }> {
	const staged = await readUpload(str(args, 'upload'));

	if (!staged) {
		throw new ToolError('no such attachment, or it expired (attachments live for an hour); ask the operator to attach the file again');
	}

	if (!staged.upload.name.toLowerCase().endsWith('.zip')) {
		throw new ToolError(`${staged.upload.name} is not a .zip; resource packs and data packs are zip files`);
	}

	return {
		name: staged.upload.name.replace(/\.zip$/i, ''),
		data: Buffer.from(staged.bytes).toString('base64')
	};
}

function changedCount(actions: Array<{ action: string }>): number {
	return actions.filter((action) => action.action !== 'unchanged').length;
}

export const PACK_HANDLERS: Record<string, ToolHandler> = {
	async respacks_list() {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const { rows, dynamic } = await listResourcePacksLive(cfg, lock, (await loadLock()).groups);

		return {
			packs: rows.map(respackBrief),
			proxyAnswered: dynamic.available
		};
	},

	async datapacks_list() {
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const rows = await listDataPacks(cfg, lock, (await loadLock()).groups);

		return rows.map((row) => ({
			name: row.name,
			source: row.entry.source,
			version: row.entry.installed?.versionNumber ?? null,
			targets: row.entry.targets,
			deployedTo: row.effectiveTargets,
			groups: row.groups,
			present: row.present,
			sizeBytes: row.sizeBytes,
			autoUpdate: row.entry.autoUpdate ?? false,
			channel: row.entry.channel ?? 'release'
		}));
	},

	async pack_search(args) {
		const kind = str(args, 'kind') === 'datapack'
			? 'datapack'
			: 'resourcepack';

		const source = provider(args);

		try {
			const hits = await searchProvider(source, str(args, 'query'), kind);

			return hits.slice(0, SEARCH_LIMIT).map((hit) => ({
				slug: hit.slug,
				id: hit.project_id,
				title: hit.title,
				description: hit.description,
				downloads: hit.downloads,
				gameVersions: hit.versions?.slice(-6),
				provider: source
			}));
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	},

	async pack_check_updates(args) {
		const names = optList(args, 'names');
		const lock = await loadPacksLock();

		if (str(args, 'kind') === 'datapack') {
			const cfg = await loadCluster();

			return await checkDataPackUpdates(cfg, lock, names, (await loadLock()).groups);
		}

		return await checkResourcePackUpdates(lock, names);
	},

	async respack_install(args, ctx) {
		requireWholeCluster(ctx, 'the resource pack list');

		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const source = provider(args);
		const project = await getProject(source, str(args, 'slug'), 'resourcepack');

		if (!project) {
			throw new ToolError(`${source} has no resource pack "${str(args, 'slug')}"; call pack_search`);
		}

		try {
			const row = await installResourcePackFromProvider(cfg, lock, source, project, { channel: channel(args) });
			const configured = await applyRegistration(cfg, lock, row.key, args);

			await savePacksLock(lock);
			await reloadResourcePacks(cfg);
			pushEvent('packs', 'action', `resource pack ${row.key} installed (${row.versionNumber}) by ${ctx.actor}`);

			return respackBrief(configured ?? row);
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	},

	async respack_install_upload(args, ctx) {
		requireWholeCluster(ctx, 'the resource pack list');

		const file = await attachment(args);
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const replace = optStr(args, 'replace');

		try {
			if (replace) {
				const result = await replaceResourcePackFile(cfg, lock, replace, file.data);

				await applyRegistration(cfg, lock, replace, args);
				await savePacksLock(lock);

				const reloaded = await reloadResourcePacks(cfg);

				pushEvent('packs', 'action', `resource pack ${replace} file replaced by ${ctx.actor} (${result.sizeAfter} bytes)`);

				return {
					key: replace,
					file: result.file,
					sizeBefore: result.sizeBefore,
					sizeAfter: result.sizeAfter,
					unchanged: result.unchanged,
					wasProvider: result.wasProvider,
					proxyReloaded: reloaded,
					note: result.unchanged
						? 'the attached zip is identical to the one already served'
						: 'players who already hold this pack keep the old bytes until respack_push'
				};
			}

			const row = await addResourcePackFile(cfg, lock, optStr(args, 'name') || file.name, file.data);
			const configured = await applyRegistration(cfg, lock, row.key, args);

			await savePacksLock(lock);
			await reloadResourcePacks(cfg);
			pushEvent('packs', 'action', `resource pack ${row.key} uploaded by ${ctx.actor} (${row.sizeBytes} bytes)`);

			return respackBrief(configured ?? row);
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	},

	async respack_configure(args, ctx) {
		requireWholeCluster(ctx, 'the resource pack list');

		const key = str(args, 'key');
		const cfg = await loadCluster();
		const lock = await loadPacksLock();

		try {
			const row = await updateResourcePack(
				cfg,
				lock,
				key,
				{
					name: optStr(args, 'name'),
					priority: optInt(args, 'priority'),
					required: optBool(args, 'required'),
					enabled: optBool(args, 'enabled'),
					servers: optList(args, 'servers'),
					autoUpdate: optBool(args, 'autoUpdate'),
					channel: channel(args)
				},
				(await loadLock()).groups
			);

			await savePacksLock(lock);
			await reloadResourcePacks(cfg);
			pushEvent('packs', 'action', `resource pack ${key} updated by ${ctx.actor}`);

			return respackBrief(row);
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	},

	async respack_update(args, ctx) {
		requireWholeCluster(ctx, 'the resource pack list');

		const cfg = await loadCluster();
		const lock = await loadPacksLock();

		try {
			const { updates, skipped } = await checkResourcePackUpdates(lock, optList(args, 'names'));

			for (const update of updates) {
				await applyResourcePackUpdate(lock, update);
				pushEvent('packs', 'action', `resource pack ${update.key} updated to ${update.to} by ${ctx.actor}`);
			}

			await savePacksLock(lock);

			const reloaded = updates.length > 0
				? await reloadResourcePacks(cfg)
				: false;

			return {
				applied: updates,
				skipped,
				proxyReloaded: reloaded,
				note: updates.length > 0
					? 'run respack_push for each updated pack so players holding it download the new version'
					: 'nothing to update'
			};
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	},

	async respack_push(args, ctx) {
		requireWholeCluster(ctx, 'the resource pack list');

		const key = str(args, 'key');
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const row = (await respackRows(cfg, lock)).find((candidate) => candidate.key === key);

		if (!row) {
			throw new ToolError(`no resource pack "${key}"; call respacks_list for the keys`);
		}

		if (!row.enabled) {
			throw new ToolError(`${key} is disabled, so there is nothing to push; enable it with respack_configure first`);
		}

		const reloaded = await reloadResourcePacks(cfg);

		if (!reloaded) {
			throw new ToolError('the proxy is not running, so nobody is online to push to');
		}

		await Bun.sleep(REHASH_WAIT_MS);

		const sessions = await luna.packSessions();

		if (!sessions.ok || !sessions.data) {
			throw new ToolError(`the proxy reloaded the packs but did not say who is online: ${sessions.error ?? 'unavailable'}`);
		}

		const wanted = optList(args, 'players')?.map((name) => name.toLowerCase());
		const packName = row.name.toLowerCase();
		const servedOn = new Set(row.matched);
		const picked = sessions.data.players.filter((session) =>
			wanted
				? wanted.includes(session.username.toLowerCase())
				: servedOn.has(session.server) || session.loaded.some((name) => name.toLowerCase() === packName)
		);

		const results: Array<{ player: string; server: string; pushed: boolean; problem?: string }> = [];

		for (const session of picked) {
			if (!PLAYER_NAME.test(session.username)) {
				results.push({ player: session.username, server: session.server, pushed: false, problem: 'name cannot go into a proxy command' });

				continue;
			}

			const sent = await luna.runCommand(`lunapack forceload ${session.username} ${packName}`);

			results.push({
				player: session.username,
				server: session.server,
				pushed: sent.ok,
				problem: sent.ok
					? undefined
					: sent.error
			});
		}

		const missing = (wanted ?? []).filter((name) => !picked.some((session) => session.username.toLowerCase() === name));

		pushEvent('packs', 'action', `resource pack ${key} pushed to ${results.filter((result) => result.pushed).length} player(s) by ${ctx.actor}`);

		return {
			pack: key,
			proxyReloaded: true,
			players: results,
			notOnline: missing,
			note: picked.length === 0
				? 'nobody online on the servers this pack is sent on; they get it on their next join'
				: 'each pushed player is offered the pack again under its new hash'
		};
	},

	async respack_remove(args, ctx) {
		requireWholeCluster(ctx, 'the resource pack list');

		const key = str(args, 'key');
		const cfg = await loadCluster();
		const lock = await loadPacksLock();

		try {
			const { removed } = await removeResourcePack(cfg, lock, key, { keepFile: optBool(args, 'keepFile') === true });

			await savePacksLock(lock);

			// a removed pack must not linger as a phantom group member
			const plugins = await loadLock();

			if (pruneAddon(plugins, 'respacks', key)) {
				await saveLock(plugins);
			}

			await reloadResourcePacks(cfg);
			pushEvent('packs', 'action', `resource pack ${key} removed by ${ctx.actor}`);

			return { key, removed };
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	},

	async datapack_install(args, ctx) {
		requireWholeCluster(ctx, 'the data pack pool');

		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const source = provider(args);
		const project = await getProject(source, str(args, 'slug'), 'datapack');

		if (!project) {
			throw new ToolError(`${source} has no data pack "${str(args, 'slug')}"; call pack_search`);
		}

		try {
			const res = await installDataPackFromProvider(cfg, lock, source, project, optList(args, 'targets') ?? [], { channel: channel(args) });

			await savePacksLock(lock);

			const actions = await deployDataPacks(cfg, lock, { pack: res.name, groups: (await loadLock()).groups });

			pushEvent('packs', 'action', `data pack ${res.name} installed (${res.entry.installed?.versionNumber}) by ${ctx.actor}`);

			return {
				name: res.name,
				version: res.entry.installed?.versionNumber ?? null,
				targets: res.entry.targets,
				deployed: changedCount(actions),
				note: 'run `reload` on each running target (instance_command) to load it'
			};
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	},

	async datapack_install_upload(args, ctx) {
		requireWholeCluster(ctx, 'the data pack pool');

		const file = await attachment(args);
		const cfg = await loadCluster();
		const lock = await loadPacksLock();

		try {
			const res = await addDataPackFile(cfg, lock, optStr(args, 'name') || file.name, file.data, optList(args, 'targets'));

			await savePacksLock(lock);

			const actions = await deployDataPacks(cfg, lock, { pack: res.name, groups: (await loadLock()).groups });

			pushEvent('packs', 'action', `data pack ${res.name} uploaded by ${ctx.actor}`);

			return {
				name: res.name,
				targets: res.entry.targets,
				deployed: changedCount(actions),
				note: 'run `reload` on each running target (instance_command) to load it'
			};
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	},

	async datapack_configure(args, ctx) {
		requireWholeCluster(ctx, 'the data pack pool');

		const name = str(args, 'name');
		const cfg = await loadCluster();
		const lock = await loadPacksLock();
		const entry = lock.datapacks[name];

		if (!entry) {
			throw new ToolError(`no data pack "${name}" in the pool; call datapacks_list for the names`);
		}

		const targets = optList(args, 'targets');
		const autoUpdate = optBool(args, 'autoUpdate');
		const releaseChannel = channel(args);

		try {
			if (targets !== undefined) {
				entry.targets = targets;
			}

			updateDataPack(lock, name, {
				...(autoUpdate !== undefined ? { autoUpdate } : {}),
				...(releaseChannel !== undefined ? { channel: releaseChannel } : {})
			});

			await savePacksLock(lock);

			let deployed = 0;

			if (targets !== undefined) {
				const actions = await deployDataPacks(cfg, lock, { pack: name, groups: (await loadLock()).groups });

				deployed = changedCount(actions);
			}

			pushEvent('packs', 'action', `data pack ${name} updated by ${ctx.actor}`);

			return { name, targets: entry.targets, autoUpdate: entry.autoUpdate ?? false, channel: entry.channel ?? 'release', deployed };
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	},

	async datapack_update(args, ctx) {
		requireWholeCluster(ctx, 'the data pack pool');

		const cfg = await loadCluster();
		const lock = await loadPacksLock();

		try {
			const groups = (await loadLock()).groups;
			const { updates, skipped } = await checkDataPackUpdates(cfg, lock, optList(args, 'names'), groups);
			let deployed = 0;

			for (const update of updates) {
				await applyDataPackUpdate(lock, update);

				const actions = await deployDataPacks(cfg, lock, { pack: update.name, groups });

				deployed += changedCount(actions);
				pushEvent('packs', 'action', `data pack ${update.name} updated to ${update.to} by ${ctx.actor}`);
			}

			await savePacksLock(lock);

			return {
				applied: updates,
				skipped,
				deployed,
				note: updates.length > 0
					? 'run `reload` on each running target (instance_command) to load the new versions'
					: 'nothing to update'
			};
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	},

	async datapack_remove(args, ctx) {
		requireWholeCluster(ctx, 'the data pack pool');

		const name = str(args, 'name');
		const cfg = await loadCluster();
		const lock = await loadPacksLock();

		try {
			const plugins = await loadLock();
			const res = await removeDataPack(cfg, lock, name, optList(args, 'from'), plugins.groups);

			await savePacksLock(lock);

			// a pack that is gone must not linger as a phantom group member
			if (res.entryRemoved && pruneAddon(plugins, 'datapacks', name)) {
				await saveLock(plugins);
			}

			pushEvent('packs', 'action', `data pack ${name} removed by ${ctx.actor}`);

			return { name, ...res, note: 'a running server keeps the pack loaded until `reload` or a restart' };
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	}
};
