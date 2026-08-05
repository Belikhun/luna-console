// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** Bridge mirror of core/proxy; velocity.toml lives beside the primary daemon. */

import { join } from "node:path";

import type * as core from "../../core/proxy";
import type { ClusterConfig } from "../../core/types";

import { call } from "../rpc";
import { clientRoot } from "../socket";

/** Absolute path of the proxy's velocity.toml (on the daemon's host). */
export function velocityTomlPath(cfg: ClusterConfig): string {
	return join(clientRoot(), cfg.proxy.dir, "velocity.toml");
}

export const syncVelocityToml = call("proxy.syncVelocityToml", { cfg: 0 }) as typeof core.syncVelocityToml;
export const readVelocityServers = call("proxy.readVelocityServers", { cfg: 0 }) as typeof core.readVelocityServers;
export const readForwardingSecret = call("proxy.readForwardingSecret", { cfg: 0 }) as typeof core.readForwardingSecret;
