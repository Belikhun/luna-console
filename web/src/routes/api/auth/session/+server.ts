// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { bootstrapNeeded, signIn, signOut } from '$core/accounts';
import { errorMessage, jsonBody } from '$lib/server/http';
import {
	clearSessionCookie,
	clientIp,
	isSecureRequest,
	journal,
	setSessionCookie
} from '$lib/server/session';

/**
 * The session endpoint: the one route reachable without a session, because it is
 * how a session is obtained. GET answers "who am I, and does this console still
 * need its first account"; POST signs in; DELETE signs out.
 */

/**
 * GET → the signed-in account, or null plus whether the first-run form applies.
 *
 * The login screen calls this before showing anything: a console with no accounts
 * has to offer account *creation*, and a console that already has them must not.
 */
export async function GET({ locals }) {
	// asking the daemon is only worth it when there is nobody signed in; an
	// account existing is itself proof that the bootstrap is done
	const bootstrap = locals.account ? false : await bootstrapNeeded().catch(() => false);

	return json({ account: locals.account, bootstrap });
}

/** POST { username, password } → open a session and set the cookie. */
export async function POST({ request, cookies, getClientAddress }) {
	const body = await jsonBody(request);
	const username = String(body.username ?? '').trim();
	const password = String(body.password ?? '');

	if (!username || !password) {
		throw error(400, 'a username and a password are required');
	}

	const ip = clientIp(request, getClientAddress());

	try {
		const result = await signIn(username, password, {
			ip,
			agent: request.headers.get('user-agent') ?? undefined
		});

		setSessionCookie(cookies, result.token, result.expiresAt, isSecureRequest(request));
		journal(`${result.account.username} signed in to the console`, {
			actor: result.account.username,
			detail: ip
		});

		return json({ account: result.account, expiresAt: result.expiresAt });
	} catch (err) {
		journal(`console sign-in refused for ${username}`, { level: 'warn', detail: ip });

		// core answers every refusal with the same message on purpose; forwarding it
		// as 401 keeps the screen from having to invent one
		throw error(401, errorMessage(err));
	}
}

/** DELETE → close this session and drop the cookie. */
export async function DELETE({ locals, cookies, request }) {
	if (locals.sessionToken) {
		await signOut(locals.sessionToken);
	}

	if (locals.account) {
		journal(`${locals.account.username} signed out`, { actor: locals.account.username });
	}

	clearSessionCookie(cookies, isSecureRequest(request));

	return json({ ok: true });
}
