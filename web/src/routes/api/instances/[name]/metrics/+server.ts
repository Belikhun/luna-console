// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { uptimeSeries } from '$core/publicsite';
import { getHistory, getEvents, getRuntime } from '$lib/server/luna';

/** How many recent events the detail page's activity list shows. */
const EVENT_LIMIT = 50;

/**
 * GET → sampled CPU/memory/player history, recent events, the long uptime
 * record, and the JVM's own latest snapshot (null unless it reports one) for one
 * instance.
 *
 * The uptime window rides along with the metrics rather than on a route of its
 * own: the monitoring tab draws all three together, and it already reads this
 * endpoint. The first two are an hour of samples held in memory; the third is
 * the record that survives a daemon restart.
 */
export async function GET({ params }) {
	const [history, events, uptime, runtime] = await Promise.all([
		getHistory(params.name),
		getEvents(params.name),
		uptimeSeries(params.name),
		// a follower on an older build has no such op; the charts still draw
		getRuntime(params.name).catch(() => null)
	]);

	return json({
		history,
		events: events.slice(0, EVENT_LIMIT),
		uptime,
		runtime
	});
}
