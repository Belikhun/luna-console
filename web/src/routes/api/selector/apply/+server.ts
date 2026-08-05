// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { loadCluster } from '$core/config';
import { apply } from '$core/selector';
import { startJob } from '$lib/server/jobs';
import { pushEvent } from '$lib/server/luna';

/**
 * POST → write servers.yml and reload the proxy.
 *
 * A job rather than a plain request: the reload drops the proxy's HTTP server
 * mid-call and the apply waits for it to come back, which is longer than a page
 * should hold a fetch open.
 */
export async function POST() {
	const cfg = await loadCluster();

	const job = startJob('selector-apply', 'proxy', 'Apply server selector', async (reporter) => {
		const result = await apply(cfg, { reporter });
		pushEvent('proxy', 'action', `server selector applied (${result.placed} server(s))`);

		return result;
	});

	return json({ job });
}
