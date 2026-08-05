// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { command, UsageError, Bail } from "../framework";
import { pc, Sym, ok, info, warn, printTable, fmtDuration } from "../ui";
import { instanceNames } from "../completers";
import { loadCluster } from "../../client/core/config";
import * as sched from "../../client/core/schedule";
import { t } from "../../shared/i18n";

/** Human line for a trigger. */
function triggerText(trigger: sched.ScheduleTrigger): string {
	if (trigger.kind === "at") {
		return t("cli.schedule.triggerOnce", { time: new Date(trigger.at).toLocaleString("sv") });
	}

	if (trigger.kind === "cron") {
		return `cron(${trigger.expr})`;
	}

	return t("cli.schedule.triggerEvery", { minutes: trigger.minutes });
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
	desc: t("cli.schedule.list.desc"),

	handler: async () => {
		const store = await sched.loadSchedules();

		if (!store.schedules.length) {
			info(t("cli.schedule.list.empty"));

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
			`${outcomeGlyph(schedule.lastOutcome)} ${schedule.lastOutcome ?? pc.dim(t("cli.schedule.list.neverRan"))}`,
			`${schedule.runs}${schedule.maxRuns ? `/${schedule.maxRuns}` : ""}`,
		]);

		console.log();
		printTable(rows, {
			head: [
				"",
				t("cli.head.name"),
				t("cli.head.id"),
				t("cli.head.action"),
				t("cli.head.instances"),
				t("cli.head.trigger"),
				t("cli.head.nextRun"),
				t("cli.head.last"),
				t("cli.head.runs"),
			],
		});
		console.log();
		info(`${t("cli.schedule.list.runnerNote")} ${pc.dim("(luna daemon run)")}`);
	},
});

command({
	path: ["schedule", "create"],
	desc: t("cli.schedule.create.desc"),
	args: [{ name: "name", required: true, variadic: true }],
	opts: [
		{ flag: "--action", desc: t("cli.schedule.create.optAction"), value: true, complete: async () => ["start", "stop", "restart"] },
		{ flag: "--instances", desc: t("cli.schedule.create.optInstances"), value: true, complete: instanceNames },
		{ flag: "--at", desc: t("cli.schedule.create.optAt"), value: true },
		{ flag: "--cron", desc: t("cli.schedule.create.optCron"), value: true },
		{ flag: "--every", desc: t("cli.schedule.create.optEvery"), value: true },
		{ flag: "--max-runs", desc: t("cli.schedule.create.optMaxRuns"), value: true },
		{ flag: "--disabled", desc: t("cli.schedule.create.optDisabled") },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const store = await sched.loadSchedules();

		const action = opts.action as sched.ScheduleAction | undefined;

		if (!action || !["start", "stop", "restart"].includes(action)) {
			throw new UsageError(t("cli.schedule.create.needsAction"));
		}

		if (!opts.instances) {
			throw new UsageError(t("cli.schedule.create.needsInstances"));
		}

		const chosen = [opts.at, opts.cron, opts.every].filter((value) => value !== undefined);

		if (chosen.length !== 1) {
			throw new UsageError(t("cli.schedule.create.pickOneTrigger"));
		}

		const trigger: sched.ScheduleTrigger = opts.at
			? { kind: "at", at: new Date(String(opts.at)).toISOString() }
			: opts.cron
				? { kind: "cron", expr: String(opts.cron) }
				: { kind: "rate", minutes: parseInt(String(opts.every)) };

		if (opts.at && Number.isNaN(new Date(String(opts.at)).getTime())) {
			throw new UsageError(t("cli.schedule.create.badTime", { time: String(opts.at) }));
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

		ok(`${pc.bold(schedule.name)} ${pc.dim(`(${schedule.id})`)} · ${triggerText(schedule.trigger)}`);

		if (schedule.nextRun) {
			info(
				t("cli.schedule.create.nextRun", {
					time: pc.cyan(new Date(schedule.nextRun).toLocaleString("sv")),
				}),
			);
		}
	},
});

command({
	path: ["schedule", "delete"],
	desc: t("cli.schedule.remove.desc"),
	args: [{ name: "id", required: true, complete: scheduleIds }],

	handler: async (args) => {
		const store = await sched.loadSchedules();
		const index = store.schedules.findIndex((schedule) => schedule.id === args[0]);

		if (index === -1) {
			throw new Bail(t("cli.schedule.unknown", { id: args[0] ?? "" }));
		}

		const [removed] = store.schedules.splice(index, 1);

		await sched.saveSchedules(store);
		ok(t("cli.schedule.remove.deleted", { name: pc.bold(removed!.name) }));
	},
});

for (const [verb, enabled] of [
	["enable", true],
	["disable", false],
] as const) {
	command({
		path: ["schedule", verb],
		desc: t(verb === "enable" ? "cli.schedule.enable.desc" : "cli.schedule.disable.desc"),
		args: [{ name: "id", required: true, complete: scheduleIds }],

		handler: async (args) => {
			const store = await sched.loadSchedules();
			const schedule = store.schedules.find((entry) => entry.id === args[0]);

			if (!schedule) {
				throw new Bail(t("cli.schedule.unknown", { id: args[0] ?? "" }));
			}

			sched.setEnabled(schedule, enabled);
			await sched.saveSchedules(store);

			if (enabled && !schedule.enabled) {
				warn(t("cli.schedule.enable.completed", { name: schedule.name }));

				return;
			}

			ok(
				`${pc.bold(schedule.name)} ${enabled ? t("cli.schedule.enable.done") : t("cli.schedule.disable.done")}` +
					(schedule.nextRun
						? pc.dim(
								` · ${t("cli.schedule.nextShort", { time: new Date(schedule.nextRun).toLocaleString("sv") })}`,
							)
						: ""),
			);
		},
	});
}

command({
	path: ["schedule", "run"],
	desc: t("cli.schedule.run.desc"),
	args: [{ name: "id", required: true, complete: scheduleIds }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const store = await sched.loadSchedules();
		const schedule = store.schedules.find((entry) => entry.id === args[0]);

		if (!schedule) {
			throw new Bail(t("cli.schedule.unknown", { id: args[0] ?? "" }));
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
				outcomes.push(
					`${name}: ${t("cli.schedule.run.restarted", { duration: fmtDuration(Date.now() - started) })}`,
				);
			}
		}

		sched.recordEvent(
			store,
			schedule,
			"ok",
			`${t("cli.schedule.run.manualRun", { action: schedule.action })}: ${outcomes.join(" · ")}`,
		);
		await sched.saveSchedules(store);

		for (const line of outcomes) {
			ok(line);
		}
	},
});

command({
	path: ["schedule", "history"],
	desc: t("cli.schedule.history.desc"),
	args: [{ name: "id", complete: scheduleIds }],

	handler: async (args) => {
		const store = await sched.loadSchedules();

		const events = store.events
			.filter((event) => !args[0] || event.id === args[0])
			.slice()
			.reverse();

		if (!events.length) {
			info(t("cli.schedule.history.empty"));

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
			{
				head: [
					"",
					t("cli.head.time"),
					t("cli.head.schedule"),
					t("cli.head.outcome"),
					t("cli.head.detail"),
				],
			},
		);

		console.log();
	},
});
