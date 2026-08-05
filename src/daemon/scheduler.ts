/**
 * The daemon's schedule runner (DESIGN.md §3.4, hosted per §4.1). Ported from
 * the web console's server process; the daemon is the always-on process, so
 * schedules now fire even when nobody has the console open. All schedule logic
 * lives in core; this only supplies the executor and persists the outcome.
 *
 * Actions execute through the RPC dispatcher rather than core directly, so an
 * instance owned by a follower daemon is stopped/started on its own machine.
 */

import { loadCluster } from "../core/config";
import { loadSchedules, runDue, saveSchedules, type ScheduleAction } from "../core/schedule";

import { pushEvent } from "./events";
import { runOp } from "./rpc";

const TICK_MS = 20_000;

let timer: ReturnType<typeof setInterval> | undefined;

/** a tick can outlast the interval (graceful stops are slow); never overlap */
let running = false;

/** Execute one action against one instance, returning the outcome line. */
async function execute(action: ScheduleAction, instance: string): Promise<string> {
	const cfg = await loadCluster();

	if (action === "start") {
		return (await runOp("instances.startInstance", [cfg, instance])).result as string;
	}

	if (action === "stop") {
		const stopped = await runOp("instances.stopInstance", [cfg, instance]);

		return (stopped.result as { outcome: string }).outcome;
	}

	const stopped = await runOp("instances.stopInstance", [cfg, instance]);

	await runOp("instances.startInstance", [cfg, instance]);

	return (stopped.result as { outcome: string }).outcome === "not-running"
		? "started (was stopped)"
		: "restarted";
}

async function tick(): Promise<void> {
	if (running) {
		return;
	}

	running = true;

	try {
		const store = await loadSchedules();

		const due = store.schedules.some(
			(schedule) =>
				schedule.enabled &&
				schedule.nextRun !== undefined &&
				new Date(schedule.nextRun).getTime() <= Date.now(),
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
				"schedule",
				event.outcome === "ok" ? "action" : "error",
				`${event.name}: ${event.detail}`,
			);
		}
	} catch (err) {
		console.error("[scheduler]", err);
	} finally {
		running = false;
	}
}

/** Arm the runner once per daemon process. */
export function ensureScheduler(): void {
	if (timer) {
		return;
	}

	timer = setInterval(() => void tick(), TICK_MS);
	void tick();
}
