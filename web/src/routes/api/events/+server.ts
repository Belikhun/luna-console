// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { listDaemons } from '$client/daemon';
import { loadCluster } from '$core/config';
import { readEvents } from '$core/metrics';
import { METRICS_RANGES, rangeMs, type MetricsRange } from '$shared/metricsrange';
import { getEvents, type ClusterEvent } from '$lib/server/luna';

/** How many recorded events one instance contributes to a long window. */
const PER_INSTANCE_LIMIT = 500;

/** How many a merged window carries in all, newest kept. */
const MERGED_LIMIT = 3000;

/**
 * GET ?instance=&range= → events, newest first.
 *
 * Without a range, the daemon's live feed as it stands: everything since it
 * started, every instance and every daemon.
 *
 * With one, the events inside that window. `1h` is the live feed cut to the
 * hour. A longer range adds the saved record, per group (one instance, or
 * every instance in the registry and every daemon's own `daemon:<name>` log),
 * because the record keeps what the live feed loses on a restart; the live
 * feed still joins in, so the newest events show before the record is flushed
 * and a daemon on a build without the record still answers with what it holds.
 */
export async function GET({ url }) {
	const instance = url.searchParams.get('instance') ?? undefined;
	const asked = url.searchParams.get('range');

	if (asked === null) {
		return json({ range: '1h', events: await getEvents(instance) });
	}

	const range: MetricsRange = (METRICS_RANGES as readonly string[]).includes(asked)
		? (asked as MetricsRange)
		: '1h';

	const to = Date.now();
	const from = to - rangeMs(range);
	const live = (await getEvents(instance)).filter((event) => event.t >= from && event.t <= to);

	if (range === '1h') {
		return json({ range, from, to, events: live });
	}

	const names = instance
		? [instance]
		: await recordGroups();

	const lists = await Promise.all(
		names.map(async (name) =>
			(await readEvents(name, from, to, PER_INSTANCE_LIMIT).catch(() => [])).map((event): ClusterEvent => ({ ...event, instance: name }))
		)
	);

	const seen = new Set<string>();
	const events: ClusterEvent[] = [];

	for (const event of [...live, ...lists.flat()]) {
		const key = `${event.instance}\n${event.t}\n${event.message}`;

		if (!seen.has(key)) {
			seen.add(key);
			events.push(event);
		}
	}

	events.sort((left, right) => right.t - left.t);

	return json({ range, from, to, events: events.slice(0, MERGED_LIMIT) });
}

/** Every group the record files events under: the registry's instances, then each daemon's own log. */
async function recordGroups(): Promise<string[]> {
	const [cfg, daemons] = await Promise.all([loadCluster(), listDaemons().catch(() => [])]);

	return [...Object.keys(cfg.instances), ...daemons.map((daemon) => `daemon:${daemon.name}`)];
}
