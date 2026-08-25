// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * How unstable a release luna will accept from a provider.
 *
 * Three strings and the arithmetic over them, in a module of their own with
 * **no imports at all**. They used to live in `services/providers.ts`, which is
 * the right home for the vocabulary but the wrong one for a console component to
 * read it from: that module pulls in the four provider clients, and through them
 * `node:fs`, so a Svelte component value-importing from it dies at hydration on
 * an externalised `node:fs` and SvelteKit renders a 500 over a perfectly good
 * SSR pass. Same rule `core/settings.ts` and `core/memory.ts` state.
 *
 * `services/providers.ts` re-exports all three, so nothing that already imported
 * them from there had to change.
 */

export type ReleaseChannel = "release" | "beta" | "alpha";

/**
 * Every channel, stable first, which is also the order they rank in.
 *
 * A list beside the type so a picker, a shell completion and a validator all
 * read the same three strings; the type alone cannot be enumerated at runtime,
 * and the three had been spelled out by hand at each of those call sites.
 */
export const RELEASE_CHANNELS: ReleaseChannel[] = ["release", "beta", "alpha"];

/** Whether a string names a release channel. */
export function isReleaseChannel(value: string): value is ReleaseChannel {
	return (RELEASE_CHANNELS as string[]).includes(value);
}
