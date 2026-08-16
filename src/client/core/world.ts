// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/world and core/worldops.
 *
 * Everything here reads or rewrites an instance's directory, so all of it runs
 * in the daemon that owns the instance; the ops carry the instance argument
 * index that routes them there. Replace and reset can outlast an HTTP request,
 * so they are jobs and the caller's reporter is fed from the snapshot mirror.
 *
 * The upload itself is deliberately not here. A world zip does not fit through
 * an RPC argument, so it goes to `/files/stage/<token>` on the daemon socket
 * and what these ops take is the token.
 */

import type * as core from "../../core/world";
import type * as ops from "../../core/worldops";
import type * as staging from "../../core/staging";

import { call, jobCall } from "../rpc";

export type {
	ArchiveLayout,
	DimensionKind,
	LevelInfo,
	WorldDimension,
	WorldFinding,
	WorldImportPlan,
	WorldMove,
	WorldReport,
	WorldScan,
	WorldTarget,
} from "../../core/world";

export type {
	WorldJournal,
	WorldMutationResult,
	WorldOpKind,
	WorldOpPhase,
	WorldRecovery,
} from "../../core/worldops";

export type { StagedFile } from "../../core/staging";

/** What the archive holds, and where each part of it would land. */
export type StagedWorldScan = core.WorldScan & { plan: core.WorldImportPlan };

export const worldInfo = call("world.info", { cfg: 0 }) as typeof core.worldInfo;
export const worldLock = call("world.lock", { cfg: 0 }) as typeof ops.worldLock;
export const recoverWorldOp = call("world.recover", { cfg: 0 }) as typeof ops.recoverWorldOp;

/** Inspect a staged upload against one instance, without installing anything. */
export const scanStagedWorld = call("world.scanStaged", { cfg: 0 }) as (
	cfg: Parameters<typeof core.worldInfo>[0],
	instance: string,
	token: string,
) => Promise<StagedWorldScan>;

/**
 * The same, for a world whose target instance does not exist yet.
 *
 * The launch wizard needs this: it validates an archive against the software
 * and version the operator has just picked, before anything has been created.
 */
export const scanArchiveFor = call("world.scanArchive", {}) as (
	token: string,
	software: string,
	mcVersion: string | undefined,
	level: string,
) => Promise<StagedWorldScan>;

export const replaceWorld = jobCall("world.replace", {
	cfg: 0,
	reporter: { arg: 3, prop: "reporter" },
	kind: "world-replace",
	targetArg: 1,
}) as (
	cfg: Parameters<typeof core.worldInfo>[0],
	instance: string,
	token: string,
	opts?: ops.ReplaceWorldOptions & { keepStage?: boolean },
) => Promise<ops.WorldMutationResult>;

export const resetWorld = jobCall("world.reset", {
	cfg: 0,
	reporter: { arg: 2, prop: "reporter" },
	kind: "world-reset",
	targetArg: 1,
}) as typeof ops.resetWorld;

export const stageInfo = call("staging.info", {}) as typeof staging.stageInfo;
export const discardStage = call("staging.discard", {}) as typeof staging.discardStage;

/**
 * A token for a new upload.
 *
 * Generated locally rather than asked of the daemon: it is a random opaque id
 * with no server-side state behind it until bytes arrive, so a round trip to
 * mint one would buy nothing. The daemon validates the shape when the upload
 * lands, which is the check that actually matters.
 */
export function newStageToken(): string {
	return crypto.randomUUID().replace(/-/g, "");
}
