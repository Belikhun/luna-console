// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/backups.
 *
 * Every op is routed on its instance argument, because both the archives and
 * the index describing them live on the machine that owns the instance rather
 * than on the primary. That is also why the ops take an instance name that the
 * core functions themselves do not: the daemon-side wrappers exist to give the
 * router something to route on, and to refuse a backup id belonging to a
 * different instance than the one the call was addressed to.
 *
 * Creating, restoring and verifying all read or write tens of gigabytes, so
 * they are jobs.
 */

import type * as core from "../../core/backups";
import type { ClusterConfig } from "../../core/types";
import type { WorldMutationResult } from "../../core/worldops";

import { call, jobCall } from "../rpc";

export type { BackupDrift, BackupEntry, BackupStore, BackupTrigger } from "../../core/backups";
export { DEFAULT_KEEP_COUNT } from "../../core/backups";

export const listBackups = call("backups.list", { cfg: 0 }) as (
	cfg: ClusterConfig,
	instance: string,
) => Promise<core.BackupEntry[]>;

export const updateBackup = call("backups.update", { cfg: 0 }) as (
	cfg: ClusterConfig,
	instance: string,
	id: string,
	patch: { label?: string; note?: string; pinned?: boolean },
) => Promise<core.BackupEntry>;

export const deleteBackup = call("backups.delete", { cfg: 0 }) as (
	cfg: ClusterConfig,
	instance: string,
	id: string,
	actor?: string,
) => Promise<core.BackupEntry | undefined>;

export const setKeepCount = call("backups.setKeep", { cfg: 0 }) as (
	cfg: ClusterConfig,
	instance: string,
	keep: number,
) => Promise<number>;

export const backupDrift = call("backups.drift", { cfg: 0 }) as (
	cfg: ClusterConfig,
	instance: string,
) => Promise<core.BackupDrift>;

export const createBackup = jobCall("backups.create", {
	cfg: 0,
	reporter: { arg: 2, prop: "reporter" },
	kind: "world-backup",
	targetArg: 1,
}) as typeof core.createBackup;

export const restoreBackup = jobCall("backups.restore", {
	cfg: 0,
	reporter: { arg: 3, prop: "reporter" },
	kind: "world-restore",
	targetArg: 1,
}) as (
	cfg: ClusterConfig,
	instance: string,
	id: string,
	opts?: core.RestoreOptions,
) => Promise<WorldMutationResult>;

export const verifyBackup = jobCall("backups.verify", {
	cfg: 0,
	reporter: { arg: 3 },
	kind: "world-verify",
	targetArg: 1,
}) as (cfg: ClusterConfig, instance: string, id: string) => Promise<core.BackupEntry>;
