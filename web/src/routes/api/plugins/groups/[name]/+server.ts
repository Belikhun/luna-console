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
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';
import { applyRestartChoice } from '$lib/server/restart';

/**
 * GET → one group in full: membership with per-family availability, the
 * instances using it (with live state), and the editor's plugin universe.
 */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const lock = await loadLock();
	const group = lock.groups?.[params.name];

	if (!group) {
		throw error(404, 'unknown group');
	}

	const statuses = await getAllStatuses(cfg);

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

	return json({
		name: params.name,
		description: group.description ?? '',
		builtin: !!group.builtin,
		plugins,
		pluginNames: allPluginNames(lock),
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

/**
 * PATCH { plugins?, description?, restart? } → edit the group, redeploy to the
 * instances using it when membership changed, then apply the restart choice.
 */
export async function PATCH({ params, request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadLock();
	const name = params.name;

	if (!lock.groups?.[name]) {
		throw error(404, 'unknown group');
	}

	const before = lock.groups[name]!.plugins;

	try {
		setGroup(lock, name, {
			plugins: Array.isArray(body.plugins) ? body.plugins.map(String) : undefined,
			description: body.description !== undefined ? String(body.description) : undefined
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	await saveLock(lock);

	const after = lock.groups[name]!.plugins;
	const changed =
		before.length !== after.length || after.some((plugin) => !before.includes(plugin));

	let deployed = 0;
	const affected = groupInstances(cfg, name);

	if (changed && affected.length) {
		const actions = await deploy(cfg, lock, { instances: affected });

		await saveLock(lock);
		deployed = actions.filter((action) => action.action !== 'unchanged').length;
	}

	pushEvent('plugins', 'action', `plugin group "${name}" saved (${after.length} plugin(s))`);

	const restart = changed
		? await applyRestartChoice(cfg, affected, body.restart, `plugin-group "${name}" update`)
		: { restarted: [], scheduled: null };

	return json({ ok: true, group: lock.groups[name], deployed, changed, ...restart });
}

/**
 * POST { action: "sync", restart? } → push the group's current membership to
 * every instance using it (deploy), then apply the restart choice — the
 * "update existing instances to the group's state" tool.
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
	let deployed = 0;

	if (affected.length) {
		const actions = await deploy(cfg, lock, { instances: affected });

		await saveLock(lock);
		deployed = actions.filter((action) => action.action !== 'unchanged').length;
	}

	pushEvent('plugins', 'action', `plugin group "${params.name}" synced to ${affected.length} instance(s)`);

	const restart = await applyRestartChoice(
		cfg,
		affected,
		body.restart,
		`plugin-group "${params.name}" sync`
	);

	return json({ ok: true, deployed, affected, ...restart });
}

/** DELETE → remove the group (deployed jars stay on the instances). */
export async function DELETE({ params }) {
	const lock = await loadLock();

	try {
		deleteGroup(lock, params.name);
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	await saveLock(lock);
	pushEvent('plugins', 'action', `plugin group "${params.name}" deleted`);

	return json({ ok: true });
}
