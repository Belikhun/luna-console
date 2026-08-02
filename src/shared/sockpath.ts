import { join } from "node:path";

/**
 * Well-known locations of the daemon's local API socket, in probe order. The
 * daemon binds the first path whose directory it can create; clients probe the
 * same order and talk to the first socket that answers. `MRDS_SOCKET` overrides
 * both sides, so tests and secondary daemons can isolate themselves.
 */
export function socketCandidates(): string[] {
	const candidates: string[] = [];

	if (process.env.MRDS_SOCKET) {
		candidates.push(process.env.MRDS_SOCKET);
	}

	candidates.push("/run/mrds/daemon.sock");

	if (process.env.XDG_RUNTIME_DIR) {
		candidates.push(join(process.env.XDG_RUNTIME_DIR, "mrds", "daemon.sock"));
	}

	candidates.push("/tmp/mrds/daemon.sock");

	return candidates;
}
