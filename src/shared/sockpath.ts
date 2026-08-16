// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

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
		// Joined by hand rather than with `node:path`. Every path here is a POSIX
		// unix-socket path and this module is only ever right on Linux, so the
		// import bought nothing - and it cost the console: any browser bundle that
		// transitively reaches this module dies on `node:path` being externalised,
		// which is what the instance page did under `luna web --dev`.
		candidates.push(`${process.env.XDG_RUNTIME_DIR.replace(/\/+$/, "")}/luna/daemon.sock`);
	}

	candidates.push("/tmp/luna/daemon.sock");

	return candidates;
}
