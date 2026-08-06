// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What a console account's username and password have to look like.
 *
 * These live in `shared/` rather than in `core/accounts` because both sides need
 * them and only one side can have `core/`: the create form validates as the
 * operator types, and a Svelte component cannot import the client bridge, which
 * reaches the daemon over a unix socket. The daemon still enforces every rule
 * here on the way in; the browser copy is there to say so before the round trip,
 * never instead of it.
 */

/** Names an account can be created under; also what a sign-in form accepts. */
export const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{2,31}$/;

/** Shortest password the store accepts. Long beats clever, so this is the only rule. */
export const MIN_PASSWORD_LENGTH = 10;

/** Whether a string is a usable console username. */
export function isUsername(value: string): boolean {
	return USERNAME_PATTERN.test(value);
}

/** Whether a string is long enough to be a console password. */
export function isPassword(value: string): boolean {
	return value.length >= MIN_PASSWORD_LENGTH;
}
