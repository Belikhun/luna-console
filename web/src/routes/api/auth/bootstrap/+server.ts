// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { bootstrapAccount, signIn } from '$core/accounts';
import { errorMessage, jsonBody } from '$lib/server/http';
import { clientIp, isSecureRequest, journal, setSessionCookie } from '$lib/server/session';

/**
 * First run: create the console's first account, from the login screen.
 *
 * This is public, and it has to be; a console with no accounts has nobody who
 * could authenticate the request that creates one. What makes it safe is that
 * core refuses outright once any account exists, so the window closes the moment
 * the first account is created and never reopens.
 *
 * The new account is signed in immediately: making an operator retype the
 * password they just chose adds nothing, and leaving them on a login form after a
 * successful creation reads as a failure.
 */
export async function POST({ request, cookies, getClientAddress }) {
	const body = await jsonBody(request);
	const username = String(body.username ?? '').trim();
	const password = String(body.password ?? '');
	const ip = clientIp(request, getClientAddress());

	if (!username || !password) {
		throw error(400, 'a username and a password are required');
	}

	try {
		const account = await bootstrapAccount({ username, password }, { ip });
		const session = await signIn(username, password, {
			ip,
			agent: request.headers.get('user-agent') ?? undefined
		});

		setSessionCookie(cookies, session.token, session.expiresAt, isSecureRequest(request));
		journal(`first console account ${account.username} created`, {
			level: 'warn',
			actor: account.username,
			detail: ip
		});

		return json({ account: session.account, expiresAt: session.expiresAt });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
