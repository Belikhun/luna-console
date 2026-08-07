// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/services/software/registry: the version lists, which
 * reach an upstream API and so run in the daemon.
 *
 * Split from `client/core/software.ts` on purpose. That module is pure data a
 * browser component imports directly; this one imports the RPC client, which
 * carries the unix-socket plumbing and `node:path` with it. Keeping them apart
 * is what lets the console read the traits table without pulling a socket
 * client into its bundle.
 */

import { call } from "../../rpc";
import type * as registry from "../../../core/services/software/registry";

export const listMcVersions = call("software.listMcVersions") as typeof registry.listMcVersions;
export const listLoaderVersions = call("software.listLoaderVersions") as typeof registry.listLoaderVersions;
