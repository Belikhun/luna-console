// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { errorMessage } from '$lib/server/http';
import { testConnection } from '$lib/server/agent/runner';

/** POST → one tool-less turn against the stored credential, plus the models it can use. */
export async function POST({ locals }) {
	try {
		return json(await testConnection(locals.account?.username ?? 'root'));
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
