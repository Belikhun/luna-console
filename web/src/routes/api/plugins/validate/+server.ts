// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { addonDirForFamily, loadCluster, loadLock, managedInstances } from '$core/config';
import { validateGroups } from '$core/families';
import type { Software } from '$core/types';
import { SOFTWARE_IDS } from '$core/software';

/**
 * GET ?groups=a,b&software=paper&mcVersion=1.21.11[&instance=name]
 * → the group-selection validation table (OK / no-version / skipped / missing).
 * Passing `instance` fills software/mcVersion from the instance and sharpens
 * version resolution with its pins.
 */
export async function GET({ url }) {
	const cfg = await loadCluster();
	const lock = await loadLock();

	const instance = url.searchParams.get('instance') ?? undefined;
	let software = url.searchParams.get('software') as Software | null;
	let mcVersion = url.searchParams.get('mcVersion') ?? undefined;

	if (instance) {
		const inst = managedInstances(cfg)[instance];

		if (!inst) {
			throw error(404, 'unknown instance');
		}

		software ??= inst.software;
		mcVersion ??= inst.mcVersion;
	}

	if (!software || !SOFTWARE_IDS.includes(software)) {
		throw error(400, `software=${SOFTWARE_IDS.join('|')} (or instance=) is required`);
	}

	const groups = (url.searchParams.get('groups') ?? '')
		.split(',')
		.map((name) => name.trim())
		.filter(Boolean);

	const unknown = groups.filter((name) => !lock.groups?.[name]);

	if (unknown.length) {
		throw error(400, `unknown group(s): ${unknown.join(', ')}`);
	}

	// per-instance overrides to evaluate, JSON-encoded ({"fawe":true,"tab":false});
	// omitted → the instance's stored ones
	let overrides: Record<string, boolean> | undefined;
	const rawOverrides = url.searchParams.get('overrides');

	if (rawOverrides) {
		try {
			overrides = JSON.parse(rawOverrides);
		} catch {
			throw error(400, 'overrides must be a JSON object of plugin → boolean');
		}
	}

	const rows = validateGroups(cfg, lock, { software, mcVersion, groups, instance, overrides });

	return json({
		// where deploy would put each matched build. The java-agent picker in the
		// launch wizard needs it and has no instance to ask, which is the whole
		// reason this route answers for a prospective instance in the first place.
		rows: rows.map((row) => {
			const pooled = row.entry ? lock.plugins[row.entry] : undefined;

			if (!pooled) {
				return row;
			}

			return { ...row, deployPath: `${addonDirForFamily(pooled.family)}/${pooled.file}` };
		})
	});
}
