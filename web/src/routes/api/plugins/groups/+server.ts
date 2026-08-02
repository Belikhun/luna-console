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
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';
import { applyRestartChoice } from '$lib/server/restart';

/** GET → every group, the plugin-name universe, and who uses what. */
export async function GET() {
	const cfg = await loadCluster();
	const lock = await loadLock();

	const groups = Object.entries(lock.groups ?? {}).map(([name, group]) => ({
		name,
		description: group.description ?? '',
		builtin: !!group.builtin,
		plugins: group.plugins,
		usedBy: groupInstances(cfg, name)
	}));

	return json({
		groups: groups.sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name) : a.builtin ? -1 : 1)),
		pluginNames: allPluginNames(lock),
		lockedPlugins: DEFAULT_GROUP_PLUGINS,
		defaultGroup: DEFAULT_GROUP
	});
}

/**
 * POST { name, plugins, description?, restart? } → create or update a group,
 * redeploy to everyone it covers, then apply the restart choice.
 */
export async function POST({ request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadLock();
	const name = String(body.name ?? '');

	if (!Array.isArray(body.plugins)) {
		throw error(400, 'plugins must be a list of plugin names');
	}

	const before = lock.groups?.[name]?.plugins ?? [];

	try {
		setGroup(lock, name, {
			plugins: body.plugins.map(String),
			description: body.description !== undefined ? String(body.description) : undefined
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	await saveLock(lock);

	const after = lock.groups![name]!.plugins;
	const changed =
		before.length !== after.length || after.some((plugin) => !before.includes(plugin));

	let deployed = 0;

	if (changed) {
		const affected = groupInstances(cfg, name);

		if (affected.length) {
			const actions = await deploy(cfg, lock, { instances: affected });

			await saveLock(lock);
			deployed = actions.filter((action) => action.action !== 'unchanged').length;
		}
	}

	pushEvent('plugins', 'action', `plugin group "${name}" saved (${after.length} plugin(s))`);

	const restart = changed
		? await applyRestartChoice(
				cfg,
				groupInstances(cfg, name),
				body.restart,
				`plugin-group "${name}" update`
			)
		: { restarted: [], scheduled: null };

	return json({ ok: true, group: lock.groups![name], deployed, ...restart });
}

/** DELETE ?name= → remove a group (deployed jars stay on disk). */
export async function DELETE({ url }) {
	const lock = await loadLock();
	const name = url.searchParams.get('name') ?? '';

	try {
		deleteGroup(lock, name);
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	await saveLock(lock);
	pushEvent('plugins', 'action', `plugin group "${name}" deleted`);

	return json({ ok: true });
}
