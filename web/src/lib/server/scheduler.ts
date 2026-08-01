/**
 * Server-side schedule runner (DESIGN.md §3.4). The console's server process is
 * the long-lived one, so this is where due schedules fire — armed alongside the
 * metrics sampler and ticking on its own interval. All schedule logic lives in
 * core; this only supplies the executor and persists the outcome.
 */

import { loadCluster } from '$core/config';
import * as instances from '$core/instances';
import { loadSchedules, runDue, saveSchedules, type ScheduleAction } from '$core/schedule';
import { pushEvent } from '$lib/server/mrds';

const TICK_MS = 20_000;

interface SchedulerGlobals {
	timer?: ReturnType<typeof setInterval>;
	/** a tick can outlast the interval (graceful stops are slow) — never overlap */
	running: boolean;
}

// survive vite HMR without duplicating the runner
const g: SchedulerGlobals = ((globalThis as any).__mrdsScheduler ??= { running: false });

/** Execute one action against one instance, returning the outcome line. */
async function execute(action: ScheduleAction, instance: string): Promise<string> {
	const cfg = await loadCluster();

	if (action === 'start') {
		return await instances.startInstance(cfg, instance);
	}

	if (action === 'stop') {
		return (await instances.stopInstance(cfg, instance)).outcome;
	}

	const stopped = await instances.stopInstance(cfg, instance);

	await instances.startInstance(cfg, instance);

	return stopped.outcome === 'not-running' ? 'started (was stopped)' : 'restarted';
}

async function tick(): Promise<void> {
	if (g.running) {
		return;
	}

	g.running = true;

	try {
		const store = await loadSchedules();

		const due = store.schedules.some(
			(schedule) =>
				schedule.enabled &&
				schedule.nextRun !== undefined &&
				new Date(schedule.nextRun).getTime() <= Date.now()
		);

		if (!due) {
			return;
		}

		const cfg = await loadCluster();
		const events = await runDue(cfg, store, new Date(), execute);

		await saveSchedules(store);

		// executions also land in the cluster event log, next to manual actions
		for (const event of events) {
			pushEvent(
				'schedule',
				event.outcome === 'ok' ? 'action' : 'error',
				`${event.name}: ${event.detail}`
			);
		}
	} catch (err) {
		console.error('[mrds scheduler]', err);
	} finally {
		g.running = false;
	}
}

/** Arm the runner once per server process. */
export function ensureScheduler(): void {
	if (g.timer) {
		return;
	}

	g.timer = setInterval(() => void tick(), TICK_MS);
	void tick();
}
