import { command, UsageError, Bail } from "../framework";
import { pc, Sym, ok, info, warn, printTable, fmtDuration } from "../ui";
import { instanceNames } from "../completers";
import { loadCluster } from "../../client/core/config";
import * as sched from "../../client/core/schedule";

/** Human line for a trigger. */
function triggerText(trigger: sched.ScheduleTrigger): string {
	if (trigger.kind === "at") {
		return `once at ${new Date(trigger.at).toLocaleString("sv")}`;
	}

	if (trigger.kind === "cron") {
		return `cron(${trigger.expr})`;
	}

	return `every ${trigger.minutes}m`;
}

function outcomeGlyph(outcome: sched.ScheduleOutcome | undefined): string {
	switch (outcome) {
		case "ok":
			return Sym.ok;

		case "partial":
			return Sym.warn;

		case "error":
			return Sym.bad;

		case "missed":
			return Sym.off;

		default:
			return Sym.dot;
	}
}

async function scheduleIds(): Promise<string[]> {
	const store = await sched.loadSchedules();

	return store.schedules.map((schedule) => schedule.id);
}

command({
	path: ["schedule", "list"],
	desc: "List schedules (the runner lives in the web console server)",

	handler: async () => {
		const store = await sched.loadSchedules();

		if (!store.schedules.length) {
			info("no schedules — create one with: luna schedule create");

			return;
		}

		const rows = store.schedules.map((schedule) => [
			schedule.enabled ? Sym.ok : Sym.off,
			pc.bold(schedule.name),
			pc.dim(schedule.id),
			schedule.action,
			schedule.instances.join(","),
			triggerText(schedule.trigger),
			schedule.nextRun ? new Date(schedule.nextRun).toLocaleString("sv") : pc.dim("—"),
			`${outcomeGlyph(schedule.lastOutcome)} ${schedule.lastOutcome ?? pc.dim("never ran")}`,
			`${schedule.runs}${schedule.maxRuns ? `/${schedule.maxRuns}` : ""}`,
		]);

		console.log();
		printTable(rows, { head: ["", "name", "id", "action", "instances", "trigger", "next run", "last", "runs"] });
		console.log();
		info(`runs fire from the daemon ${pc.dim("(mrds daemon run)")}`);
	},
});

command({
	path: ["schedule", "create"],
	desc: "Schedule an instance start/stop/restart (once, cron, or fixed rate)",
	args: [{ name: "name", required: true, variadic: true }],
	opts: [
		{ flag: "--action", desc: "start | stop | restart", value: true, complete: async () => ["start", "stop", "restart"] },
		{ flag: "--instances", desc: "targets, comma-separated (wildcards ok)", value: true, complete: instanceNames },
		{ flag: "--at", desc: 'one-time, e.g. "2026-08-03 04:00"', value: true },
		{ flag: "--cron", desc: 'recurring, e.g. "30 4 * * *"', value: true },
		{ flag: "--every", desc: "recurring, minutes between runs", value: true },
		{ flag: "--max-runs", desc: "stop after this many runs", value: true },
		{ flag: "--disabled", desc: "create paused" },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const store = await sched.loadSchedules();

		const action = opts.action as sched.ScheduleAction | undefined;

		if (!action || !["start", "stop", "restart"].includes(action)) {
			throw new UsageError("--action start|stop|restart is required");
		}

		if (!opts.instances) {
			throw new UsageError("--instances <names> is required");
		}

		const chosen = [opts.at, opts.cron, opts.every].filter((value) => value !== undefined);

		if (chosen.length !== 1) {
			throw new UsageError("pick exactly one of --at, --cron, --every");
		}

		const trigger: sched.ScheduleTrigger = opts.at
			? { kind: "at", at: new Date(String(opts.at)).toISOString() }
			: opts.cron
				? { kind: "cron", expr: String(opts.cron) }
				: { kind: "rate", minutes: parseInt(String(opts.every)) };

		if (opts.at && Number.isNaN(new Date(String(opts.at)).getTime())) {
			throw new UsageError(`cannot parse time "${opts.at}"`);
		}

		const schedule = sched.createSchedule(cfg, store, {
			name: args.join(" "),
			action,
			instances: String(opts.instances).split(",").map((entry) => entry.trim()).filter(Boolean),
			trigger,
			maxRuns: opts["max-runs"] ? parseInt(String(opts["max-runs"])) : undefined,
			enabled: !opts.disabled,
		});

		await sched.saveSchedules(store);

		ok(`${pc.bold(schedule.name)} ${pc.dim(`(${schedule.id})`)} — ${triggerText(schedule.trigger)}`);

		if (schedule.nextRun) {
			info(`next run ${pc.cyan(new Date(schedule.nextRun).toLocaleString("sv"))} — fires while the web console runs`);
		}
	},
});

