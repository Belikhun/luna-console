// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/instances: pure helpers run locally, everything that
 * touches screens, processes or the network runs in the daemon; routed to the
 * owning follower when the instance lives on another machine.
 */

import type * as core from "../../core/instances";

import { call } from "../rpc";

export {
	NORESTART,
	RESTARTING,
	DEFAULT_RESTART_DELAY,
	MAX_RESTART_DELAY,
	autoRestartOf,
	restartDelayOf,
	validateRestartDelay,
	sessionName,
	jarName,
	stopCommand,
	buildJavaCommand,
	orderedNames,
} from "../../core/instances";
export type { InstanceStatus } from "../../core/instances";

export const writeRunScript = call("instances.writeRunScript", { cfg: 0 }) as typeof core.writeRunScript;
export const getStatus = call("instances.getStatus", { cfg: 0 }) as typeof core.getStatus;
export const getAllStatuses = call("instances.getAllStatuses", { cfg: 0 }) as typeof core.getAllStatuses;
export const startInstance = call("instances.startInstance", { cfg: 0 }) as typeof core.startInstance;
export const stopInstance = call("instances.stopInstance", { cfg: 0 }) as typeof core.stopInstance;
export const sendCommand = call("instances.sendCommand", { cfg: 0 }) as typeof core.sendCommand;
