// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/plugins: resolution math is pure and runs locally;
 * scanning, downloading, pinning and deploying run in the daemon. Deploy and
 * the update check run as jobs, with live progress mirrored into the caller's
 * reporter.
 */

import type * as core from "../../core/plugins";

import { call, jobCall } from "../rpc";

export {
	loadersFor,
	projectTypeFor,
	entryNameFor,
	identityFromFile,
	assignedVersion,
	resolveEntry,
	compatReport,
	unpinVersion,
	// a pure lockfile edit, like unpinVersion: the caller already holds the lock
	// and is the one that saves it, so there is nothing for the daemon to do
	setChannel,
} from "../../core/plugins";
export type {
	AddonFit,
	AppliedUpdate,
	DeployAction,
	ScanReport,
	UpdateCandidate,
	UpdateOutcome,
	EntryResolution,
	CompatRow,
	ResolvedGroup,
	Holdback,
	JarUpload,
	IdentifyPluginOptions,
	PluginIdentityProbe,
} from "../../core/plugins";

export const scan = call("plugins.scan", { cfg: 0, lock: 1 }) as typeof core.scan;
export const getVersionsForEntry = call("plugins.getVersionsForEntry") as typeof core.getVersionsForEntry;
// one provider round trip per entry; a job, so its progress reaches the caller
export const checkUpdates = jobCall("plugins.checkUpdates", {
	cfg: 0,
	lock: 1,
	reporter: { arg: 3, prop: "reporter" },
	kind: "check-updates",
}) as typeof core.checkUpdates;
export const applyUpdate = call("plugins.applyUpdate", { lock: 0 }) as typeof core.applyUpdate;
// check, download and deploy as one operation; a job, so its whole tree (a node
// per jar, with bytes) reaches the CLI view and the console's flash card alike
export const updatePlugins = jobCall("plugins.update", {
	cfg: 0,
	lock: 1,
	reporter: { arg: 2, prop: "reporter" },
	kind: "update-addons",
}) as typeof core.updatePlugins;
export const pinVersion = call("plugins.pinVersion", { cfg: 0, lock: 1 }) as typeof core.pinVersion;
export const ensureVariantForMc = call("plugins.ensureVariantForMc", { lock: 0 }) as typeof core.ensureVariantForMc;
export const fitAddonToInstance = call("plugins.fitAddonToInstance", { cfg: 0, lock: 1 }) as typeof core.fitAddonToInstance;
export const installFromProvider = call("plugins.installFromProvider", { cfg: 0, lock: 1 }) as typeof core.installFromProvider;
export const adopt = call("plugins.adopt", { cfg: 0, lock: 1 }) as typeof core.adopt;
// an uploaded jar is written into the pool, so it crosses to the daemon whole
export const uploadJar = call("plugins.uploadJar", { cfg: 0, lock: 1 }) as typeof core.uploadJar;
export const removePlugin = call("plugins.removePlugin", { cfg: 0, lock: 1 }) as typeof core.removePlugin;
// provider mapping: the probe reads the pool jar and the provider, so it runs in
// the daemon like every other identification
export const probePluginIdentity = call("plugins.probeIdentity", { lock: 0 }) as typeof core.probePluginIdentity;
export const identifyPlugin = call("plugins.identify", { cfg: 0, lock: 1 }) as typeof core.identifyPlugin;
export const forgetPluginIdentity = call("plugins.forgetIdentity", { lock: 0 }) as typeof core.forgetPluginIdentity;

export const deploy = jobCall("plugins.deploy", {
	cfg: 0,
	lock: 1,
	reporter: { arg: 2, prop: "reporter" },
	kind: "deploy",
}) as typeof core.deploy;
