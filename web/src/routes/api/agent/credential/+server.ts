// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { clearAgentCredential, setAgentCredential } from '$core/agent';
import { errorMessage, jsonBody } from '$lib/server/http';

/**
 * The credential Mèo Béo runs on. Write-only: a PUT stores it and answers with
 * the masked status; nothing here, or anywhere, reads it back.
 */

/** PUT { value } → status. */
export async function PUT({ request, locals }) {
	const body = await jsonBody(request);

	try {
		return json(await setAgentCredential(String(body.value ?? ''), locals.account?.username));
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE → status, with no credential. */
export async function DELETE({ locals }) {
	return json(await clearAgentCredential(locals.account?.username));
}
