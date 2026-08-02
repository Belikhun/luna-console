import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { socketCandidates } from "../shared/sockpath";

export type DaemonMode = "primary" | "follower";

/** TCP listener a primary daemon opens for its followers. */
export interface DaemonListen {
	host: string;
	port: number;
}

export interface DaemonConfig {
	mode: DaemonMode;
	/** Daemon name, unique across the cluster (default: hostname) */
	name: string;
	/** Cluster root this daemon manages (instances, state files, pool) */
	root: string;
	/** Local API socket path */
	socket: string;
	/** Primary only: TCP listener for followers (and remote tooling) */
	listen?: DaemonListen;
	/** Shared cluster secret — required on every TCP request */
	token?: string;
	/** Follower only: primary daemon address, "host:port" */
	primary?: { address: string };
	/** Follower only: LAN host this daemon's instances are reachable on,
	 *  advertised to the primary for proxy routing (default: what the primary
	 *  sees on the socket) */
	host?: string;
	/** Where the config came from, for `daemon status` */
	configFile?: string;
}

/** Default TCP port a primary daemon listens on for followers. */
export const DEFAULT_CLUSTER_PORT = 8331;

/** Config file locations, in probe order. */
function configFileCandidates(): string[] {
	const candidates: string[] = [];

	if (process.env.MRDS_DAEMON_CONFIG) {
		candidates.push(process.env.MRDS_DAEMON_CONFIG);
	}

	candidates.push("/etc/mrds/daemon.json");

	if (process.env.HOME) {
		candidates.push(join(process.env.HOME, ".config", "mrds", "daemon.json"));
	}

	return candidates;
}

/** Walk from cwd looking for a cluster.json, mirroring core's root discovery. */
function discoverRoot(): string | undefined {
	let dir = process.cwd();

	while (true) {
		if (existsSync(join(dir, "cluster.json"))) {
			return dir;
		}

		const parent = dirname(dir);

		if (parent === dir) {
			break;
		}

		dir = parent;
	}

	const toolRoot = resolve(import.meta.dir, "..", "..", "..");

	if (existsSync(join(toolRoot, "cluster.json"))) {
		return toolRoot;
	}

	return undefined;
}

/** Parse "host:port" or bare "port" into a listen spec. */
function parseListen(value: string): DaemonListen {
	const colon = value.lastIndexOf(":");

	if (colon === -1) {
		return { host: "0.0.0.0", port: Number(value) };
	}

	return { host: value.slice(0, colon) || "0.0.0.0", port: Number(value.slice(colon + 1)) };
}

/**
 * Resolve the daemon's configuration: JSON config file first, then environment
 * overrides (`MRDS_MODE`, `MRDS_DAEMON_NAME`, `MRDS_ROOT`, `MRDS_SOCKET`,
 * `MRDS_LISTEN`, `MRDS_TOKEN`, `MRDS_PRIMARY_ADDRESS`), then defaults. A
 * missing file plus a discoverable cluster root means "primary with defaults",
 * so a single-host setup needs no configuration at all.
 */
export async function resolveDaemonConfig(): Promise<DaemonConfig> {
	let file: Partial<DaemonConfig> = {};
	let configFile: string | undefined;

	for (const candidate of configFileCandidates()) {
		if (existsSync(candidate)) {
			file = await Bun.file(candidate).json();
			configFile = candidate;

			break;
		}
	}

	const mode = (process.env.MRDS_MODE ?? file.mode ?? "primary") as DaemonMode;

	if (mode !== "primary" && mode !== "follower") {
		throw new Error(`invalid daemon mode: ${mode} (expected primary or follower)`);
	}

	const root = process.env.MRDS_ROOT ?? file.root ?? discoverRoot();

	if (!root) {
		throw new Error(
			"cluster root not found — set root in the daemon config, MRDS_ROOT, or run inside the cluster directory",
		);
	}

	const primaryAddress = process.env.MRDS_PRIMARY_ADDRESS ?? file.primary?.address;

	if (mode === "follower" && !primaryAddress) {
		throw new Error("follower mode requires primary.address (or MRDS_PRIMARY_ADDRESS)");
	}

	let listen = file.listen;

	if (process.env.MRDS_LISTEN) {
		listen = parseListen(process.env.MRDS_LISTEN);
	}

	if (mode === "primary" && !listen) {
		listen = { host: "0.0.0.0", port: DEFAULT_CLUSTER_PORT };
	}

	const config: DaemonConfig = {
		mode,
		name: process.env.MRDS_DAEMON_NAME ?? file.name ?? hostname(),
		root: resolve(root),
		socket: process.env.MRDS_SOCKET ?? file.socket ?? (await pickSocketPath()),
		listen,
		token: process.env.MRDS_TOKEN ?? file.token,
		primary: primaryAddress ? { address: primaryAddress } : undefined,
		host: process.env.MRDS_HOST ?? file.host,
		configFile,
	};

	return config;
}

/** First well-known socket path whose directory this process can create. */
async function pickSocketPath(): Promise<string> {
	const candidates = socketCandidates();

	for (const candidate of candidates) {
		try {
			await mkdir(dirname(candidate), { recursive: true });

			return candidate;
		} catch {
			continue;
		}
	}

	// /tmp is always writable, so this is unreachable in practice
	return candidates[candidates.length - 1]!;
}
