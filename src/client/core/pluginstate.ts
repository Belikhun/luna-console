// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/pluginstate: log parsing math is pure; reading boot
 * sessions and jars happens on the instance's own daemon.
 */

import type * as core from "../../core/pluginstate";

import { call } from "../rpc";

export {
	aliasesOf,
	displayNameOf,
	pluginLogReport,
	pluginUsageReport,
} from "../../core/pluginstate";
export type {
	BootSession,
	PluginLogReport,
	InstancePluginReport,
	InstancePluginRow,
	UnmanagedAddonRow,
	UnmanagedAddonLog,
	PluginRuntimeState,
	ReportLifecycle,
	AddonCollisionReport,
	CollidingAddon,
} from "../../core/pluginstate";

export const ensureAliases = call("pluginstate.ensureAliases", { lock: 0 }) as typeof core.ensureAliases;
export const readBootSession = call("pluginstate.readBootSession", { cfg: 0 }) as typeof core.readBootSession;
export const instancePluginReport = call("pluginstate.instancePluginReport", {
	cfg: 0,
	lock: 1,
}) as typeof core.instancePluginReport;
export const unmanagedAddonLog = call("pluginstate.unmanagedAddonLog", {
	cfg: 0,
	lock: 1,
}) as typeof core.unmanagedAddonLog;
export const removeInstanceJars = call("pluginstate.removeInstanceJars", {
	cfg: 0,
	lock: 1,
}) as typeof core.removeInstanceJars;
export const addonCollisions = call("pluginstate.addonCollisions", {
	cfg: 0,
	lock: 1,
}) as typeof core.addonCollisions;
export const supersedeAddons = call("pluginstate.supersedeAddons", {
	cfg: 0,
	lock: 1,
}) as typeof core.supersedeAddons;
