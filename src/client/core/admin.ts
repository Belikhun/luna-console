/**
 * Bridge mirror of core/admin. Creating an instance and switching its version
 * are jobs — their progress trees stream back into the caller's reporter.
 */

import type * as core from "../../core/admin";

import { call, jobCall } from "../rpc";

export { setJavaArgs } from "../../core/admin";
export type { CreateOptions, CreateResult, SetVersionResult } from "../../core/admin";

export const detectMcVersion = call("admin.detectMcVersion") as typeof core.detectMcVersion;
export const setPort = call("admin.setPort", { cfg: 0 }) as typeof core.setPort;
export const getServerProperty = call("admin.getServerProperty", { cfg: 0 }) as typeof core.getServerProperty;
export const setServerProperty = call("admin.setServerProperty", { cfg: 0 }) as typeof core.setServerProperty;

export const deleteInstance = jobCall("admin.deleteInstance", {
	cfg: 0,
	reporter: { arg: 3 },
	kind: "delete",
	targetArg: 1,
}) as typeof core.deleteInstance;

export const createInstance = jobCall("admin.createInstance", {
	cfg: 0,
	reporter: { arg: 2, prop: "reporter" },
	kind: "create",
	targetArg: 1,
}) as typeof core.createInstance;

export const setVersion = jobCall("admin.setVersion", {
	cfg: 0,
	reporter: { arg: 3 },
	kind: "set-version",
	targetArg: 1,
}) as typeof core.setVersion;
