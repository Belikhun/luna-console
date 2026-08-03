/**
 * Bridge mirror of core/respacks: the server-rule matcher is pure; everything
 * touching the packs directory, Modrinth or the proxy console runs in the
 * daemon.
 */

import type * as core from "../../core/respacks";

import { call } from "../rpc";

export { respackGroupServers, respackMatchesServer, toggleServerRule } from "../../core/respacks";
export type {
	RespackDefinition,
	RespackRow,
	RespackPatch,
	RespackUpdate,
} from "../../core/respacks";

export const listResourcePacks = call("respacks.listResourcePacks", { cfg: 0, lock: 1 }) as typeof core.listResourcePacks;
export const updateResourcePack = call("respacks.updateResourcePack", { cfg: 0, lock: 1 }) as typeof core.updateResourcePack;
export const addResourcePackFile = call("respacks.addResourcePackFile", { cfg: 0, lock: 1 }) as typeof core.addResourcePackFile;
export const installResourcePackFromModrinth = call("respacks.installFromModrinth", { cfg: 0, lock: 1 }) as typeof core.installResourcePackFromModrinth;
export const checkResourcePackUpdates = call("respacks.checkUpdates", { lock: 0 }) as typeof core.checkResourcePackUpdates;
export const applyResourcePackUpdate = call("respacks.applyUpdate", { lock: 0 }) as typeof core.applyResourcePackUpdate;
export const removeResourcePack = call("respacks.removeResourcePack", { cfg: 0, lock: 1 }) as typeof core.removeResourcePack;
// serving one pack on one backend is a rule edit, so it lands in the packs
// directory on the primary like every other registration change
export const setResourcePackForInstance = call("respacks.setForInstance", { cfg: 0, lock: 1 }) as typeof core.setResourcePackForInstance;
export const reloadResourcePacks = call("respacks.reload", { cfg: 0 }) as typeof core.reloadResourcePacks;
// group membership is materialized into the definitions the proxy reads, so
// the sync is a daemon-side write like every other pack mutation
export const syncResourcePackGroups = call("respacks.syncGroups", { cfg: 0, lock: 1 }) as typeof core.syncResourcePackGroups;
