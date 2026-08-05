// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/logs. The read runs on the daemon that owns the
 * instance; routed to a follower when the log lives on another machine.
 */

import type * as core from "../../core/logs";

import { call } from "../rpc";

export { DEFAULT_LOG_LINES, MAX_LOG_LINES } from "../../core/logs";
export type { InstanceLogs } from "../../core/logs";

export const readInstanceLogs = call("logs.readInstanceLogs", { cfg: 0 }) as typeof core.readInstanceLogs;
