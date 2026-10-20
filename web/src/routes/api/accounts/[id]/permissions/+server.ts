// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { accountPermissions } from '$core/iam';
import { errorMessage } from '$lib/server/http';

/** GET → the account's groups, attached and inline policies, tags and effective documents. */
export async function GET({ params }) {
	try {
		return json({ permissions: await accountPermissions(params.id) });
	} catch (err) {
		throw error(404, errorMessage(err));
	}
}
