/**
 * Bridge mirror of core/plugins: resolution math is pure and runs locally;
 * scanning, downloading, pinning and deploying run in the daemon. Deploy runs
 * as a job with live progress mirrored into the caller's reporter.
 */

import type * as core from "../../core/plugins";

import { call, jobCall } from "../rpc";

export {
	loadersFor,
	entryNameFor,
	assignedVersion,
	resolveEntry,
	compatReport,
	unpinVersion,
} from "../../core/plugins";
export type {
	DeployAction,
	ScanReport,
	UpdateCandidate,
	EntryResolution,
	CompatRow,
	ResolvedGroup,
	Holdback,
	JarUpload,
} from "../../core/plugins";

export const scan = call("plugins.scan", { cfg: 0, lock: 1 }) as typeof core.scan;
export const getVersionsForEntry = call("plugins.getVersionsForEntry") as typeof core.getVersionsForEntry;
export const checkUpdates = call("plugins.checkUpdates", { cfg: 0, lock: 1 }) as typeof core.checkUpdates;
export const applyUpdate = call("plugins.applyUpdate", { lock: 0 }) as typeof core.applyUpdate;
export const pinVersion = call("plugins.pinVersion", { cfg: 0, lock: 1 }) as typeof core.pinVersion;
export const ensureVariantForMc = call("plugins.ensureVariantForMc", { lock: 0 }) as typeof core.ensureVariantForMc;
export const installFromModrinth = call("plugins.installFromModrinth", { cfg: 0, lock: 1 }) as typeof core.installFromModrinth;
export const adopt = call("plugins.adopt", { cfg: 0, lock: 1 }) as typeof core.adopt;
// an uploaded jar is written into the pool, so it crosses to the daemon whole
export const uploadJar = call("plugins.uploadJar", { cfg: 0, lock: 1 }) as typeof core.uploadJar;
export const removePlugin = call("plugins.removePlugin", { cfg: 0, lock: 1 }) as typeof core.removePlugin;

export const deploy = jobCall("plugins.deploy", {
	cfg: 0,
	lock: 1,
	reporter: { arg: 2, prop: "reporter" },
	kind: "deploy",
}) as typeof core.deploy;
