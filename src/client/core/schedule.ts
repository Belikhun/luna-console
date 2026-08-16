// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/schedule: trigger math and store edits are pure; the
 * store itself is a state file, read and written through the daemon. The
 * runner (`runDue`) is deliberately absent; only the daemon executes.
 */

import type * as core from "../../core/schedule";

import { call } from "../rpc";

export {
	MISSED_AFTER_MS,
	SCHEDULE_ACTIONS,
	isScheduleAction,
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

/**
 * Run one schedule action against one instance, now.
 *
 * Goes to the daemon rather than being re-implemented per caller: the runner's
 * executor is the only version that routes to the instance's owner, and the
 * console and the CLI both used to carry their own copy that did not.
 */
export const executeScheduleAction = call("schedule.execute") as (
	action: core.ScheduleAction,
	instance: string,
) => Promise<string>;
