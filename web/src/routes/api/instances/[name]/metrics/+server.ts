// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { METRICS_KEEP_DAYS, readEvents, readMetrics } from '$core/metrics';
import { uptimeSeries } from '$core/publicsite';
import { METRICS_RANGES, rangeMs, type MetricsRange } from '$shared/metricsrange';
import { getHistory, getEvents, getRuntime } from '$lib/server/luna';

/** How many recent events the detail page's activity list shows. */
const EVENT_LIMIT = 50;

/** How many events a longer window carries; enough to audit a month of restarts. */
const RECORD_EVENT_LIMIT = 1000;

/** The shortest window a drag may ask for; anything tighter is a slip of the hand. */
const MIN_WINDOW_MS = 60_000;

/** An exact window out of the query, or null when the two bounds do not make one. */
function exactWindow(fromText: string | null, toText: string | null): { from: number; to: number } | null {
	if (fromText === null || toText === null) {
		return null;
	}

	const from = Number(fromText);
	const to = Number(toText);
	const now = Date.now();

	if (!Number.isFinite(from) || !Number.isFinite(to)) {
		return null;
	}

	if (to - from < MIN_WINDOW_MS || to > now + MIN_WINDOW_MS || from < now - METRICS_KEEP_DAYS * 86_400_000) {
		return null;
	}

	return { from: Math.floor(from), to: Math.floor(to) };
}

/**
 * GET → an instance's figures, events, the long uptime record, and the JVM's
 * own latest snapshot (null unless it reports one).
 *
 * `?range=` picks the window. The default, `1h`, is the daemon's in-memory
 * hour of five-second samples and its live event feed; anything longer reads
 * the persisted record (minute buckets inside two days, hours beyond) and the
 * recorded events, so a chart a month wide costs a few hundred points. The
 * answer says which it used (`range`, `step`), so the screen can label it.
 *
 * `?from=&to=` (epoch ms) reads an exact window instead, which is what a
 * drag across a chart asks for: the live samples when it sits inside the hour
 * the daemon holds, the record otherwise. A window that is not one (reversed,
 * shorter than a minute, older than the record keeps) falls back to `range`.
 */
export async function GET({ params, url }) {
	const asked = url.searchParams.get('range') ?? '1h';
	const range: MetricsRange = (METRICS_RANGES as readonly string[]).includes(asked)
		? (asked as MetricsRange)
		: '1h';

	const [uptime, runtime] = await Promise.all([
		uptimeSeries(params.name),
		// a follower on an older build has no such op; the charts still draw
		getRuntime(params.name).catch(() => null)
	]);

	const exact = exactWindow(url.searchParams.get('from'), url.searchParams.get('to'));

	if (exact) {
		const live = exact.from >= Date.now() - rangeMs('1h');

		if (live) {
			const [history, events] = await Promise.all([getHistory(params.name), getEvents(params.name)]);

			return json({
				range: 'custom',
				step: null,
				from: exact.from,
				to: exact.to,
				history: history.filter((sample: { t: number }) => sample.t >= exact.from && sample.t <= exact.to),
				events: events.filter((event: { t: number }) => event.t >= exact.from && event.t <= exact.to),
				uptime,
				runtime
			});
		}

		const [window, recorded] = await Promise.all([
			readMetrics(params.name, exact.from, exact.to),
			readEvents(params.name, exact.from, exact.to, RECORD_EVENT_LIMIT)
		]);

		return json({
			range: 'custom',
			step: window.step,
			from: exact.from,
			to: exact.to,
			history: window.samples,
			events: recorded.map((event) => ({ ...event, instance: params.name })),
			uptime,
			runtime
		});
	}

	if (range === '1h') {
		const [history, events] = await Promise.all([getHistory(params.name), getEvents(params.name)]);

		return json({
			range,
			step: null,
			history,
			events: events.slice(0, EVENT_LIMIT),
			uptime,
			runtime
		});
	}

	const to = Date.now();
	const from = to - rangeMs(range);

	const [window, recorded] = await Promise.all([
		readMetrics(params.name, from, to),
		readEvents(params.name, from, to, RECORD_EVENT_LIMIT)
	]);

	return json({
		range,
		step: window.step,
		from,
		to,
		history: window.samples,
		events: recorded.map((event) => ({ ...event, instance: params.name })),
		uptime,
		runtime
	});
}
