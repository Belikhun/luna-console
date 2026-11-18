// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/metrics: the long record of each instance's figures
 * and events. Figures are read on the daemon that owns the instance, since
 * that is where they were measured and written; events are read on the
 * primary, which holds every machine's (followers forward theirs up).
 */

import { call } from "../rpc";
import type { MetricsWindow, StoredEvent } from "../../core/metrics";

export { HOST_GROUP, METRICS_KEEP_DAYS, MINUTE_KEEP_MS } from "../../core/metrics";
export type { MetricsWindow, MetricValues, Rollup, StoredEvent } from "../../core/metrics";

/** An instance's figures over a window, one sample per step, minutes or hours as the window allows. */
export const readMetrics = call("metrics.read") as (
	group: string,
	from: number,
	to: number,
	step?: number,
) => Promise<MetricsWindow>;

/** An instance's recorded events in a window, newest first. */
export const readEvents = call("metrics.events") as (
	group: string,
	from: number,
	to: number,
	limit?: number,
) => Promise<StoredEvent[]>;
