// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/serverbuilds.
 *
 * Nothing here is pure: establishing which build an instance runs means reading
 * a file inside its directory, and that directory lives on whichever machine
 * owns the instance. The sweep goes to `serverbuilds.checkAll`, which the daemon
 * splits by owner; a single instance goes to the routed leaf directly.
 *
 * Applying is a job: it downloads a server binary, which outlasts a request.
 */

import type * as core from "../../core/serverbuilds";

import { call, jobCall } from "../rpc";

export type {
	BuildCheck,
	BuildSource,
	BuildUpdate,
	BuildUpdateResult,
	InstalledBuild,
} from "../../core/serverbuilds";

// one provider round trip per instance, some of them forwarded to a follower, so
// a fleet sweep outlasts a request; a job, so its progress reaches the caller
export const checkServerBuilds = jobCall("serverbuilds.checkAll", {
	cfg: 0,
	reporter: { arg: 2, prop: "reporter" },
	kind: "check-builds",
}) as typeof core.checkServerBuilds;

export const checkServerBuild = call("serverbuilds.checkOne", {
	cfg: 0,
}) as typeof core.checkServerBuild;

export const updateServerBuild = jobCall("serverbuilds.update", {
	cfg: 0,
	reporter: { arg: 2 },
	kind: "server-build",
	targetArg: 1,
}) as typeof core.updateServerBuild;
