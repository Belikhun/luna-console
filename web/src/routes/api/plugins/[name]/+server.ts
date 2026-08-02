import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock, managedInstances } from '$core/config';
import { removePlugin } from '$core/plugins';
import { effectiveTargets, entriesOf, familyOf, pluginNameOf } from '$core/families';
import { aliasesOf, displayNameOf, ensureAliases, pluginUsageReport } from '$core/pluginstate';
import { getAllStatuses } from '$core/instances';
import { pushEvent } from '$lib/server/luna';

/**
 * GET → everything about one plugin *identity*: its families (one lock entry
 * per platform build), the pooled versions of each, and where it lands across
 * the cluster. `name` is a plugin name; an entry key also resolves.
 */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const lock = await loadLock();

	if (await ensureAliases(lock)) {
		await saveLock(lock);
	}

	let plugin = params.name;
	let keys = entriesOf(lock, plugin);

	// an entry key (e.g. "spark-velocity") resolves to its plugin identity
	if (!keys.length && lock.plugins[plugin]) {
		plugin = pluginNameOf(params.name, lock.plugins[params.name]!);
		keys = entriesOf(lock, plugin);
	}

	if (!keys.length) {
		throw error(404, 'unknown plugin');
	}

	const statuses = await getAllStatuses(cfg);
	const insts = managedInstances(cfg);

	const families = keys.map((key) => {
		const entry = lock.plugins[key]!;

		return {
			key,
			family: familyOf(entry),
			displayName: displayNameOf(key, entry),
			aliases: aliasesOf(key, entry),
			meta: entry.meta ?? null,
			source: entry.source,
			file: entry.file,
			autoUpdate: entry.autoUpdate,
			channel: entry.channel ?? 'release',
			modrinth: entry.modrinth ?? null,
			luna: entry.luna ?? null,
			installed: entry.installed
				? {
						versionNumber: entry.installed.versionNumber ?? null,
						gameVersions: entry.installed.gameVersions ?? []
					}
				: null,
			variants: Object.values(entry.variants ?? {}).map((variant) => ({
				versionNumber: variant.versionNumber,
				gameVersions: variant.gameVersions ?? [],
				file: variant.file
			})),
			pins: entry.pins ?? {},
			assign: entry.assign ?? {},
			targets: entry.targets,
			effective: effectiveTargets(cfg, lock, key),
			configOps: entry.config?.length ?? 0
		};
	});

	const groups = Object.entries(lock.groups ?? {})
		.filter(([, group]) => group.plugins.includes(plugin))
		.map(([groupName]) => groupName);

	return json({
		plugin,
		families,
		groups,
		usage: pluginUsageReport(cfg, lock, plugin),
		instances: Object.entries(insts).map(([instName, inst]) => ({
			name: instName,
			software: inst.software,
			mcVersion: inst.mcVersion ?? null,
			state: statuses.find((status) => status.name === instName)?.state ?? 'stopped'
		}))
	});
}

/** PATCH { autoUpdate?, targets? } */
export async function PATCH({ params, request }) {
	const body = await request.json();
	const lock = await loadLock();
	const entry = lock.plugins[params.name];

	if (!entry) {
		throw error(404, 'unknown plugin');
	}

	if (typeof body.autoUpdate === 'boolean') {
		entry.autoUpdate = body.autoUpdate;
	}

	if (Array.isArray(body.targets)) {
		entry.targets = body.targets;
	}

	await saveLock(lock);

	return json({ ok: true });
}

/** DELETE ?from=a,b — remove from targets (or everywhere) */
export async function DELETE({ params, url }) {
	const cfg = await loadCluster();
	const lock = await loadLock();

	if (!lock.plugins[params.name]) {
		throw error(404, 'unknown plugin');
	}

	const from = url.searchParams.get('from')?.split(',').filter(Boolean);
	const res = await removePlugin(cfg, lock, params.name, from?.length ? from : undefined);

	await saveLock(lock);

	const where = res.deletedFrom.join(',') || '(none)';
	const pool = res.entryRemoved ? ' + pool' : '';

	pushEvent('plugins', 'action', `removed ${params.name} from ${where}${pool}`);

	return json({ ok: true, ...res });
}
