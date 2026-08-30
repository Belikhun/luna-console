// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

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
	RespackVersion,
	RespackVersionChange,
	RespackReplacement,
	RespackResendScope,
	RespackResendResult,
	RespackResendTarget,
	PackRegistration,
	DynamicPack,
	DynamicPackReport,
	IdentifyPackOptions,
	RespackIdentityProbe,
} from "../../core/respacks";

export const listResourcePacks = call("respacks.listResourcePacks", { cfg: 0, lock: 1 }) as typeof core.listResourcePacks;
export const updateResourcePack = call("respacks.updateResourcePack", { cfg: 0, lock: 1 }) as typeof core.updateResourcePack;
export const addResourcePackFile = call("respacks.addResourcePackFile", { cfg: 0, lock: 1 }) as typeof core.addResourcePackFile;
// replacing a pack's zip is a write into the packs directory, and the
// definition it must not disturb lives there too
export const replaceResourcePackFile = call("respacks.replaceFile", { cfg: 0, lock: 1 }) as typeof core.replaceResourcePackFile;
export const installResourcePackFromProvider = call("respacks.installFromProvider", { cfg: 0, lock: 1 }) as typeof core.installResourcePackFromProvider;
// the published builds come from the provider, which only the daemon calls
export const resourcePackVersions = call("respacks.versions", { lock: 0 }) as typeof core.resourcePackVersions;
// switching build downloads over the pack's zip, so it is a packs-directory
// write like an upload rather than a lockfile edit
export const setResourcePackVersion = call("respacks.setVersion", { cfg: 0, lock: 1 }) as typeof core.setResourcePackVersion;
export const checkResourcePackUpdates = call("respacks.checkUpdates", { lock: 0 }) as typeof core.checkResourcePackUpdates;
export const applyResourcePackUpdate = call("respacks.applyUpdate", { lock: 0 }) as typeof core.applyResourcePackUpdate;
export const removeResourcePack = call("respacks.removeResourcePack", { cfg: 0, lock: 1 }) as typeof core.removeResourcePack;
// serving one pack on one backend is a rule edit, so it lands in the packs
// directory on the primary like every other registration change
export const setResourcePackForInstance = call("respacks.setForInstance", { cfg: 0, lock: 1 }) as typeof core.setResourcePackForInstance;
export const reloadResourcePacks = call("respacks.reload", { cfg: 0 }) as typeof core.reloadResourcePacks;
// re-offering a pack runs a command on the proxy console, which only the
// machine holding the proxy can reach
export const resendResourcePacks = call("respacks.resend") as typeof core.resendResourcePacks;
// group membership is materialized into the definitions the proxy reads, so
// the sync is a daemon-side write like every other pack mutation
export const syncResourcePackGroups = call("respacks.syncGroups", { cfg: 0, lock: 1 }) as typeof core.syncResourcePackGroups;
// the operator-facing listing: disk merged with the runtime registrations only
// the running proxy knows about
export const listResourcePacksLive = call("respacks.listLive", { cfg: 0, lock: 1 }) as typeof core.listResourcePacksLive;
export const dynamicResourcePacks = call("respacks.dynamic") as typeof core.dynamicResourcePacks;
export const takeOverDynamicPack = call("respacks.takeOverDynamic", { cfg: 0, lock: 1 }) as typeof core.takeOverDynamicPack;
export const releaseDynamicPack = call("respacks.releaseDynamic", { cfg: 0, lock: 1 }) as typeof core.releaseDynamicPack;
// provider mapping
export const probeRespackIdentity = call("respacks.probeIdentity", { cfg: 0, lock: 1 }) as typeof core.probeRespackIdentity;
export const identifyResourcePack = call("respacks.identify", { cfg: 0, lock: 1 }) as typeof core.identifyResourcePack;
export const forgetRespackIdentity = call("respacks.forgetIdentity", { cfg: 0, lock: 1 }) as typeof core.forgetRespackIdentity;
