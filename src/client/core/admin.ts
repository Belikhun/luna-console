// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/admin. Creating an instance and switching its version
 * are jobs; their progress trees stream back into the caller's reporter.
 */

import type * as core from "../../core/admin";

import { call, jobCall } from "../rpc";

// pure registry edits: they change the cluster config the caller already holds
// and the caller saves it, so there is nothing for the daemon to do
export { applyInstanceOptions, setJavaArgs } from "../../core/admin";
export type {
	AdoptOptions,
	AdoptResult,
	CreateOptions,
	CreateResult,
	InstanceDetection,
	InstanceOptionUpdate,
	SetVersionOptions,
	SetVersionResult,
} from "../../core/admin";

export const detectMcVersion = call("admin.detectMcVersion") as typeof core.detectMcVersion;
export const adoptInstance = call("admin.adoptInstance", { cfg: 0 }) as typeof core.adoptInstance;

/** Inspect a directory on `daemon`'s disk (its own root when omitted). */
export const inspectInstanceDir = call("admin.inspectInstanceDir") as (
	dir: string,
	daemon?: string,
) => Promise<core.InstanceDetection>;
export const setPort = call("admin.setPort", { cfg: 0 }) as typeof core.setPort;
export const ensureForwardingMod = call("admin.ensureForwardingMod", {
	cfg: 0,
	lock: 1,
}) as typeof core.ensureForwardingMod;
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
