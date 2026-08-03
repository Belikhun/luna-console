/**
 * Bridge mirror of core/datapacks: everything touches the pool or instance
 * worlds, so it all runs in the daemon. Deploy runs as a job with live
 * progress mirrored into the caller's reporter, exactly like plugin deploys.
 */

import type * as core from "../../core/datapacks";

import { call, jobCall } from "../rpc";

export type {
	DataPackRow,
	InstanceDataPackRow,
	DataPackDeployAction,
	DataPackUpdate,
} from "../../core/datapacks";

export const listDataPacks = call("datapacks.list", { cfg: 0, lock: 1 }) as typeof core.listDataPacks;
export const instanceDataPackReport = call("datapacks.instanceReport", { cfg: 0, lock: 1 }) as typeof core.instanceDataPackReport;
export const installDataPackFromModrinth = call("datapacks.installFromModrinth", { cfg: 0, lock: 1 }) as typeof core.installDataPackFromModrinth;
export const checkDataPackUpdates = call("datapacks.checkUpdates", { cfg: 0, lock: 1 }) as typeof core.checkDataPackUpdates;
export const applyDataPackUpdate = call("datapacks.applyUpdate", { lock: 0 }) as typeof core.applyDataPackUpdate;
export const addDataPackFile = call("datapacks.addFile", { cfg: 0, lock: 1 }) as typeof core.addDataPackFile;
export const adoptDataPack = call("datapacks.adopt", { cfg: 0, lock: 1 }) as typeof core.adoptDataPack;
// routed in the daemon: each owner deletes its own worlds' copies, then the
// lock entry is settled once
export const removeDataPack = call("datapacks.remove", { cfg: 0, lock: 1 }) as typeof core.removeDataPack;

export const deployDataPacks = jobCall("datapacks.deploy", {
	cfg: 0,
	lock: 1,
	reporter: { arg: 2, prop: "reporter" },
	kind: "datapack-deploy",
}) as typeof core.deployDataPacks;
