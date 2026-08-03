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
	PluginRuntimeState,
	ReportLifecycle,
} from "../../core/pluginstate";

export const ensureAliases = call("pluginstate.ensureAliases", { lock: 0 }) as typeof core.ensureAliases;
export const readBootSession = call("pluginstate.readBootSession", { cfg: 0 }) as typeof core.readBootSession;
export const instancePluginReport = call("pluginstate.instancePluginReport", {
	cfg: 0,
	lock: 1,
}) as typeof core.instancePluginReport;
export const removeInstanceJars = call("pluginstate.removeInstanceJars", {
	cfg: 0,
	lock: 1,
}) as typeof core.removeInstanceJars;
