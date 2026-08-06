// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { auditTrail, deleteAccount, getAccount, listSessions, updateAccount } from '$core/accounts';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';

/** One account: its detail screen, its editable fields, and its removal. */

/** GET → the account, its sessions and the trail that names it. */
export async function GET({ params, locals }) {
	const account = await getAccount(params.id);

	if (!account) {
		throw error(404, `no console account named ${params.id}`);
	}

	const [sessions, audit] = await Promise.all([
		listSessions({ account: account.id, currentToken: locals.sessionToken ?? undefined }),
		auditTrail({ account: account.username, limit: 200 })
	]);

	return json({ account, sessions, audit, self: account.id === locals.account?.id });
}

/** PATCH { username?, displayName?, email?, description?, enabled?, unlock? } → edit it. */
export async function PATCH({ params, request, locals }) {
	const body = await jsonBody(request);
	const account = await getAccount(params.id);

	if (!account) {
		throw error(404, `no console account named ${params.id}`);
	}

	// disabling yourself would close the session making the request; the screen
	// disables the verb too, and this is the half that cannot be bypassed
	if (body.enabled === false && account.id === locals.account?.id) {
		throw error(400, 'you cannot disable the account you are signed in as');
	}

	try {
		const updated = await updateAccount(
			account.id,
			{
				username: body.username !== undefined ? String(body.username).trim() : undefined,
				displayName: body.displayName !== undefined ? String(body.displayName) : undefined,
				email: body.email !== undefined ? String(body.email) : undefined,
				description: body.description !== undefined ? String(body.description) : undefined,
				enabled: body.enabled !== undefined ? !!body.enabled : undefined,
				mustChangePassword:
					body.mustChangePassword !== undefined ? !!body.mustChangePassword : undefined,
				unlock: !!body.unlock
			},
			locals.account?.username
		);

		journal(`console account ${updated.username} updated`, { actor: locals.account?.username });

		return json({ account: updated });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE → remove the account and every session it holds. */
export async function DELETE({ params, locals }) {
	const account = await getAccount(params.id);

	if (!account) {
		throw error(404, `no console account named ${params.id}`);
	}

	if (account.id === locals.account?.id) {
		throw error(400, 'you cannot delete the account you are signed in as');
	}

	try {
		await deleteAccount(account.id, locals.account?.username);
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	journal(`console account ${account.username} deleted`, {
		level: 'warn',
		actor: locals.account?.username
	});

	return json({ ok: true });
}
