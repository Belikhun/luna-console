/**
 * Instance schedules (DESIGN.md §3.4) — EventBridge Scheduler's model at luna
 * scale: one-time `at`, recurring `cron` (standard 5-field) or `rate` (every N
 * minutes) triggers firing a start/stop/restart across instance targets, with
 * an optional run cap and a persisted event log.
 *
 * This module owns the data and the "what is due" logic; *executing* a due
 * schedule is the runner's job (the web console's server process), which
 * injects the actual start/stop calls so this stays testable and print-free.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ClusterConfig } from "./types";
import { expandTargets, root } from "./config";

const SCHEDULE_FILE = "schedules.json";

/** Executions kept in the persisted event log. */
const MAX_EVENTS = 500;

/**
 * A run further overdue than this — the console was down — is logged as missed
 * and skipped rather than fired late: a 3 a.m. restart must not happen at noon.
 */
export const MISSED_AFTER_MS = 15 * 60_000;

export type ScheduleAction = "start" | "stop" | "restart";

export type ScheduleTrigger =
	| { kind: "at"; at: string }
	| { kind: "cron"; expr: string }
	| { kind: "rate"; minutes: number };

export type ScheduleOutcome = "ok" | "partial" | "error" | "missed";

export interface Schedule {
	id: string;
	name: string;
	description?: string;
	enabled: boolean;
	action: ScheduleAction;
	/** Instance names or wildcards (`*`, `*paper`, `*velocity`) */
	instances: string[];
	trigger: ScheduleTrigger;
	/** Recurring schedules stop (and disable) after this many runs; absent = forever */
	maxRuns?: number;
	runs: number;
	/** ISO time of the next firing; absent when the schedule is finished */
	nextRun?: string;
	lastRunAt?: string;
	lastOutcome?: ScheduleOutcome;
	createdAt: string;
}

export interface ScheduleEvent {
	/** Unique, monotonic — two runs can land in the same millisecond */
	seq: number;
	t: number;
	id: string;
	name: string;
	outcome: ScheduleOutcome;
	detail: string;
}

export interface ScheduleStore {
	schedules: Schedule[];
	events: ScheduleEvent[];
	/** Next event sequence number */
	counter?: number;
}

function schedulePath(): string {
	return join(root(), SCHEDULE_FILE);
}

/** Read the schedule store. */
export async function loadSchedules(): Promise<ScheduleStore> {
	if (!existsSync(schedulePath())) {
		return { schedules: [], events: [] };
	}

	const store: ScheduleStore = await Bun.file(schedulePath()).json();

	store.schedules ??= [];
	store.events ??= [];

	// events written before seq existed get one, oldest first
	let next = store.counter ?? 0;

	for (const event of store.events) {
		if (event.seq === undefined) {
			event.seq = next;
			next += 1;
		} else if (event.seq >= next) {
			next = event.seq + 1;
		}
	}

	store.counter = next;

	return store;
}

/** Persist the schedule store, trimming the event log. */
export async function saveSchedules(store: ScheduleStore): Promise<void> {
	if (store.events.length > MAX_EVENTS) {
		store.events.splice(0, store.events.length - MAX_EVENTS);
	}

	await Bun.write(schedulePath(), JSON.stringify(store, null, "\t") + "\n");
}

interface CronField {
	values: Set<number>;
	any: boolean;
}

interface CronSpec {
	minute: CronField;
	hour: CronField;
	dom: CronField;
	month: CronField;
	dow: CronField;
}

function parseField(text: string, min: number, max: number, label: string): CronField {
	if (text === "*") {
		return { values: new Set(), any: true };
	}

	const values = new Set<number>();

	for (const part of text.split(",")) {
		const step = part.match(/^(.+)\/(\d+)$/);
		const rangeText = step ? step[1]! : part;
		const every = step ? parseInt(step[2]!) : 1;

		if (every < 1) {
			throw new Error(`cron: bad step in ${label} field`);
		}

		let from: number;
		let to: number;

		if (rangeText === "*") {
			from = min;
			to = max;
		} else {
			const range = rangeText.match(/^(\d+)(?:-(\d+))?$/);

			if (!range) {
				throw new Error(`cron: cannot parse "${part}" in ${label} field`);
			}

			from = parseInt(range[1]!);
			to = range[2] !== undefined ? parseInt(range[2]!) : step ? max : from;
		}

		if (from < min || to > max || from > to) {
			throw new Error(`cron: ${label} value out of range ${min}-${max}`);
		}

		for (let value = from; value <= to; value += every) {
			values.add(value);
		}
	}

	return { values, any: false };
}

