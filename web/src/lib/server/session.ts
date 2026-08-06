// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Console session cookie: the one place the console decides how a browser
 * carries its session, so the gate in `hooks.server.ts`, the sign-in route and
 * the sign-out route cannot disagree about it.
 *
 * The token is minted by the daemon (`core/accounts.signIn`) and only its digest
 * is stored, so the cookie is the single copy that exists. It is httpOnly for
 * that reason: nothing in the browser has any use for reading it, and script
 * access is the whole attack surface of a bearer token in a page.
 */

import type { Cookies } from '@sveltejs/kit';

import { appendJournal } from '$core/journal';

export const SESSION_COOKIE = 'luna_session';

/**
 * Whether this request actually arrived over TLS, which decides the cookie's
 * `Secure` flag.
 *
 * Never ask `url.protocol`: adapter-node builds the request origin with
 * `protocol_header || 'https'`, so with no `PROTOCOL_HEADER` configured every
 * request claims https even when the console is plain HTTP on a LAN address. A
 * `Secure` cookie is then dropped by the browser, the session never comes back,
 * and a sign-in that succeeded server-side reads as "the login did nothing".
 *
 * The forwarded header is the one positive signal there is, so this defaults to
 * insecure and only says https when a TLS-terminating proxy declares it.
 */
export function isSecureRequest(request: Request): boolean {
	return request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
}

/**
 * Store a freshly minted session token.
 *
 * `https` comes from `isSecureRequest`, so a LAN console over plain HTTP does
 * not mark the cookie `Secure` and lose it on the next request.
 */
export function setSessionCookie(
	cookies: Cookies,
	token: string,
	expiresAt: number,
	https: boolean
): void {
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: https,
		expires: new Date(expiresAt)
	});
}

/** Drop the session cookie; the sign-out half of the pair above. */
export function clearSessionCookie(cookies: Cookies, https: boolean): void {
	cookies.delete(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: https });
}

/**
 * Note something in the console journal from a web route.
 *
 * Fire-and-forget: the journal is a side effect of handling a request, and an
 * unwritable log must not turn a successful sign-in into a 500. Only meaningful
 * events go in here; a per-request trace would drown the screen that reads it.
 */
export function journal(
	message: string,
	opts: { level?: 'debug' | 'info' | 'warn' | 'error'; actor?: string; detail?: string } = {}
): void {
	void appendJournal({
		source: 'web',
		level: opts.level ?? 'info',
		message,
		actor: opts.actor,
		detail: opts.detail
	}).catch(() => {});
}

/** Client address of a request, for the audit trail. */
export function clientIp(request: Request, address: string | undefined): string | undefined {
	// behind a reverse proxy the socket address is the proxy's; the header is what
	// carries the operator's own address, and both are only ever recorded, never
	// trusted for a decision
	const forwarded = request.headers.get('x-forwarded-for');

	if (forwarded) {
		return forwarded.split(',')[0]?.trim();
	}

	return address;
}
