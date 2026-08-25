// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock, managedInstances } from '$core/config';
import { projectTypeFor, removePlugin, setChannel } from '$core/plugins';
import { effectiveTargets, entriesOf, familyOf, pluginNameOf } from '$core/families';
import { aliasesOf, displayNameOf, ensureAliases, pluginUsageReport } from '$core/pluginstate';
import { getAllStatuses } from '$core/instances';
import { isReleaseChannel, projectUrl, versionUrl } from '$core/services/providers';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

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
		const type = projectTypeFor(familyOf(entry));

		/** Provider page of one pooled version, when enough identity survives. */
		const versionLink = (versionId?: string, versionNumber?: string): string | null => {
			if (!entry.remote || !versionNumber) {
				return null;
			}

			return versionUrl(entry.remote, type, {
				id: versionId ?? versionNumber,
				version_number: versionNumber
			});
		};

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
			remote: entry.remote ?? null,
			url: entry.remote ? projectUrl(entry.remote, type) : null,
			luna: entry.luna ?? null,
			installed: entry.installed
				? {
						versionNumber: entry.installed.versionNumber ?? null,
						gameVersions: entry.installed.gameVersions ?? [],
						url: versionLink(
							entry.installed.versionId,
							entry.installed.versionNumber ?? undefined
						)
					}
				: null,
			variants: Object.values(entry.variants ?? {}).map((variant) => ({
				versionNumber: variant.versionNumber,
				gameVersions: variant.gameVersions ?? [],
				file: variant.file,
				url: versionLink(variant.versionId, variant.versionNumber)
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

/**
 * PATCH { autoUpdate?, targets?, channel? }
 *
 * Setting a channel moves the ceiling and nothing else; the jars follow on the
 * next update check, which is why this stays a lockfile edit rather than a job.
 */
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

	if (typeof body.channel === 'string') {
		if (!isReleaseChannel(body.channel)) {
			throw error(400, `unknown channel: ${body.channel}`);
		}

		try {
			setChannel(lock, params.name, body.channel);
		} catch (err) {
			// an in-house or unidentified entry has no provider to take a channel
			// from, and core's message says which of the two it is
			throw error(409, errorMessage(err));
		}
	}

	await saveLock(lock);

	return json({ ok: true, channel: entry.channel ?? 'release' });
}

/** DELETE ?from=a,b; remove from targets (or everywhere) */
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
