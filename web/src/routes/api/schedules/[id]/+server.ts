// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, expandTargets } from '$core/config';
import { startInstance, stopInstance } from '$core/instances';
import { loadSchedules, recordEvent, saveSchedules, setEnabled } from '$core/schedule';
import { pushEvent } from '$lib/server/luna';

/** PATCH { enabled } → pause or resume a schedule. */
export async function PATCH({ params, request }) {
	const body = await request.json();
	const store = await loadSchedules();
	const schedule = store.schedules.find((entry) => entry.id === params.id);

	if (!schedule) {
		throw error(404, 'unknown schedule');
	}

	if (typeof body.enabled === 'boolean') {
		setEnabled(schedule, body.enabled);
	}

	await saveSchedules(store);

	return json({ ok: true, schedule });
}

/** POST { action: "run" } → fire the schedule's action right now. */
export async function POST({ params, request }) {
	const body = await request.json();

	if (body.action !== 'run') {
		throw error(400, 'the only action is "run"');
	}

	const cfg = await loadCluster();
	const store = await loadSchedules();
	const schedule = store.schedules.find((entry) => entry.id === params.id);

	if (!schedule) {
		throw error(404, 'unknown schedule');
	}

	const outcomes: string[] = [];
	let failures = 0;

	for (const name of expandTargets(cfg, schedule.instances)) {
		try {
			if (schedule.action === 'start') {
				outcomes.push(`${name}: ${await startInstance(cfg, name)}`);
			} else if (schedule.action === 'stop') {
				outcomes.push(`${name}: ${(await stopInstance(cfg, name)).outcome}`);
			} else {
				await stopInstance(cfg, name);
				await startInstance(cfg, name);
				outcomes.push(`${name}: restarted`);
			}
		} catch (err) {
			failures += 1;
			outcomes.push(`${name}: failed; ${err instanceof Error ? err.message : err}`);
		}
	}

	const outcome = failures === 0 ? 'ok' : 'error';
	const detail = `manual run; ${schedule.action}: ${outcomes.join(' · ')}`;

	recordEvent(store, schedule, outcome, detail);
	await saveSchedules(store);
	pushEvent('schedule', outcome === 'ok' ? 'action' : 'error', `${schedule.name}: ${detail}`);

	return json({ ok: true, outcome, detail });
}

/** DELETE → remove the schedule (its history stays in the event log). */
export async function DELETE({ params }) {
	const store = await loadSchedules();
	const index = store.schedules.findIndex((entry) => entry.id === params.id);

	if (index === -1) {
		throw error(404, 'unknown schedule');
	}

	const [removed] = store.schedules.splice(index, 1);

	await saveSchedules(store);
	pushEvent('schedule', 'action', `schedule "${removed!.name}" deleted`);

	return json({ ok: true });
}
