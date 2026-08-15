// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { existsSync } from "node:fs";
import { t } from "../shared/i18n";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { socketCandidates } from "../shared/sockpath";
// a plain constant: importing it cannot trigger core's root resolution, which
// has not been told where the root is yet at this point in the boot
import { DATA_DIR } from "../core/config";

export type DaemonMode = "primary" | "follower";

/**
 * How much of an upgrade a daemon is allowed to do without being asked.
 *
 * The default is deliberately asymmetric. A follower is a machine nobody logs
 * into, and one left behind across a protocol bump cannot be reached by the
 * primary at all, so it has to be able to fix itself; the primary is the machine
 * an operator is looking at, serves the console, and is the source the fleet
 * upgrades *from*, so it restarts when somebody says to.
 *
 * "off" also stops the primary pushing a recovery upgrade at a follower it has
 * quarantined: an operator who turned this off means it, and the fleet view now
 * says why the machine is stuck rather than leaving it to be discovered.
 */
export type AutoUpgradePolicy = "off" | "followers" | "all";

const AUTO_UPGRADE_POLICIES: AutoUpgradePolicy[] = ["off", "followers", "all"];

/** What a config that says nothing gets. */
export const DEFAULT_AUTO_UPGRADE: AutoUpgradePolicy = "followers";

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
	/** How much this daemon upgrades on its own (default: "followers") */
	autoUpgrade?: AutoUpgradePolicy;
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

/** Walk from cwd looking for a registry, mirroring core's root discovery. */
function isClusterRoot(dir: string): boolean {
	return existsSync(join(dir, DATA_DIR, "cluster.json"));
}

function discoverRoot(): string | undefined {
	let dir = process.cwd();

	while (true) {
		if (isClusterRoot(dir)) {
			return dir;
		}

		const parent = dirname(dir);

		if (parent === dir) {
			break;
		}

		dir = parent;
	}

	const toolRoot = resolve(import.meta.dir, "..", "..", "..");

	if (isClusterRoot(toolRoot)) {
		return toolRoot;
	}

	return undefined;
}

/**
 * Read the auto-upgrade policy, refusing a value it does not recognise.
 *
 * A typo here would otherwise fall through to the default and quietly leave a
 * machine upgrading itself when the config file says it should not.
 */
function parseAutoUpgrade(value: string | undefined): AutoUpgradePolicy {
	if (value === undefined) {
		return DEFAULT_AUTO_UPGRADE;
	}

	if (!AUTO_UPGRADE_POLICIES.includes(value as AutoUpgradePolicy)) {
		throw new Error(
			t("daemon.invalidAutoUpgrade", { value, allowed: AUTO_UPGRADE_POLICIES.join(", ") }),
		);
	}

	return value as AutoUpgradePolicy;
}

/**
 * Whether this daemon applies an upgrade it found on its own, with nobody
 * asking. Never true for an interactive `luna daemon upgrade`, which is a
 * decision rather than a policy.
 */
export function selfUpgradesAutomatically(config: DaemonConfig): boolean {
	const policy = config.autoUpgrade ?? DEFAULT_AUTO_UPGRADE;

	if (policy === "all") {
		return true;
	}

	return policy === "followers" && config.mode === "follower";
}

/**
 * Whether this primary pushes an upgrade at a follower it had to quarantine.
 *
 * Separate from the question above because the two are genuinely different: the
 * default is a primary that does not restart itself but does rescue a follower
 * that can no longer be reached any other way.
 */
export function pushesRecoveryUpgrades(config: DaemonConfig): boolean {
	return (config.autoUpgrade ?? DEFAULT_AUTO_UPGRADE) !== "off";
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
 * `LUNA_LISTEN`, `LUNA_TOKEN`, `LUNA_PRIMARY_ADDRESS`, `LUNA_AUTO_UPGRADE`),
 * then defaults. A
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
		autoUpgrade: parseAutoUpgrade(process.env.LUNA_AUTO_UPGRADE ?? file.autoUpgrade),
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
