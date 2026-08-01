import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveCluster, saveLock, managedInstances } from '$core/config';
import { effectiveTargets, entriesOf, setPluginOverride } from '$core/families';
import { deploy } from '$core/plugins';
import { ensureAliases, instancePluginReport, removeInstanceJars } from '$core/pluginstate';
import { pushEvent } from '$lib/server/mrds';
import { errorMessage } from '$lib/server/http';

/**
 * GET → the plugins this instance runs: version, origin (group/manual/explicit),
 * runtime state from the current boot session, and per-plugin warn/error counts.
 */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const lock = await loadLock();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	if (await ensureAliases(lock)) {
		await saveLock(lock);
	}

	const { rows, session } = await instancePluginReport(cfg, lock, params.name);

	return json({
		plugins: rows,
		sessionComplete: session.complete,
		warnings: rows.reduce((sum, row) => sum + row.warnings, 0),
		errors: rows.reduce((sum, row) => sum + row.errors, 0)
	});
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

	try {
		setPluginOverride(cfg, lock, name, plugin, body.state);
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	await saveCluster(cfg);

	// "wanted" must include explicit lockfile targets, not just groups/overrides —
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

	return json({ ok: true, wanted, deployed, removed });
}
