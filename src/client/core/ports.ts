/**
 * Bridge mirror of core/ports: the pool arithmetic is pure registry work and runs
 * here, while anything that has to look at a machine — `ss`, the plugin config
 * files, another daemon's disk — runs in the daemon that owns it.
 */

import type * as core from "../../core/ports";

import { call } from "../rpc";

export {
	DEFAULT_PORT_POOLS,
	GAME_POOL,
	PORT_PRESETS,
	PRIMARY_MACHINE,
	acquirePort,
	allocatedPorts,
	checkPort,
	clusterMachines,
	heldPorts,
	instanceAddress,
	machineHost,
	machineInfo,
	machineLabel,
	machineOf,
	nextFreePort,
	poolCapacity,
	poolCatalog,
	poolConsumers,
	poolOf,
	poolsFor,
	portAllocations,
	portPoolUsage,
	portSpecsFor,
	resolvePool,
	setPoolCatalog,
} from "../../core/ports";
export type {
	AcquireOptions,
	AcquiredPort,
	MachineInfo,
	MachineProbe,
	PoolConsumer,
	PoolValidation,
	PortAllocation,
	PortAllocationEntry,
	PortCheck,
	PortIssue,
	PortPoolUsage,
	PortRow,
} from "../../core/ports";

export const ensurePortAllocations = call("ports.ensurePortAllocations", {
	cfg: 0,
	lock: 1,
}) as typeof core.ensurePortAllocations;
export const writePortConfigs = call("ports.writePortConfigs", {
	cfg: 0,
	lock: 1,
}) as typeof core.writePortConfigs;
export const auditPorts = call("ports.auditPorts", { cfg: 0, lock: 1 }) as typeof core.auditPorts;
export const collectPortRows = call("ports.collectPortRows", {
	cfg: 0,
	lock: 1,
}) as typeof core.collectPortRows;
export const listeningPorts = call("ports.listeningPorts") as typeof core.listeningPorts;
