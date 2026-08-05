import { existsSync } from "node:fs";
import { t } from "../shared/i18n";
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
	/** Shared cluster secret; required on every TCP request */
	token?: string;
	/** Follower only: primary daemon address, "host:port" */
	primary?: { address: string };
	/** Follower only: LAN host this daemon's instances are reachable on,
	 *  advertised to the primary for proxy routing (default: what the primary
	 *  sees on the socket) */
	host?: string;
	/** CurseForge API key (console.curseforge.com); the curseforge provider
	 *  reports itself unavailable without one */
	curseforgeApiKey?: string;
	/** Where the config came from, for `daemon status` */
	configFile?: string;
}

/** Default TCP port a primary daemon listens on for followers. */
export const DEFAULT_CLUSTER_PORT = 8331;

/**
 * Default daemon name: this machine's hostname. A name is a key in cluster.json
 * and decides instance ownership, so the DNS domain is dropped (two machines in
 * one cluster do not share a short hostname) and the rest is lowercased into the
 * safe character set. `name` in the config file or `LUNA_DAEMON_NAME` overrides it.
 */
export function defaultDaemonName(): string {
	const short = hostname().split(".")[0] ?? "";
	const clean = short.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

	return clean || "luna";
}

/** Config file locations, in probe order. */
function configFileCandidates(): string[] {
	const candidates: string[] = [];

	if (process.env.LUNA_DAEMON_CONFIG) {
		candidates.push(process.env.LUNA_DAEMON_CONFIG);
	}

	candidates.push("/etc/luna/daemon.json");

	if (process.env.HOME) {
		candidates.push(join(process.env.HOME, ".config", "luna", "daemon.json"));
	}

	return candidates;
}

/** Where this machine's cluster token comes from, and what it is. */
export interface TokenSource {
	/** The configured token, or undefined when this machine has none. */
	token?: string;
	/** The config file or environment variable it was read from. */
	from?: string;
}

/**
 * Read the cluster token this machine is configured with, without resolving
 * anything else.
 *
 * Deliberately not built on `resolveDaemonConfig`: that one creates the socket
 * directory and refuses a machine with no cluster root, and neither should be a
 * precondition for answering "what is my token". The first *existing* config
 * file is the answer even when it carries no token; that is the file the daemon
 * would load, so its silence is the honest result.
 */
export async function configuredToken(): Promise<TokenSource> {
	if (process.env.LUNA_TOKEN) {
		return { token: process.env.LUNA_TOKEN, from: "LUNA_TOKEN" };
	}

	for (const candidate of configFileCandidates()) {
		if (!existsSync(candidate)) {
			continue;
		}

		const file = (await Bun.file(candidate).json()) as Partial<DaemonConfig>;

		return { token: file.token, from: candidate };
	}

	return {};
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
 * overrides (`LUNA_MODE`, `LUNA_DAEMON_NAME`, `LUNA_ROOT`, `LUNA_SOCKET`,
 * `LUNA_LISTEN`, `LUNA_TOKEN`, `LUNA_PRIMARY_ADDRESS`), then defaults. A
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

	const mode = (process.env.LUNA_MODE ?? file.mode ?? "primary") as DaemonMode;

	if (mode !== "primary" && mode !== "follower") {
		throw new Error(t("daemon.invalidMode", { mode }));
	}

	const root = process.env.LUNA_ROOT ?? file.root ?? discoverRoot();

	if (!root) {
		throw new Error(
			t("daemon.rootNotFound"),
		);
	}

	const primaryAddress = process.env.LUNA_PRIMARY_ADDRESS ?? file.primary?.address;

	if (mode === "follower" && !primaryAddress) {
		throw new Error(t("daemon.followerNeedsPrimary"));
	}

	let listen = file.listen;

	if (process.env.LUNA_LISTEN) {
		listen = parseListen(process.env.LUNA_LISTEN);
	}

	if (mode === "primary" && !listen) {
		listen = { host: "0.0.0.0", port: DEFAULT_CLUSTER_PORT };
	}

	const config: DaemonConfig = {
		mode,
		name: process.env.LUNA_DAEMON_NAME ?? file.name ?? defaultDaemonName(),
		root: resolve(root),
		socket: process.env.LUNA_SOCKET ?? file.socket ?? (await pickSocketPath()),
		listen,
		token: process.env.LUNA_TOKEN ?? file.token,
		primary: primaryAddress ? { address: primaryAddress } : undefined,
		host: process.env.LUNA_HOST ?? file.host,
		curseforgeApiKey: process.env.LUNA_CURSEFORGE_KEY ?? file.curseforgeApiKey,
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