command({
	path: ["schedule", "delete"],
	desc: "Delete a schedule (its history stays in the event log)",
	args: [{ name: "id", required: true, complete: scheduleIds }],

	handler: async (args) => {
		const store = await sched.loadSchedules();
		const index = store.schedules.findIndex((schedule) => schedule.id === args[0]);

		if (index === -1) {
			throw new Bail(`unknown schedule: ${args[0]}`);
		}

		const [removed] = store.schedules.splice(index, 1);

		await sched.saveSchedules(store);
		ok(`${pc.bold(removed!.name)} deleted`);
	},
});

for (const [verb, enabled] of [
	["enable", true],
	["disable", false],
] as const) {
	command({
		path: ["schedule", verb],
		desc: `${verb === "enable" ? "Resume" : "Pause"} a schedule`,
		args: [{ name: "id", required: true, complete: scheduleIds }],

		handler: async (args) => {
			const store = await sched.loadSchedules();
			const schedule = store.schedules.find((entry) => entry.id === args[0]);

			if (!schedule) {
				throw new Bail(`unknown schedule: ${args[0]}`);
			}

			sched.setEnabled(schedule, enabled);
			await sched.saveSchedules(store);

			if (enabled && !schedule.enabled) {
				warn(`${schedule.name} has already completed — nothing left to fire`);

				return;
			}

			ok(`${pc.bold(schedule.name)} ${enabled ? "enabled" : "paused"}` +
				(schedule.nextRun ? pc.dim(` — next ${new Date(schedule.nextRun).toLocaleString("sv")}`) : ""));
		},
	});
}

command({
	path: ["schedule", "run"],
	desc: "Fire a schedule's action right now (does not consume a scheduled run)",
	args: [{ name: "id", required: true, complete: scheduleIds }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const store = await sched.loadSchedules();
		const schedule = store.schedules.find((entry) => entry.id === args[0]);

		if (!schedule) {
			throw new Bail(`unknown schedule: ${args[0]}`);
		}

		const inst = await import("../../client/core/instances");
		const { expandTargets } = await import("../../client/core/config");
		const outcomes: string[] = [];

		for (const name of expandTargets(cfg, schedule.instances)) {
			const started = Date.now();

			if (schedule.action === "start") {
				outcomes.push(`${name}: ${await inst.startInstance(cfg, name)}`);
			} else if (schedule.action === "stop") {
				outcomes.push(`${name}: ${(await inst.stopInstance(cfg, name)).outcome}`);
			} else {
				await inst.stopInstance(cfg, name);
				await inst.startInstance(cfg, name);
				outcomes.push(`${name}: restarted (${fmtDuration(Date.now() - started)})`);
			}
		}

		sched.recordEvent(store, schedule, "ok", `manual run — ${schedule.action}: ${outcomes.join(" · ")}`);
		await sched.saveSchedules(store);

		for (const line of outcomes) {
			ok(line);
		}
	},
});

command({
	path: ["schedule", "history"],
	desc: "Execution log, newest first",
	args: [{ name: "id", complete: scheduleIds }],

	handler: async (args) => {
		const store = await sched.loadSchedules();

		const events = store.events
			.filter((event) => !args[0] || event.id === args[0])
			.slice()
			.reverse();

		if (!events.length) {
			info("no executions recorded yet");

			return;
		}

		console.log();

		printTable(
			events.map((event) => [
				outcomeGlyph(event.outcome),
				new Date(event.t).toLocaleString("sv"),
				pc.bold(event.name),
				event.outcome,
				pc.dim(event.detail.length > 90 ? `${event.detail.slice(0, 89)}…` : event.detail),
			]),
			{ head: ["", "time", "schedule", "outcome", "detail"] },
		);

		console.log();
	},
});
