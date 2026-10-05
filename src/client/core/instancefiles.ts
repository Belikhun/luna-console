// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/instancefiles. Every op is routed to the daemon that
 * owns the instance, since the files only exist on that machine.
 */

import type * as core from "../../core/instancefiles";

import { call } from "../rpc";

export { MAX_FIND_DEPTH, MAX_FIND_RESULTS } from "../../core/instancefiles";
export type { DeleteOptions, FindQuery, FindResult, PathInfo, TransferOptions } from "../../core/instancefiles";

export const statInstancePath = call("instancefiles.stat", { cfg: 0 }) as typeof core.statInstancePath;
export const findInstanceFiles = call("instancefiles.find", { cfg: 0 }) as typeof core.findInstanceFiles;
export const makeInstanceDir = call("instancefiles.mkdir", { cfg: 0 }) as typeof core.makeInstanceDir;
export const copyInstancePath = call("instancefiles.copy", { cfg: 0 }) as typeof core.copyInstancePath;
export const moveInstancePath = call("instancefiles.move", { cfg: 0 }) as typeof core.moveInstancePath;
export const deleteInstancePath = call("instancefiles.delete", { cfg: 0 }) as typeof core.deleteInstancePath;
