// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { uptimeSeries } from '$core/publicsite';
import { getHistory, getEvents } from '$lib/server/luna';

/** How many recent events the detail page's activity list shows. */
const EVENT_LIMIT = 50;

/**
 * GET → sampled CPU/memory/player history, recent events, and the long uptime
 * record for one instance.
 *
 * The uptime window rides along with the metrics rather than on a route of its
 * own: the monitoring tab draws all three together, and it already reads this
 * endpoint. The first two are an hour of samples held in memory; the third is
 * the record that survives a daemon restart.
 */
export async function GET({ params }) {
	const [history, events, uptime] = await Promise.all([
		getHistory(params.name),
		getEvents(params.name),
		uptimeSeries(params.name)
	]);

	return json({
		history,
		events: events.slice(0, EVENT_LIMIT),
		uptime
	});
}
