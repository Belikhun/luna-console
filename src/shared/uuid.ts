// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The one test for "is this a UUID", shared by everything that accepts a
 * player reference: a hyphenated 8-4-4-4-12 hex string, any case. Kept here
 * rather than beside one caller because the CLI, the daemon and the console
 * routes all ask the same question and used to each carry their own regex.
 */

export const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Whether `text` is a hyphenated UUID; surrounding whitespace does not count. */
export function isUuid(text: string): boolean {
	return UUID_PATTERN.test(text.trim());
}
