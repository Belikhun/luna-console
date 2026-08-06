// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { getAccount, listSessions, revokeAccountSessions, revokeSession } from '$core/accounts';
import { journal } from '$lib/server/session';

/** One account's open sessions, and closing them. */

/** GET → the account's sessions, newest activity first. */
export async function GET({ params, locals }) {
	const account = await getAccount(params.id);

	if (!account) {
		throw error(404, `no console account named ${params.id}`);
	}

	return json({
		sessions: await listSessions({
			account: account.id,
			currentToken: locals.sessionToken ?? undefined
		})
	});
}

/**
 * DELETE ?session= → close one; with no `session`, close every session the
 * account holds. Closing your own account's sessions keeps the one making the
 * request, so "sign out everywhere else" does not sign you out of here.
 */
export async function DELETE({ params, url, locals }) {
	const account = await getAccount(params.id);

	if (!account) {
		throw error(404, `no console account named ${params.id}`);
	}

	const sessionId = url.searchParams.get('session');

	if (sessionId) {
		if (!(await revokeSession(sessionId, locals.account?.username))) {
			throw error(404, `no open session with id ${sessionId}`);
		}

		journal(`console session closed for ${account.username}`, {
			actor: locals.account?.username
		});

		return json({ ok: true, closed: 1 });
	}

	const keepOwn = account.id === locals.account?.id;
	const closed = await revokeAccountSessions(account.id, {
		keepToken: keepOwn ? (locals.sessionToken ?? undefined) : undefined,
		actor: locals.account?.username
	});

	journal(`${closed} console session(s) closed for ${account.username}`, {
		actor: locals.account?.username
	});

	return json({ ok: true, closed });
}
