// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { stopRun } from '$lib/server/agent/runner';

/** POST → { stopped }: ends the conversation's run, denying anything still waiting. */
export async function POST({ params, locals }) {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	return json({ stopped: stopRun(params.id, locals.account.username) });
}
