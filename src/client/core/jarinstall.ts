// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/jarinstall. Both are RPCs: inspecting writes a scratch
 * file, and installing writes the pool (and may download), all on the daemon.
 */

import type * as core from "../../core/jarinstall";

import { call } from "../rpc";

export { MAX_JAR_DOWNLOAD } from "../../core/jarinstall";
export type { JarInspection, JarInstall } from "../../core/jarinstall";

export const inspectJar = call("jarinstall.inspect") as typeof core.inspectJar;
export const installJar = call("jarinstall.install", { cfg: 0, lock: 1 }) as typeof core.installJar;
