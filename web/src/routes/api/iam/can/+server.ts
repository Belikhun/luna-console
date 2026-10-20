// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { authorize } from '$core/iam';
import { jsonBody } from '$lib/server/http';

/**
 * POST { checks: [{ action, resource }] } → { results: { "action|resource": boolean } }.
 *
 * What a screen asks about its own verbs: the browser knows the policies but not
 * the resources' records, so a question about one resource is the daemon's.
 * Always about the signed-in account; never a way to ask about somebody else.
 */
export async function POST({ request, locals }) {
	const body = await jsonBody(request);
	const checks = Array.isArray(body.checks) ? body.checks.slice(0, 200) : [];
	const results: Record<string, boolean> = {};
	const username = locals.account?.username ?? '';

	for (const check of checks) {
		const action = String(check?.action ?? '');
		const resource = String(check?.resource ?? '');

		if (!action) {
			continue;
		}

		const outcome = await authorize(username, action, resource || null);

		results[`${action}|${resource}`] = outcome.verdict.allowed;
	}

	return json({ results });
}
