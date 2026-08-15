// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/publicsite. The predicates are pure and answer locally
 * from a config the caller already holds; the snapshot is assembled in the
 * daemon, because only that process sees every machine's health and the uptime
 * record.
 */

import { call } from "../rpc";
import type * as core from "../../core/publicsite";
import type { UptimeSeries } from "../../core/uptime";

export {
	publicEnabled,
	publicInstances,
	listableInstances,
	isPublicInstance,
	PUBLIC_UPTIME_DAYS,
} from "../../core/publicsite";

export type {
	MapEndpoint,
	PublicInstanceCard,
	PublicPoint,
	PublicSnapshot,
} from "../../core/publicsite";

/** The whole public document, or null when the page is switched off. */
export const snapshot = call("publicsite.snapshot") as () => Promise<core.PublicSnapshot | null>;

/** Where a listed instance's map answers; null for anything not listed. */
export const mapEndpoint = call("publicsite.mapEndpoint") as (
	instance: string,
) => Promise<core.MapEndpoint | null>;

/** One instance's uptime timeline, for the console's own screens. */
export const uptimeSeries = call("publicsite.uptimeSeries") as (
	instance: string,
	days?: number,
) => Promise<UptimeSeries>;
