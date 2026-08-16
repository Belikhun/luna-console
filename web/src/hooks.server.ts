// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The console's front door.
 *
 * Every request resolves its session cookie once, here, and hangs the account on
 * `event.locals` so no route repeats the check. Anything without a session is
 * refused: a page redirects to `/login` carrying where it was going, an API route
 * answers 401 with a JSON body, because `$lib/api` surfaces that body verbatim
 * and "Not signed in" is more use to the operator than a bare status.
 *
 * The gate covers the terminal drawer and its `__complete` engine too, which is
 * the point: those run the real CLI, so an ungated console port was a shell.
 */

import { redirect, type Handle } from '@sveltejs/kit';

import { resolveSession } from '$core/accounts';
import { SESSION_COOKIE } from '$lib/server/session';

/**
 * Routes reachable without a session, and the only ones. `/login` is the screen;
 * the two auth endpoints are what it posts to, including the first-run form that
 * creates the very first account.
 */
const PUBLIC_ROUTES = new Set(['/login', '/api/auth/session', '/api/auth/bootstrap']);

/**
 * Subtrees that are ungated in full: the public page and the endpoints it reads.
 *
 * A prefix rather than a list because the page has a route per instance and a
 * catch-all for the map proxy, and an allowlist that has to be edited whenever a
 * route is added is an allowlist that will eventually be wrong. The gate these
 * routes carry instead is their own: every one of them refuses unless the
 * cluster has the public page switched on, and the per-instance ones refuse
 * unless that instance opted in.
 */
const PUBLIC_PREFIXES = ['/public', '/api/public'];

/**
 * Whether a request landed in an ungated subtree.
 *
 * Keyed on the matched **route**, not on the URL text. The public page is served
 * at the root of its own domain by the `reroute` hook, which resolves `/` to the
 * `/public` route without touching the address; the pathname is still `/` by the
 * time this runs, so a check on the pathname would gate the landing page and
 * bounce a visitor with no account to the login screen.
 *
 * A route id also cannot be talked into matching by a crafted URL, which a
 * pathname prefix very nearly can.
 */
function isPublicRoute(routeId: string | null): boolean {
	if (routeId === null) {
		return false;
	}

	return PUBLIC_PREFIXES.some(
		(prefix) => routeId === prefix || routeId.startsWith(`${prefix}/`)
	);
}

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE) ?? null;

	event.locals.account = null;
	event.locals.sessionToken = token;
	event.locals.sessionId = null;

	if (token) {
		try {
			const resolved = await resolveSession(token);

			if (resolved) {
				event.locals.account = resolved.account;
				event.locals.sessionId = resolved.session.id;
			}
		} catch (err) {
			// the daemon is unreachable: treat the request as unauthenticated rather
			// than as authenticated, and let the login screen report the real fault
			console.error('session check failed', err);
		}
	}

	// route.id is null for anything SvelteKit has no route for; static assets
	// (the fonts, the icon set) and 404s are not the gate's business
	const gated =
		event.route.id !== null &&
		!PUBLIC_ROUTES.has(event.url.pathname) &&
		!isPublicRoute(event.route.id);

	if (gated && !event.locals.account) {
		if (event.url.pathname.startsWith('/api/')) {
			return new Response(JSON.stringify({ message: 'Not signed in' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' }
			});
		}

		const next = event.url.pathname + event.url.search;

		throw redirect(303, `/login?next=${encodeURIComponent(next)}`);
	}

	// a signed-in operator who lands on /login gets sent where they were going,
	// so a stale bookmark is not a dead end
	if (event.url.pathname === '/login' && event.locals.account) {
		throw redirect(303, event.url.searchParams.get('next') || '/instances');
	}

	return await resolve(event);
};
