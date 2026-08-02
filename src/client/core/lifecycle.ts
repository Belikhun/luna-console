/**
 * Bridge mirror of core/lifecycle. Tracked transitions follow the server log
 * for minutes, so all three run as daemon jobs — the log-derived progress
 * tree streams back into the caller's reporter.
 */

import type * as core from "../../core/lifecycle";

import { jobCall } from "../rpc";

export type { TrackedStartResult } from "../../core/lifecycle";

export const startInstanceTracked = jobCall("lifecycle.startTracked", {
	cfg: 0,
	reporter: { arg: 2 },
	kind: "start",
	targetArg: 1,
}) as typeof core.startInstanceTracked;

export const stopInstanceTracked = jobCall("lifecycle.stopTracked", {
	cfg: 0,
	reporter: { arg: 2 },
	kind: "stop",
	targetArg: 1,
}) as typeof core.stopInstanceTracked;

export const restartInstanceTracked = jobCall("lifecycle.restartTracked", {
	cfg: 0,
	reporter: { arg: 2 },
	kind: "restart",
	targetArg: 1,
}) as typeof core.restartInstanceTracked;
