/**
 * Bridge mirror of core/ports: allocation math is pure; the live audits (ss,
 * config files) run in the daemon.
 */

import type * as core from "../../core/ports";

import { call } from "../rpc";

export { PORT_PRESETS, portSpecsFor, allocatedPorts, nextFreePort } from "../../core/ports";
export type { PortAllocation, PortIssue, PortRow } from "../../core/ports";

export const ensurePortAllocations = call("ports.ensurePortAllocations", {
	cfg: 0,
	lock: 1,
}) as typeof core.ensurePortAllocations;
export const auditPorts = call("ports.auditPorts", { cfg: 0, lock: 1 }) as typeof core.auditPorts;
export const collectPortRows = call("ports.collectPortRows", {
	cfg: 0,
	lock: 1,
}) as typeof core.collectPortRows;
