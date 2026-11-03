// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { revokeHeld } from '$lib/server/agent/runner';
import { conversationFor } from '$lib/server/agent/sharing';

/** DELETE → { revoked }: take back a held message before it is sent; only its sender may. */
export async function DELETE({ params, locals }) {
	const { account } = await conversationFor(locals, params.id);

	if (!revokeHeld(params.id, account, params.uuid)) {
		throw error(404, 'no such message waiting');
	}

	return json({ revoked: true });
}
