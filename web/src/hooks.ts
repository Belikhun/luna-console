// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Serving the public page at the root of its own domain.
 *
 * `mc.belikhun.dev/` should *be* the public page, not bounce to
 * `mc.belikhun.dev/public`. Doing that in nginx alone does not work: nginx can
 * proxy `/` to `/public` and the server renders the right HTML, but the browser
 * is still sitting on `/`, and this is a SvelteKit app - its client router
 * resolves the route from the address bar, reads `/` as the console's own root,
 * and that route redirects to `/instances`. The visitor would watch the public
 * page appear and then navigate away from itself.
 *
 * `reroute` is the hook for exactly this. It is *universal*: the same function
 * runs on the server and in the browser, so both sides resolve `/` to the same
 * route and the address bar is never touched. This file is `hooks.ts` rather
 * than `hooks.server.ts` for that reason - a server-only version would fix the
 * first paint and leave the router disagreeing.
 */

import { env } from '$env/dynamic/public';

/**
 * The hostname the public page owns, e.g. `mc.belikhun.dev`.
 *
 * Set by `luna web` from `publicSite.address`, so an operator configures the
 * address once and nothing here needs editing. It reaches the browser because
 * `$env/dynamic/public` is serialized into the page, which is what lets the
 * client half of this hook make the same decision as the server half.
 *
 * Empty when the public page is off or has no address, and then this hook does
 * nothing at all: `/` stays the console's root, which is what every other
 * hostname wants.
 */
const publicHost = (env.PUBLIC_LUNA_SITE_HOST ?? '').trim().toLowerCase();

/** Map a URL onto a route without changing the address the visitor sees. */
export function reroute({ url }: { url: URL }): string | undefined {
	// only the bare root: every other path on this domain is either the public
	// tree already or something nginx never proxies here
	if (url.pathname !== '/' || !publicHost) {
		return undefined;
	}

	if (url.hostname.toLowerCase() !== publicHost) {
		return undefined;
	}

	return '/public';
}
