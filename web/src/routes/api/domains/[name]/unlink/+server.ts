// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster } from '$core/config';
import { unlinkHostname } from '$core/domains';
import { errorMessage } from '$lib/server/http';
import { journal } from '$lib/server/session';

/** POST → stop routing the hostname to its instance; the record stays. */
export async function POST({ params, locals }) {
	const actor = locals.account?.username ?? 'console';

	try {
		const result = await unlinkHostname(await loadCluster(), params.name, actor);

		journal(`hostname ${result.hostname.fqdn} unlinked`, { actor });

		return json(result);
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
