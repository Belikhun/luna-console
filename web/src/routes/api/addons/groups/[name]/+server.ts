// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, loadLock, saveLock } from '$core/config';
import {
	DEFAULT_GROUP_PLUGINS,
	allPluginNames,
	deleteGroup,
	entriesOf,
	familyOf,
	groupInstances,
	setGroup
} from '$core/families';
import { deploy } from '$core/plugins';
import { getAllStatuses } from '$core/instances';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { listResourcePacks } from '$core/respacks';
import { listDataPacks } from '$core/datapacks';
import { applyAddonGroups, type AddonGroupApply } from '$core/addons';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';
import { applyRestartChoice } from '$lib/server/restart';

/**
 * GET → one group in full: its three member lists (plugins with per-family
 * availability, resource packs and data packs with pool state), the instances
 * using it with live state, and the addon universe the pickers offer.
 */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const lock = await loadLock();
	const group = lock.groups?.[params.name];

	if (!group) {
		throw error(404, 'unknown group');
	}

	const statuses = await getAllStatuses(cfg);
	const packsLock = await loadPacksLock();
	const respackRows = await listResourcePacks(cfg, packsLock, lock.groups);
	const datapackRows = await listDataPacks(cfg, packsLock, lock.groups);

	const plugins = group.plugins.map((plugin) => {
		const keys = entriesOf(lock, plugin);

		return {
			plugin,
			locked: !!group.builtin && DEFAULT_GROUP_PLUGINS.includes(plugin),
			pooled: keys.length > 0,
			families: keys.map((key) => {
				const entry = lock.plugins[key]!;

				return {
					key,
					family: familyOf(entry),
					version: entry.installed?.versionNumber ?? null,
					source: entry.source
				};
			})
		};
	});

	const respacks = (group.respacks ?? []).map((key) => {
		const row = respackRows.find((candidate) => candidate.key === key);

		return {
			key,
			pooled: !!row,
			enabled: row?.enabled ?? false,
			registered: !!row?.defFile,
			priority: row?.priority ?? 0,
			required: row?.required ?? false,
			servers: row?.servers ?? [],
			matched: row?.matched ?? [],
			version: row?.versionNumber ?? null,
			source: row?.source ?? null
		};
	});

	const datapacks = (group.datapacks ?? []).map((name) => {
		const row = datapackRows.find((candidate) => candidate.name === name);

		return {
			name,
			pooled: !!row,
			present: row?.present ?? false,
			targets: row?.effectiveTargets ?? [],
			version: row?.entry.installed?.versionNumber ?? null,
			source: row?.entry.source ?? null
		};
	});

	return json({
		name: params.name,
		description: group.description ?? '',
		builtin: !!group.builtin,
		plugins,
		respacks,
		datapacks,
		pluginNames: allPluginNames(lock),
		respackKeys: respackRows.map((row) => row.key),
		datapackNames: datapackRows.map((row) => row.name),
		lockedPlugins: DEFAULT_GROUP_PLUGINS,
		instances: groupInstances(cfg, params.name).map((name) => {
			const status = statuses.find((entry) => entry.name === name);

			return {
				name,
				software: status?.inst.software ?? 'paper',
				mcVersion: status?.inst.mcVersion ?? null,
				state: status?.state ?? 'stopped'
			};
		})
	});
}

/** Deploy the group's addons to the instances using it, in all three kinds. */
async function pushGroup(
	cfg: Awaited<ReturnType<typeof loadCluster>>,
	lock: Awaited<ReturnType<typeof loadLock>>,
	affected: string[]
): Promise<{ deployed: number; apply: AddonGroupApply }> {
	let deployed = 0;

	if (affected.length) {
		const actions = await deploy(cfg, lock, { instances: affected });

		await saveLock(lock);
		deployed = actions.filter((action) => action.action !== 'unchanged').length;
	}

	const packsLock = await loadPacksLock();
	const apply = await applyAddonGroups(cfg, packsLock, lock.groups, {
		instances: affected.length ? affected : undefined
	});

	await savePacksLock(packsLock);

	return { deployed, apply };
}

/** How many pack changes an apply made, for the caller's summary line. */
function packChanges(apply: AddonGroupApply): number {
	return (
		apply.respacks.length + apply.datapacks.filter((action) => action.action !== 'unchanged').length
	);
}

/**
 * PATCH { plugins?, respacks?, datapacks?, description?, restart? } → edit the
 * group, push it to the instances using it when membership changed, then apply
 * the restart choice.
 */
export async function PATCH({ params, request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadLock();
	const name = params.name;

	if (!lock.groups?.[name]) {
		throw error(404, 'unknown group');
	}

	const before = JSON.stringify(lock.groups[name]);

	try {
		setGroup(lock, name, {
			plugins: Array.isArray(body.plugins) ? body.plugins.map(String) : undefined,
			respacks: Array.isArray(body.respacks) ? body.respacks.map(String) : undefined,
			datapacks: Array.isArray(body.datapacks) ? body.datapacks.map(String) : undefined,
			description: body.description !== undefined ? String(body.description) : undefined
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	await saveLock(lock);

	const changed = before !== JSON.stringify(lock.groups[name]);
	const affected = groupInstances(cfg, name);

	let deployed = 0;
	let packs = 0;

	if (changed) {
		const result = await pushGroup(cfg, lock, affected);

		deployed = result.deployed;
		packs = packChanges(result.apply);
	}

	pushEvent('plugins', 'action', `addon group "${name}" saved`);

	const restart = changed
		? await applyRestartChoice(cfg, affected, body.restart, `addon-group "${name}" update`)
		: { restarted: [], scheduled: null };

	return json({ ok: true, group: lock.groups[name], deployed, packs, changed, ...restart });
}

/**
 * POST { action: "sync", restart? } → push the group's current membership to
 * every instance using it (jars, pack rules, world data packs), then apply the
 * restart choice; the "update existing instances to the group's state" tool.
 */
export async function POST({ params, request }) {
	const body = await request.json();

	if (body.action !== 'sync') {
		throw error(400, 'the only action is "sync"');
	}

	const cfg = await loadCluster();
	const lock = await loadLock();

	if (!lock.groups?.[params.name]) {
		throw error(404, 'unknown group');
	}

	const affected = groupInstances(cfg, params.name);
	const { deployed, apply } = await pushGroup(cfg, lock, affected);

	pushEvent(
		'plugins',
		'action',
		`addon group "${params.name}" synced to ${affected.length} instance(s)`
	);

	const restart = await applyRestartChoice(
		cfg,
		affected,
		body.restart,
		`addon-group "${params.name}" sync`
	);

	return json({
		ok: true,
		deployed,
		packs: packChanges(apply),
		reloaded: apply.reloaded,
		affected,
		...restart
	});
}

/** DELETE → remove the group (deployed files stay on the instances). */
export async function DELETE({ params }) {
	const cfg = await loadCluster();
	const lock = await loadLock();

	try {
		deleteGroup(lock, params.name);
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	await saveLock(lock);

	// the group's resource pack rules named its instances; take them back out
	const packsLock = await loadPacksLock();

	await applyAddonGroups(cfg, packsLock, lock.groups);
	await savePacksLock(packsLock);

	pushEvent('plugins', 'action', `addon group "${params.name}" deleted`);

	return json({ ok: true });
}
