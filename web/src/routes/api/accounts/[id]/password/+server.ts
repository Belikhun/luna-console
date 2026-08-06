// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { getAccount, revokeAccountSessions, setPassword } from '$core/accounts';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';

/**
 * Set an account's console password.
 *
 * Two shapes, and the difference matters: changing **your own** password requires
 * the current one, so a borrowed screen cannot be used to take the account over;
 * resetting **someone else's** does not, because an administrator resetting a
 * forgotten password has nothing to prove, and the reset flags the account so its
 * owner is asked to choose a new one on their next sign-in.
 *
 * Either way every other session the account holds is closed. A password change
 * that leaves the old sessions alive is not a password change.
 */
export async function POST({ params, request, locals }) {
	const body = await jsonBody(request);
	const account = await getAccount(params.id);

	if (!account) {
		throw error(404, `no console account named ${params.id}`);
	}

	const own = account.id === locals.account?.id;
	const password = String(body.password ?? '');

	if (own && !body.current) {
		throw error(400, 'changing your own password requires the current one');
	}

	try {
		await setPassword(account.id, password, {
			current: own ? String(body.current) : undefined,
			actor: locals.account?.username,
			reset: !own
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	const closed = await revokeAccountSessions(account.id, {
		keepToken: own ? (locals.sessionToken ?? undefined) : undefined,
		actor: locals.account?.username
	});

	journal(`console password set for ${account.username}`, {
		actor: locals.account?.username,
		detail: `${closed} session(s) closed`
	});

	return json({ ok: true, sessionsClosed: closed });
}
