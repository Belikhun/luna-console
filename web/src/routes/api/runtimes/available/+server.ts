// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster } from '$core/config';
import { available } from '$core/runtimes';
import { listDaemons } from '$client/daemon';
import { machineKeyFor } from '$shared/machines';
import { errorMessage } from '$lib/server/http';

/**
 * GET ?machine=&vendor=&feature=&refresh= → the runtimes the vendors publish
 * for that machine's platform. The machine matters: an arm64 follower and an
 * x64 primary are offered different archives for the same version.
 */
export async function GET({ url }) {
	const cfg = await loadCluster();
	const typed = url.searchParams.get('machine') ?? '';
	const key = machineKeyFor(await listDaemons(), typed);

	if (key === undefined) {
		throw error(400, `unknown machine: ${typed}`);
	}

	const feature = url.searchParams.get('feature');
	const parsed = feature ? Number.parseInt(feature, 10) : undefined;

	if (feature && !parsed) {
		throw error(400, `not a feature release: ${feature}`);
	}

	try {
		const runtimes = await available(cfg, key, {
			vendor: url.searchParams.get('vendor') ?? undefined,
			feature: parsed,
			refresh: url.searchParams.get('refresh') === '1'
		});

		return json({ runtimes });
	} catch (err) {
		// the vendors are somebody else's uptime; say so rather than 500ing
		throw error(502, errorMessage(err));
	}
}
