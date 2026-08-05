// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/configfiles: every operation touches an instance
 * directory, so all of them run on the daemon that owns the instance. The
 * template store they update is primary-owned and travels back up through the
 * save-through hook, so a follower's edit is not clobbered by the next sync.
 */

import type * as core from "../../core/configfiles";

import { call, jobCall } from "../rpc";

export { DRIFT_SUFFIX, MAX_EDIT_BYTES, looksEditable, managedPathsOf } from "../../core/configfiles";
export type {
	ConfigFileStore,
	DirEntry,
	FileContent,
	ManagedConfigFile,
	ManagedFileRow,
	PlaceholderResult,
	RenderResult,
	VariableConsumer,
	VariableReference,
	VariableUsage,
	WriteResult,
} from "../../core/configfiles";

export const loadConfigFiles = call("configfiles.load") as typeof core.loadConfigFiles;
export const browseInstance = call("configfiles.browse", { cfg: 0 }) as typeof core.browseInstance;
export const readInstanceFile = call("configfiles.read", { cfg: 0 }) as typeof core.readInstanceFile;
export const writeInstanceFile = call("configfiles.write", { cfg: 0 }) as typeof core.writeInstanceFile;
export const manageFile = call("configfiles.manage", { cfg: 0 }) as typeof core.manageFile;
export const unmanageFile = call("configfiles.unmanage", { cfg: 0 }) as typeof core.unmanageFile;
export const readoptFile = call("configfiles.readopt", { cfg: 0 }) as typeof core.readoptFile;
export const createPlaceholder = call("configfiles.createPlaceholder", {
	cfg: 0,
}) as typeof core.createPlaceholder;
export const discardDrift = call("configfiles.discardDrift", { cfg: 0 }) as typeof core.discardDrift;
export const managedFileReport = call("configfiles.report", { cfg: 0 }) as typeof core.managedFileReport;
export const variableUsage = call("configfiles.variableUsage", {
	cfg: 0,
	lock: 1,
}) as typeof core.variableUsage;
export const forgetInstance = call("configfiles.forgetInstance") as typeof core.forgetInstance;

export const renderManagedFiles = jobCall("configfiles.render", {
	cfg: 0,
	reporter: { arg: 2 },
	kind: "render-configs",
	targetArg: 1,
}) as typeof core.renderManagedFiles;
