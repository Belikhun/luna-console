// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Player facts the console draws the same way on every screen.
 *
 * The latency bands are the thresholds the proxy's own tab list uses, so a ping
 * the console paints amber is one the player sees amber too.
 */

/** Latency bands, in ms. */
export const PING_FAIR = 120;
export const PING_POOR = 250;

/** The band a ping falls in, as the class name the screens colour by. */
export function pingClass(ping: number): 'good' | 'fair' | 'poor' {
	if (ping < PING_FAIR) {
		return 'good';
	}

	return ping < PING_POOR ? 'fair' : 'poor';
}
