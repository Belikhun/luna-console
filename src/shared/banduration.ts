// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The ban-length grammar the CLI and the MCP tools share with LunaCore's own
 * proxy commands: one or more number-unit pairs (30m, 12h, 7d, 2w, 1d12h), or
 * "perm" for a ban that never ends.
 */

const UNIT_MS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
	y: 31_536_000_000,
};

const DURATION = /^(?:\d+[smhdwy])+$/i;

const PERMANENT = new Set(["perm", "permanent", "forever", "never"]);

/** A ban length in milliseconds; 0 means permanent, null means the text is not a length. */
export function parseBanDuration(text: string): number | null {
	const trimmed = text.trim().toLowerCase();

	if (PERMANENT.has(trimmed)) {
		return 0;
	}

	if (!DURATION.test(trimmed)) {
		return null;
	}

	let total = 0;

	for (const match of trimmed.matchAll(/(\d+)([smhdwy])/g)) {
		total += Number(match[1]) * UNIT_MS[match[2]!]!;
	}

	return total;
}

/**
 * When a ban of that length placed now ends, as epoch millis: 0 for permanent
 * (also when no length is given), null when the text is not a length.
 */
export function banExpiry(text: string | undefined, now = Date.now()): number | null {
	if (text === undefined || text.trim() === "") {
		return 0;
	}

	const length = parseBanDuration(text);

	if (length === null) {
		return null;
	}

	return length === 0
		? 0
		: now + length;
}
