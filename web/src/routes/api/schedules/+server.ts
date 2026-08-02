import { json, error } from '@sveltejs/kit';

import { loadCluster } from '$core/config';
import {
	createSchedule,
	loadSchedules,
	saveSchedules,
	type ScheduleTrigger
} from '$core/schedule';
import { pushEvent } from '$lib/server/mrds';
import { errorMessage } from '$lib/server/http';

/** GET → every schedule plus the execution log, newest first. */
export async function GET() {
	// the runner lives in the daemon now — nothing to arm here
	const store = await loadSchedules();

	return json({
		schedules: store.schedules,
		events: [...store.events].reverse()
	});
}

/** POST { name, action, instances, trigger, maxRuns?, description?, enabled? } */
export async function POST({ request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const store = await loadSchedules();

	const trigger = body.trigger as ScheduleTrigger | undefined;

	if (!trigger?.kind) {
		throw error(400, 'trigger { kind: at|cron|rate, ... } is required');
	}

	try {
		const schedule = createSchedule(cfg, store, {
			name: String(body.name ?? ''),
			description: body.description ? String(body.description) : undefined,
			action: body.action,
			instances: Array.isArray(body.instances) ? body.instances.map(String) : [],
			trigger,
			maxRuns: body.maxRuns ? Number(body.maxRuns) : undefined,
			enabled: body.enabled !== false
		});

		await saveSchedules(store);
		pushEvent('schedule', 'action', `schedule "${schedule.name}" created`);

		return json({ ok: true, schedule });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
