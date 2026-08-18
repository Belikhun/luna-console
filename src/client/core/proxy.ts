// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** Bridge mirror of core/proxy; velocity.toml lives beside the primary daemon. */

import { join } from "node:path";

import type * as core from "../../core/proxy";
import type { ClusterConfig } from "../../core/types";

import { call } from "../rpc";
import { clientRoot } from "../socket";

// pure registry edit: it changes the cluster config the caller already holds
// and the caller saves it, so there is nothing for the daemon to do
export { setProxyRegistration } from "../../core/proxy";
export type { ProxyRegistrationUpdate } from "../../core/proxy";

/** Absolute path of the proxy's velocity.toml (on the daemon's host). */
export function velocityTomlPath(cfg: ClusterConfig): string {
	return join(clientRoot(), cfg.proxy.dir, "velocity.toml");
}

export const syncVelocityToml = call("proxy.syncVelocityToml", { cfg: 0 }) as typeof core.syncVelocityToml;
export const readVelocityServers = call("proxy.readVelocityServers", { cfg: 0 }) as typeof core.readVelocityServers;
export const readForwardingSecret = call("proxy.readForwardingSecret", { cfg: 0 }) as typeof core.readForwardingSecret;
