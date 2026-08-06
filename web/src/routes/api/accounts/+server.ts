// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { auditTrail, createAccount, listAccounts, listSessions } from '$core/accounts';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';

/**
 * The Accounts screen's rows, and account creation.
 *
 * Everything here is already masked: `$core/accounts` has no bridge that could
 * return a password hash, so a route cannot leak one by forgetting to strip it.
 */

/** GET → every account, the open sessions and the audit trail, for one load. */
export async function GET({ locals, url }) {
	const [accounts, sessions, audit] = await Promise.all([
		listAccounts(),
		listSessions({ currentToken: locals.sessionToken ?? undefined }),
		auditTrail({ limit: Number(url.searchParams.get('audit') ?? 200) })
	]);

	return json({ accounts, sessions, audit, self: locals.account?.id ?? null });
}

/** POST { username, password?, displayName?, email?, description?, ... } → create one. */
export async function POST({ request, locals }) {
	const body = await jsonBody(request);

	try {
		const account = await createAccount(
			{
				username: String(body.username ?? '').trim(),
				password: body.password ? String(body.password) : undefined,
				displayName: body.displayName ? String(body.displayName) : undefined,
				email: body.email ? String(body.email) : undefined,
				description: body.description ? String(body.description) : undefined,
				mustChangePassword: !!body.mustChangePassword,
				disabled: !!body.disabled
			},
			locals.account?.username
		);

		journal(`console account ${account.username} created`, { actor: locals.account?.username });

		return json({ account });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
