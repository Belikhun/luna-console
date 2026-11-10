// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { errorMessage } from '$lib/server/http';
import { refreshModels } from '$lib/server/agent/runner';

/** POST → ask Anthropic (else the Claude Code subprocess) which models the credential can use, and keep the list. */
export async function POST({ locals }) {
	try {
		return json(await refreshModels(locals.account?.username ?? 'root'));
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
