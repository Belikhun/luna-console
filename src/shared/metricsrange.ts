// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The windows an instance's monitoring can be read over. `1h` is the daemon's
 * live hour in memory; the rest come from the persisted record, so none may
 * reach past what it keeps (`METRICS_KEEP_DAYS`).
 */

/** Every window, shortest first. */
export const METRICS_RANGES = ["1h", "6h", "24h", "7d", "30d", "90d", "1y"] as const;

export type MetricsRange = (typeof METRICS_RANGES)[number];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const SPANS: Record<MetricsRange, number> = {
	"1h": HOUR,
	"6h": 6 * HOUR,
	"24h": DAY,
	"7d": 7 * DAY,
	"30d": 30 * DAY,
	"90d": 90 * DAY,
	"1y": 365 * DAY,
};

/** A window's length in milliseconds. */
export function rangeMs(range: MetricsRange): number {
	return SPANS[range];
}
