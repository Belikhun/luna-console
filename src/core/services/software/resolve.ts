// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Helpers the software provider clients share. Kept apart from the registry
 * because the registry imports the clients, and a client importing it back
 * would close the loop.
 */

/** How long a fetched upstream document is reused. Matches the registry's TTL. */
const DOCUMENT_TTL_MS = 10 * 60_000;

/**
 * Memoize one upstream document.
 *
 * Several providers answer every question luna has out of a single large
 * document: forge's maven metadata lists every build ever released, neoforge's
 * version index is asked once per Minecraft version by a loader picker, and
 * pumpkin's release list comes from an API with a 60-per-hour anonymous limit.
 * Caching the derived lists (which the registry does) still re-downloads the
 * document behind each one, so the document itself is held here.
 */
export function memoized<T>(fetcher: () => Promise<T>): () => Promise<T> {
	let cached: { at: number; value: T } | undefined;
	let inflight: Promise<T> | undefined;

	return async () => {
		if (cached && Date.now() - cached.at < DOCUMENT_TTL_MS) {
			return cached.value;
		}

		// concurrent callers share one request rather than racing to replace it
		if (!inflight) {
			inflight = fetcher()
				.then((value) => {
					cached = { at: Date.now(), value };

					return value;
				})
				.finally(() => {
					inflight = undefined;
				});
		}

		return await inflight;
	};
}
