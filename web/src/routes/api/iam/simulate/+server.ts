// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { authorize } from '$core/iam';
import { errorMessage, jsonBody } from '$lib/server/http';

/** POST { account, action, resource? } → the verdict and the statement that decided it. */
export async function POST({ request }) {
	const body = await jsonBody(request);
	const account = String(body.account ?? '');
	const action = String(body.action ?? '');

	if (!account || !action) {
		throw error(400, 'an account and an action are required');
	}

	try {
		const resource = typeof body.resource === 'string' && body.resource ? body.resource : null;

		return json(await authorize(account, action, resource));
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