/** Parse a standard 5-field cron expression (minute hour dom month dow, numeric). */
export function parseCron(expr: string): CronSpec {
	const fields = expr.trim().split(/\s+/);

	if (fields.length !== 5) {
		throw new Error("cron expressions have 5 fields: minute hour day-of-month month day-of-week");
	}

	return {
		minute: parseField(fields[0]!, 0, 59, "minute"),
		hour: parseField(fields[1]!, 0, 23, "hour"),
		dom: parseField(fields[2]!, 1, 31, "day-of-month"),
		month: parseField(fields[3]!, 1, 12, "month"),
		dow: parseField(fields[4]!, 0, 7, "day-of-week"),
	};
}

function matchesField(field: CronField, value: number): boolean {
	return field.any || field.values.has(value);
}

function matchesCron(spec: CronSpec, date: Date): boolean {
	if (!matchesField(spec.minute, date.getMinutes())) {
		return false;
	}

	if (!matchesField(spec.hour, date.getHours())) {
		return false;
	}

	if (!matchesField(spec.month, date.getMonth() + 1)) {
		return false;
	}

	// standard cron: day-of-month and day-of-week OR together when both are
	// restricted; 7 is Sunday like 0
	const dowValue = date.getDay();
	const domHit = matchesField(spec.dom, date.getDate());
	const dowHit =
		spec.dow.any || spec.dow.values.has(dowValue) || (dowValue === 0 && spec.dow.values.has(7));

	if (!spec.dom.any && !spec.dow.any) {
		return domHit || dowHit;
	}

	return domHit && dowHit;
}

/** Next cron occurrence strictly after `after` (local time), scanning ≤400 days. */
export function nextCron(spec: CronSpec, after: Date): Date | undefined {
	const cursor = new Date(after.getTime());

	cursor.setSeconds(0, 0);
	cursor.setMinutes(cursor.getMinutes() + 1);

	const limit = after.getTime() + 400 * 24 * 3_600_000;

	while (cursor.getTime() <= limit) {
		if (matchesCron(spec, cursor)) {
			return new Date(cursor.getTime());
		}

		cursor.setMinutes(cursor.getMinutes() + 1);
	}

	return undefined;
}

/** When a schedule should fire next, strictly after `from`. */
export function computeNextRun(schedule: Schedule, from: Date): string | undefined {
	if (schedule.maxRuns !== undefined && schedule.runs >= schedule.maxRuns) {
		return undefined;
	}

	const trigger = schedule.trigger;

	if (trigger.kind === "at") {
		if (schedule.runs > 0) {
			return undefined;
		}

		const at = new Date(trigger.at);

		return at.getTime() > from.getTime() ? at.toISOString() : undefined;
	}

	if (trigger.kind === "cron") {
		return nextCron(parseCron(trigger.expr), from)?.toISOString();
	}

	return new Date(from.getTime() + trigger.minutes * 60_000).toISOString();
}

/** Validate a trigger without creating anything (throws with the reason). */
export function validateTrigger(trigger: ScheduleTrigger): void {
	if (trigger.kind === "at") {
		const at = new Date(trigger.at);

		if (Number.isNaN(at.getTime())) {
			throw new Error(`cannot parse time "${trigger.at}"`);
		}

		if (at.getTime() <= Date.now()) {
			throw new Error("the one-time trigger is in the past");
		}

		return;
	}

	if (trigger.kind === "cron") {
		parseCron(trigger.expr);

		return;
	}

	if (!Number.isFinite(trigger.minutes) || trigger.minutes < 1) {
		throw new Error("rate must be at least 1 minute");
	}
}

export interface ScheduleInit {
	name: string;
	description?: string;
	action: ScheduleAction;
	instances: string[];
	trigger: ScheduleTrigger;
	maxRuns?: number;
	enabled?: boolean;
}

