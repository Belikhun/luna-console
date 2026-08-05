// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, loadLock, saveLock } from '$core/config';
import {
	DEFAULT_GROUP,
	DEFAULT_GROUP_PLUGINS,
	allPluginNames,
	deleteGroup,
	groupInstances,
	setGroup
} from '$core/families';
import { deploy } from '$core/plugins';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { listResourcePacks } from '$core/respacks';
import { listDataPacks } from '$core/datapacks';
import { applyAddonGroups } from '$core/addons';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';
import { applyRestartChoice } from '$lib/server/restart';

/** GET → every group, the addon universe to pick from, and who uses what. */
export async function GET() {
	const cfg = await loadCluster();
	const lock = await loadLock();
	const packs = await loadPacksLock();

	const groups = Object.entries(lock.groups ?? {}).map(([name, group]) => ({
		name,
		description: group.description ?? '',
		builtin: !!group.builtin,
		plugins: group.plugins,
		respacks: group.respacks ?? [],
		datapacks: group.datapacks ?? [],
		usedBy: groupInstances(cfg, name)
	}));

	const respacks = await listResourcePacks(cfg, packs, lock.groups);
	const datapacks = await listDataPacks(cfg, packs, lock.groups);

	return json({
		groups: groups.sort((a, b) =>
			a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin ? -1 : 1
		),
		pluginNames: allPluginNames(lock),
		respackKeys: respacks.map((row) => row.key),
		datapackNames: datapacks.map((row) => row.name),
		lockedPlugins: DEFAULT_GROUP_PLUGINS,
		defaultGroup: DEFAULT_GROUP
	});
}

/**
 * POST { name, plugins, respacks?, datapacks?, description?, restart? } →
 * create or update a group, push it to everyone it covers (jars, pack rules
 * and world data packs), then apply the restart choice.
 */
export async function POST({ request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadLock();
	const name = String(body.name ?? '');

	if (!Array.isArray(body.plugins)) {
		throw error(400, 'plugins must be a list of plugin names');
	}

	const before = JSON.stringify(lock.groups?.[name] ?? {});

	try {
		setGroup(lock, name, {
			plugins: body.plugins.map(String),
			respacks: Array.isArray(body.respacks) ? body.respacks.map(String) : undefined,
			datapacks: Array.isArray(body.datapacks) ? body.datapacks.map(String) : undefined,
			description: body.description !== undefined ? String(body.description) : undefined
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	await saveLock(lock);

	const changed = before !== JSON.stringify(lock.groups![name]);
	const affected = groupInstances(cfg, name);

	let deployed = 0;
	let packs = 0;

	if (changed) {
		if (affected.length) {
			const actions = await deploy(cfg, lock, { instances: affected });

			await saveLock(lock);
			deployed = actions.filter((action) => action.action !== 'unchanged').length;
		}

		const packsLock = await loadPacksLock();
		const applied = await applyAddonGroups(cfg, packsLock, lock.groups, {
			instances: affected.length ? affected : undefined
		});

		await savePacksLock(packsLock);
		packs =
			applied.respacks.length +
			applied.datapacks.filter((action) => action.action !== 'unchanged').length;
	}

	pushEvent('plugins', 'action', `addon group "${name}" saved`);

	const restart = changed
		? await applyRestartChoice(cfg, affected, body.restart, `addon-group "${name}" update`)
		: { restarted: [], scheduled: null };

	return json({ ok: true, group: lock.groups![name], deployed, packs, ...restart });
}

/** DELETE ?name= → remove a group (deployed files stay on disk). */
export async function DELETE({ url }) {
	const cfg = await loadCluster();
	const lock = await loadLock();
	const name = url.searchParams.get('name') ?? '';

	try {
		deleteGroup(lock, name);
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	await saveLock(lock);

	// the group's resource pack rules named its instances; take them back out
	const packsLock = await loadPacksLock();

	await applyAddonGroups(cfg, packsLock, lock.groups);
	await savePacksLock(packsLock);

	pushEvent('plugins', 'action', `addon group "${name}" deleted`);

	return json({ ok: true });
}
