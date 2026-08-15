// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/uptime. Everything here is arithmetic over a record the
 * caller already has, so it all runs locally; reading the record itself is
 * `publicsite.uptimeSeries`, since the store lives in the primary daemon.
 */

export {
	RETENTION_DAYS,
	UPTIME_BANDS,
	bandFor,
	dayKey,
	isUp,
	series,
	slotTone,
} from "../../core/uptime";

export type {
	UptimeBand,
	UptimeDay,
	UptimeRecord,
	UptimeSeries,
	UptimeStore,
	UptimeTone,
} from "../../core/uptime";
