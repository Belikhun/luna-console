/**
 * Bridge mirror of core/schedule: trigger math and store edits are pure; the
 * store itself is a state file, read and written through the daemon. The
 * runner (`runDue`) is deliberately absent — only the daemon executes.
 */

import type * as core from "../../core/schedule";

import { call } from "../rpc";

export {
	MISSED_AFTER_MS,
	parseCron,
	nextCron,
	computeNextRun,
	validateTrigger,
	createSchedule,
	recordEvent,
	setEnabled,
} from "../../core/schedule";
export type {
	Schedule,
	ScheduleAction,
	ScheduleStore,
	ScheduleTrigger,
	ScheduleEvent,
	ScheduleOutcome,
} from "../../core/schedule";

export const loadSchedules = call("schedule.loadSchedules") as typeof core.loadSchedules;
export const saveSchedules = call("schedule.saveSchedules") as typeof core.saveSchedules;
