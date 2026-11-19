// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The time ranges monitoring is read over. The console's range picker keeps
 * `?range=` in the address; an API route or an MCP tool turns it (or an
 * explicit `from`/`to`) into the window a series query reads.
 */

/** The relative ranges the console offers, shortest first. */
export const RANGE_PRESETS = ["1h", "6h", "24h", "7d", "30d"] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number];

/** Each preset's length in ms. */
export const RANGE_PRESET_MS: Readonly<Record<RangePreset, number>> = {
	"1h": 3_600_000,
	"6h": 6 * 3_600_000,
	"24h": 24 * 3_600_000,
	"7d": 7 * 86_400_000,
	"30d": 30 * 86_400_000,
};

/** The range a screen opens on and an API reads when none is named. */
export const DEFAULT_PRESET: RangePreset = "24h";

/** The longest window one query may cover. */
export const MAX_RANGE_MS = 400 * 86_400_000;

/** Whether a string names a preset. */
export function isRangePreset(value: string): value is RangePreset {
	return (RANGE_PRESETS as readonly string[]).includes(value);
}

/**
 * A fixed range as the console's address keeps it, `<from>-<to>` in epoch ms
 * (what a custom pick or a drag-to-zoom writes), or null when it is not one.
 */
export function parseFixedRange(value: string): { from: number; to: number } | null {
	const match = /^(\d{10,14})-(\d{10,14})$/.exec(value);

	if (!match) {
		return null;
	}

	return { from: Number(match[1]), to: Number(match[2]) };
}

/** What a caller asked for, before it is checked. */
export interface RangeInput {
	range?: string | null;
	from?: string | number | null;
	to?: string | number | null;
	step?: string | number | null;
}

/** A window ready for a series query, or why the input could not make one. */
export type RangeResult =
	| { ok: true; from: number; to: number; step?: number }
	| { ok: false; reason: "badRange" | "badWindow" | "tooLong" };

function epoch(value: string | number | null | undefined): number | null {
	if (value === null || value === undefined || value === "") {
		return null;
	}

	const number = typeof value === "number"
		? value
		: /^\d+$/.test(value)
			? Number(value)
			: Date.parse(value);

	return Number.isFinite(number)
		? number
		: null;
}

/**
 * Resolve a range: a preset ending now, a fixed `<from>-<to>` in `range`, or
 * `from` and `to` as epoch ms (or ISO dates). `to` alone defaults to now;
 * `from` alone, to a day before `to`.
 */
export function resolveRange(input: RangeInput, now: number): RangeResult {
	const stepGiven = epoch(input.step ?? null);
	const step = stepGiven !== null && stepGiven >= 1000
		? stepGiven
		: undefined;

	const fixed = input.range
		? parseFixedRange(input.range)
		: null;

	if (input.range && input.range !== "custom" && !fixed) {
		if (!isRangePreset(input.range)) {
			return { ok: false, reason: "badRange" };
		}

		return { ok: true, from: now - RANGE_PRESET_MS[input.range], to: now, step };
	}

	const to = fixed?.to ?? epoch(input.to ?? null) ?? now;
	const from = fixed?.from ?? epoch(input.from ?? null) ?? to - RANGE_PRESET_MS[DEFAULT_PRESET];

	if (from >= to) {
		return { ok: false, reason: "badWindow" };
	}

	if (to - from > MAX_RANGE_MS) {
		return { ok: false, reason: "tooLong" };
	}

	return { ok: true, from, to, step };
}