/** Create a schedule, validate its shape, and compute the first firing. */
export function createSchedule(
	cfg: ClusterConfig,
	store: ScheduleStore,
	init: ScheduleInit,
): Schedule {
	if (!init.name.trim()) {
		throw new Error("schedules need a name");
	}

	if (!init.instances.length) {
		throw new Error("pick at least one instance");
	}

	expandTargets(cfg, init.instances); // validates names/wildcards

	validateTrigger(init.trigger);

	if (init.maxRuns !== undefined && (!Number.isFinite(init.maxRuns) || init.maxRuns < 1)) {
		throw new Error("maxRuns must be a positive number");
	}

	const now = new Date();

	const schedule: Schedule = {
		id: `sch-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
		name: init.name.trim(),
		...(init.description ? { description: init.description } : {}),
		enabled: init.enabled ?? true,
		action: init.action,
		instances: init.instances,
		trigger: init.trigger,
		...(init.maxRuns !== undefined ? { maxRuns: init.maxRuns } : {}),
		runs: 0,
		createdAt: now.toISOString(),
	};

	schedule.nextRun = computeNextRun(schedule, now);
	store.schedules.push(schedule);

	return schedule;
}

/** Append to the event log (persisted by the caller's saveSchedules). */
export function recordEvent(
	store: ScheduleStore,
	schedule: Schedule,
	outcome: ScheduleOutcome,
	detail: string,
): ScheduleEvent {
	store.counter = (store.counter ?? 0) + 1;

	const event: ScheduleEvent = {
		seq: store.counter,
		t: Date.now(),
		id: schedule.id,
		name: schedule.name,
		outcome,
		detail,
	};

	store.events.push(event);

	return event;
}

/** What the runner should do with one instance of a due schedule. */
export type ScheduleExecutor = (
	action: ScheduleAction,
	instance: string,
) => Promise<string>;

/**
 * Fire every enabled schedule whose time has come. Mutates the store (runs,
 * nextRun, events, self-disable on completion) — the caller persists it.
 * Returns the events this pass produced.
 */
export async function runDue(
	cfg: ClusterConfig,
	store: ScheduleStore,
	now: Date,
	execute: ScheduleExecutor,
): Promise<ScheduleEvent[]> {
	const fired: ScheduleEvent[] = [];

	for (const schedule of store.schedules) {
		if (!schedule.enabled || !schedule.nextRun) {
			continue;
		}

		const due = new Date(schedule.nextRun).getTime();

		if (due > now.getTime()) {
			continue;
		}

		schedule.runs += 1;
		schedule.lastRunAt = now.toISOString();

		if (now.getTime() - due > MISSED_AFTER_MS) {
			schedule.lastOutcome = "missed";

			fired.push(
				recordEvent(
					store,
					schedule,
					"missed",
					`was due ${schedule.nextRun} while the console was not running — skipped`,
				),
			);
		} else {
			const targets = expandTargets(cfg, schedule.instances);
			const outcomes: string[] = [];
			let failures = 0;

			for (const instance of targets) {
				try {
					outcomes.push(`${instance}: ${await execute(schedule.action, instance)}`);
				} catch (err) {
					failures += 1;
					outcomes.push(`${instance}: failed — ${err instanceof Error ? err.message : err}`);
				}
			}

			const outcome: ScheduleOutcome =
				failures === 0 ? "ok" : failures === targets.length ? "error" : "partial";

			schedule.lastOutcome = outcome;

			fired.push(
				recordEvent(store, schedule, outcome, `${schedule.action}: ${outcomes.join(" · ")}`),
			);
		}

		schedule.nextRun = computeNextRun(schedule, now);

		// a finished schedule disables itself and says so, once
		if (!schedule.nextRun && schedule.enabled) {
			schedule.enabled = false;

			recordEvent(
				store,
				schedule,
				schedule.lastOutcome ?? "ok",
				schedule.trigger.kind === "at"
					? "one-time schedule completed"
					: `completed after ${schedule.runs} run(s)`,
			);
		}
	}

	return fired;
}

/** Enable or disable, recomputing the next firing on enable. */
export function setEnabled(schedule: Schedule, enabled: boolean): void {
	schedule.enabled = enabled;

	if (enabled) {
		// re-enabling an exhausted one-shot re-arms nothing; recurring resumes
		schedule.nextRun = computeNextRun(schedule, new Date());

		if (!schedule.nextRun) {
			schedule.enabled = false;
		}
	}
}
