// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The public page's read path, cached once for the whole process.
 *
 * Every other console endpoint answers one signed-in operator, so a round trip
 * to the daemon per request is fine. This one answers the internet: a link
 * posted anywhere turns into as many concurrent requests as there are readers,
 * and each snapshot walks every instance's status and the whole fleet's health.
 * The cache is what keeps that from becoming a load test against the daemon,
 * so it is load-bearing rather than an optimisation.
 *
 * Single-flight matters as much as the TTL. Without it, N requests arriving
 * together on a cold cache all miss and all call through; with it they await
 * the same promise and one call serves them.
 */

import { snapshot as fetchSnapshot } from '$core/publicsite';
import type { PublicSnapshot } from '$core/publicsite';

/**
 * How stale a reader may find the page.
 *
 * The daemon samples every five seconds, so anything shorter buys precision
 * that does not exist.
 */
const TTL_MS = 2000;

let cached: PublicSnapshot | null = null;
let cachedAt = 0;
let inflight: Promise<PublicSnapshot | null> | null = null;

/**
 * The current snapshot, or null when the public page is switched off.
 *
 * `null` is cached like any other answer: a disabled cluster being hammered
 * should cost no more than an enabled one.
 */
export async function publicSnapshot(): Promise<PublicSnapshot | null> {
	if (inflight) {
		return await inflight;
	}

	if (cached !== null && Date.now() - cachedAt < TTL_MS) {
		return cached;
	}

	// a disabled page caches its null too, which is why the age is checked before
	// the value rather than treating null as "not cached yet"
	if (cached === null && cachedAt > 0 && Date.now() - cachedAt < TTL_MS) {
		return null;
	}

	inflight = (async () => {
		try {
			const fresh = await fetchSnapshot();

			cached = fresh;
			cachedAt = Date.now();

			return fresh;
		} finally {
			inflight = null;
		}
	})();

	return await inflight;
}

/** Forget the cached snapshot; used after the site's own settings change. */
export function invalidatePublicSnapshot(): void {
	cached = null;
	cachedAt = 0;
}
