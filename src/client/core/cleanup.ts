/** Bridge mirror of core/cleanup; all disk work, all in the daemon. */

import type * as core from "../../core/cleanup";

import { call } from "../rpc";

export type { CleanupPlan, CleanupResult, DiskUsage } from "../../core/cleanup";

export const diskUsage = call("cleanup.diskUsage") as typeof core.diskUsage;
export const buildPlan = call("cleanup.buildPlan", { cfg: 0 }) as typeof core.buildPlan;
export const execute = call("cleanup.execute") as typeof core.execute;
