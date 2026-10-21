// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { listDaemons } from '$client/daemon';
import { scopeRows } from '$lib/server/fleetscope';

/** GET → every daemon in the cluster: the primary plus known followers, live state included. */
export async function GET({ locals }) {
	const rows = (await listDaemons()) as unknown as Array<Record<string, unknown>>;

	return json({ daemons: await scopeRows(locals.account?.username, rows) });
}
