// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';
import { root } from '$core/config';
import { diskUsage } from '$core/cleanup';
import { ensureConnected } from '$client/socket';
import { readHostMemMb } from '$lib/server/luna';

/** Host vitals for the console chrome: daemon name, cluster root, disk usage, total RAM. */
export async function GET() {
	const info = await ensureConnected();

	return json({
		name: info.name,
		root: root(),
		disk: await diskUsage(root()),
		hostMemMb: await readHostMemMb()
	});
}
