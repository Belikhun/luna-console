// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Where the public page lives on the hostname it is being asked for.
 *
 * Two answers, and which one is right depends on the address in the bar. On the
 * site's own domain the landing page *is* the root, resolved there by the
 * `reroute` hook; anywhere else - the dev server, the LAN address, the console's
 * own hostname - it is `/public`, because `/` is the console's root there.
 *
 * Shared rather than repeated so the hook and every link on the page agree. A
 * link that hardcoded `/public` would work, but it would move a visitor who
 * arrived at `mc.belikhun.dev` onto `mc.belikhun.dev/public` the first time they
 * pressed Back, and leave two addresses for one page.
 */

import { env } from '$env/dynamic/public';

/**
 * The hostname the public page owns, e.g. `mc.belikhun.dev`.
 *
 * Set by `luna web` from `publicSite.address`. Empty when the public page is off
 * or has no address, and then nothing here claims any hostname.
 */
const publicHost = (env.PUBLIC_LUNA_SITE_HOST ?? '').trim().toLowerCase();

/** Whether this URL is on the hostname the public page owns. */
export function isPublicHost(url: URL): boolean {
	if (!publicHost) {
		return false;
	}

	return url.hostname.toLowerCase() === publicHost;
}

/** The public landing page's address on the hostname this URL is on. */
export function publicHome(url: URL): string {
	return isPublicHost(url) ? '/' : '/public';
}
