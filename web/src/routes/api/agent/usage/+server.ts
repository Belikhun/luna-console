// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { errorMessage } from '$lib/server/http';
import { agentUsage } from '$lib/server/agent/runner';

/** GET [?fresh=1] → the credential's plan usage windows, as Claude Code's `/usage` reads them. */
export async function GET({ locals, url }) {
	try {
		return json(await agentUsage(locals.account?.username ?? 'root', url.searchParams.has('fresh')));
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
