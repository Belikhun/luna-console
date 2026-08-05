// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { loadCluster } from '$core/config';
import { preview } from '$core/selector';

/** GET → the servers.yml luna would write, for review before applying. */
export async function GET() {
	const cfg = await loadCluster();

	return new Response(await preview(cfg), {
		headers: { 'Content-Type': 'text/plain; charset=utf-8' }
	});
}
