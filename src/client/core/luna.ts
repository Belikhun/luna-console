// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/luna: workspace math is pure; gradle builds, artifact
 * scans and pool syncs run in the daemon. Builds are jobs; gradle's output
 * lines ride the progress stream.
 */

import type * as core from "../../core/luna";

import { call, jobCall } from "../rpc";

export {
	LUNA_PLATFORMS,
	LUNA_BUILD_TASK,
	lunaSource,
	outputDir,
	poolFileFor,
	stampVersion,
} from "../../core/luna";
export type {
	LunaModule,
	LunaArtifact,
	LunaBuildStamp,
	BuildOptions,
	BuildResult,
	SyncEntry,
	LunaState,
	LunaStatusRow,
} from "../../core/luna";

export const listModules = call("luna.listModules") as typeof core.listModules;
export const buildStamp = call("luna.buildStamp") as typeof core.buildStamp;
export const artifacts = call("luna.artifacts") as typeof core.artifacts;
export const strayArtifacts = call("luna.strayArtifacts") as typeof core.strayArtifacts;
export const sync = call("luna.sync", { lock: 0 }) as typeof core.sync;
export const status = call("luna.status", { cfg: 0, lock: 1 }) as typeof core.status;

export const build = jobCall("luna.build", {
	reporter: { arg: 1, prop: "reporter" },
	kind: "luna-build",
}) as typeof core.build;
