// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { dropUpload } from '$lib/server/agent/uploads';

/** DELETE → { dropped }: discard an attachment its owner removed before sending. */
export async function DELETE({ params, locals }) {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	return json({ dropped: await dropUpload(params.id, locals.account.username) });
}
