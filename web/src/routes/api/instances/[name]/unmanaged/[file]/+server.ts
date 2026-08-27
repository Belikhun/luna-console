// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, loadLock, managedInstances } from '$core/config';
import { unmanagedAddonLog } from '$core/pluginstate';
import type { AddonDir } from '$core/types';
import { errorMessage } from '$lib/server/http';

/**
 * GET → one addon jar that no lock entry claims, plus every line of the current
 * boot session attributed to it.
 *
 * The managed equivalent lives at `plugins/[plugin]`, and the two answer the same
 * question about the same log; they are separate routes because they identify
 * their subject differently. A managed addon is a lockfile key, which is stable
 * and unique; an unmanaged one is only ever a file on disk, so the file name is
 * the id, and `dir` disambiguates the one case where two of them can collide - a
 * hybrid server running both `plugins/` and `mods/`.
 *
 * The whole answer comes from one core call, which runs on the machine holding the
 * instance. It has to: the names this addon logs under are read out of the jar,
 * and only that machine has the jar. Assembling it here from the report's rows
 * instead meant an older daemon could return rows without them and the route
 * would answer with an empty log - a dialog claiming nothing was logged beside a
 * row reporting 322 errors.
 */
export async function GET({ params, url }) {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	const dir = url.searchParams.get('dir') as AddonDir | null;

	let found: Awaited<ReturnType<typeof unmanagedAddonLog>>;

	try {
		found = await unmanagedAddonLog(cfg, await loadLock(), params.name, params.file, dir ?? undefined);
	} catch (err) {
		// Named rather than left as a bare 500, because the likeliest cause is
		// specific and actionable: the daemon that owns this instance is on a build
		// without this operation, and the message says which one is missing.
		throw error(502, errorMessage(err));
	}

	if (!found) {
		throw error(404, 'no such unmanaged addon on this instance');
	}

	return json({
		row: found.row,
		sessionComplete: found.sessionComplete,
		log: {
			lines: found.lines,
			warnings: found.warnings,
			errors: found.errors
		}
	});
}
