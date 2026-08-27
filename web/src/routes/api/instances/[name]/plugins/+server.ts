// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveCluster, saveLock, managedInstances } from '$core/config';
import { effectiveTargets, entriesOf, setPluginOverride } from '$core/families';
import { deploy, fitAddonToInstance } from '$core/plugins';
import { removeInstanceJars } from '$core/pluginstate';
import { addonSnapshot } from '$lib/server/addons';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * GET → the plugins this instance runs: version, origin (group/manual/explicit),
 * runtime state from the current boot session, and per-plugin warn/error counts.
 * Same payload the addon stream pushes, so a refresh and a live update agree.
 */
export async function GET({ params }) {
	try {
		const { datapacks, ...plugins } = await addonSnapshot(params.name);

		return json(plugins);
	} catch (err) {
		throw error(404, errorMessage(err));
	}
}

/**
 * POST { plugin, state: true | false | null } → per-instance override: force-add
 * (deploys immediately), disable (removes the jars; a running server keeps them
 * loaded until restart), or clear (groups decide again).
 */
export async function POST({ params, request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadLock();
	const name = params.name;
	const plugin = String(body.plugin ?? '');

	if (!plugin) {
		throw error(400, 'plugin is required');
	}

	if (body.state !== true && body.state !== false && body.state !== null) {
		throw error(400, 'state must be true (force-add), false (disable) or null (clear)');
	}

	let fit: Awaited<ReturnType<typeof fitAddonToInstance>> | undefined;

	try {
		setPluginOverride(cfg, lock, name, plugin, body.state);

		// A force-add is an addon arriving on this instance, so the build it runs is
		// settled here exactly as the add dialog settles it: the newest build its MC
		// version can run, pooled as a variant. Without this the instance got the
		// pool primary, which on a pool shared across game lines `deploy` refuses to
		// copy - force-added, listed, and absent. A refusal (nothing compatible at
		// any channel) fails the whole request before anything is persisted, with
		// the message naming the build that would work.
		if (body.state === true) {
			fit = await fitAddonToInstance(cfg, lock, name, plugin);
		}
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	await saveCluster(cfg);

	// "wanted" must include explicit lockfile targets, not just groups/overrides -
	// clearing an override on an explicitly targeted plugin re-deploys it
	const wanted = entriesOf(lock, plugin).some((key) =>
		effectiveTargets(cfg, lock, key).includes(name),
	);

	let deployed = 0;
	let removed: string[] = [];

	if (wanted) {
		const actions = await deploy(cfg, lock, { instances: [name] });

		await saveLock(lock);
		deployed = actions.filter((action) => action.action !== 'unchanged').length;
	} else {
		removed = await removeInstanceJars(cfg, lock, name, plugin);
		await saveLock(lock);
	}

	const verb = body.state === true ? 'force-added' : body.state === false ? 'disabled' : 'override cleared';

	pushEvent(name, 'action', `plugin ${plugin} ${verb} (${removed.length ? `removed ${removed.join(', ')}` : `${deployed} deploy change(s)`})`);

	return json({
		ok: true,
		wanted,
		deployed,
		removed,
		...(fit?.fitted ? { version: fit.version, escalatedTo: fit.escalatedTo } : {})
	});
}
