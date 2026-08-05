// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { join } from "node:path";

/**
 * Well-known locations of the daemon's local API socket, in probe order. The
 * daemon binds the first path whose directory it can create; clients probe the
 * same order and talk to the first socket that answers. `LUNA_SOCKET` overrides
 * both sides, so tests and secondary daemons can isolate themselves.
 */
export function socketCandidates(): string[] {
	const candidates: string[] = [];

	if (process.env.LUNA_SOCKET) {
		candidates.push(process.env.LUNA_SOCKET);
	}

	candidates.push("/run/luna/daemon.sock");

	if (process.env.XDG_RUNTIME_DIR) {
		candidates.push(join(process.env.XDG_RUNTIME_DIR, "luna", "daemon.sock"));
	}

	candidates.push("/tmp/luna/daemon.sock");

	return candidates;
}
