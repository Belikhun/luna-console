// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/runtimes.
 *
 * Which runtime an instance resolves is pure config maths and runs locally;
 * anything touching a machine's disk or the vendors' APIs is machine-scoped and
 * goes through the routed ops, so a follower answers about its own `.runtimes`
 * and installs its own arch-specific build. The local path helpers are
 * deliberately *not* re-exported: on a client `root()` is the primary's root,
 * and a follower's runtime path is not derivable from here.
 */

import type * as core from "../../core/runtimes";
import type { ClusterConfig, InstalledRuntime, MachineRuntimes } from "../../core/types";

import { call, jobCall } from "../rpc";

export {
	RUNTIMES_DIR,
	RUNTIME_VENDORS,
	javaSelection,
	parseRuntimeId,
	runtimeConsumers,
	runtimeDirName,
	runtimeFeature,
	suggestedFeature,
	validateRuntimeId,
} from "../../core/runtimes";

/** What every machine in the fleet has installed; null runtimes = unreachable. */
export const inventory = call("runtimes.inventory", { cfg: 0 }) as (
	cfg: ClusterConfig,
) => Promise<MachineRuntimes[]>;

/** The catalog for one machine's platform. */
export const available = call("runtimes.available", { cfg: 0 }) as (
	cfg: ClusterConfig,
	machine?: string,
	opts?: { vendor?: string; feature?: number; refresh?: boolean },
) => Promise<Awaited<ReturnType<typeof core.listAvailableRuntimes>>>;

// a few hundred megabytes over the network and a tar afterwards: a job, so the
// caller's reporter follows the download rather than waiting on one request
export const install = jobCall("runtimes.install", {
	cfg: 0,
	reporter: { arg: 3, prop: "reporter" },
	kind: "runtime-install",
}) as (
	cfg: ClusterConfig,
	machine: string,
	id: string,
	opts?: { force?: boolean; reporter?: unknown },
) => Promise<InstalledRuntime>;

export const remove = call("runtimes.remove", { cfg: 0 }) as (
	cfg: ClusterConfig,
	machine: string,
	id: string,
	opts?: { force?: boolean },
) => Promise<{ removed: boolean; freedBytes?: number }>;

export const ensureForInstance = jobCall("runtimes.ensureForInstance", {
	cfg: 0,
	reporter: { arg: 2 },
	kind: "runtime-ensure",
}) as typeof core.ensureInstanceRuntime;
