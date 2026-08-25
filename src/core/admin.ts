// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { ClusterConfig, InstanceConfig, PluginFamily, PluginsLock, ProviderId, Software } from "./types";
import { addonDirsOf, instanceDir, loadLock, managedInstances, root, saveLock } from "./config";
import { forgetInstancePlugins, installFromProvider, projectTypeFor } from "./plugins";
import { getProject } from "./services/providers";
import { installBuild } from "./services/software/install";
import { resolveBuild } from "./services/software/registry";
import type { SoftwareBuild } from "./services/software/types";
import { SOFTWARE_IDS, familyForDir, hasProvider, traitsOf } from "./software";
import { readForwardingSecret } from "./proxy";
import {
	GAME_POOL,
	PRIMARY_MACHINE,
	acquirePort,
	checkPort,
	heldPorts,
	machineLabel,
	machineOf,
	releaseInstancePorts,
	releaseReservation,
	reservePort,
} from "./ports";
import { getConfValue, setConfValue } from "./confedit";
import { forgetInstance } from "./configfiles";
import { DEFAULT_RESTART_DELAY, validateRestartDelay } from "./instances";
import { loadEnv, saveEnv, unsetInstanceScope } from "./environment";
import { assertMemoryValue, MEMORY_FALLBACK } from "./memory";
import { ProgressReporter } from "./progress";
import {
	ensureJavaFloor,
	ensureRuntime,
	javaSelection,
	resolveJavaPath,
	validateRuntimeId,
} from "./runtimes";
import { SERVER_SETTINGS, validateJavaAgents, validateJavaArgs, validateSettings } from "./settings";
import { stagePath } from "./staging";
import { layoutOf, planWorldImport, scanWorldArchive } from "./world";
import type { WorldFinding } from "./world";
import { materializeWorld } from "./worldops";
import { listArchive } from "./services/archive";
import { buildPlatform } from "../version";
import { t } from "../shared/i18n";

/**
 * `currentVersion` out of version_history.json, e.g.
 * "1.21.11-127-bd74bf6 (MC: 1.21.11)".
 *
 * The paper family writes this file itself on every boot, which makes it the one
 * place a server states what it is actually running rather than what the
 * registry believes. Velocity, the hybrids and pumpkin write nothing like it.
 */
async function versionHistory(dir: string): Promise<string | undefined> {
	const path = join(dir, "version_history.json");

	if (!existsSync(path)) {
		return undefined;
	}

	try {
		const data = await Bun.file(path).json();
		const current = String(data.currentVersion ?? "");

		return current || undefined;
	} catch {
		return undefined;
	}
}

/** Parse "1.21.11-127-bd74bf6 (MC: 1.21.11)" from version_history.json. */
export async function detectMcVersion(dir: string): Promise<string | undefined> {
	return (await versionHistory(dir))?.match(/MC:\s*([\d.]+)/)?.[1];
}

/**
 * The build number out of the same string: the `127` in
 * "1.21.11-127-bd74bf6 (MC: 1.21.11)".
 *
 * This is what makes an update check work on a backend luna did not install.
 * The middle field is the paper build number, which is exactly what the Fill API
 * calls a build id, so the two are directly comparable.
 */
export async function detectBuildId(dir: string): Promise<string | undefined> {
	const current = await versionHistory(dir);

	return current?.match(/^[\d.]+-(\d+)-/)?.[1];
}

/**
 * Stamp the build a resolved install came from onto the registry entry.
 *
 * Skipped for the args-file loaders, whose `buildId` *is* their `loaderVersion`:
 * storing it twice invites the two to disagree, and `installedBuild` reads the
 * loader field for them anyway.
 */
function recordBuildId(inst: InstanceConfig, build: SoftwareBuild): void {
	if (traitsOf(inst.software, inst.mcVersion).pinsLoaderVersion) {
		delete inst.buildId;

		return;
	}

	if (build.buildId) {
		inst.buildId = build.buildId;
	}
}

/** What an existing server directory says about itself. */
export interface InstanceDetection {
	software: Software;
	mcVersion?: string;
	/** neoforge only: the installed loader build */
	loaderVersion?: string;
	/** server.properties `server-port`, when the file has one */
	port?: number;
	/** `-Xmx` found in the launcher the directory already ships with */
	memory?: string;
	/** server.properties `server-ip`, when the file has one */
	bindAddress?: string;
}

/** Newest loader build installed under `libraries/`, by directory name. */
async function detectLoaderVersion(dir: string, libraryPath: string): Promise<string | undefined> {
	const libraries = join(dir, libraryPath);

	if (!existsSync(libraries)) {
		return undefined;
	}

	const builds: string[] = [];

	for (const entry of await readdir(libraries, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}

		// modern era: the installer wrote the launch arguments beside the jars
		if (existsSync(join(libraries, entry.name, "unix_args.txt"))) {
			builds.push(entry.name);
			continue;
		}

		// legacy forge: the same tree, but the version directory holds only the
		// runnable universal jar (`forge-1.12.2-14.23.5.2859.jar`, older installers
		// append `-universal`). Only forge's own tree can contain these names, so
		// the check cannot misfire on neoforge's.
		if (
			existsSync(join(libraries, entry.name, `forge-${entry.name}.jar`))
			|| existsSync(join(libraries, entry.name, `forge-${entry.name}-universal.jar`))
		) {
			builds.push(entry.name);
		}
	}

	// numeric-aware so 21.1.9 sorts before 21.1.233
	builds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

	return builds.at(-1);
}

/**
 * The MC version a forge-family pack targets. The launcher script records it in
 * `.previousrun` after a successful boot; a pack that has never run only has
 * the installer's `--fml.mcVersion` in its argument file.
 */
async function detectLoaderMcVersion(
	dir: string,
	libraryPath: string,
	loaderVersion: string,
): Promise<string | undefined> {
	const previous = join(dir, ".previousrun");

	if (existsSync(previous)) {
		const text = await Bun.file(previous).text();
		const match = text.match(/^PREVIOUS_MINECRAFT_VERSION=(.+)$/m);

		if (match?.[1]) {
			return match[1].trim();
		}
	}

	const args = join(dir, libraryPath, loaderVersion, "unix_args.txt");

	if (existsSync(args)) {
		const text = await Bun.file(args).text();
		const match = text.match(/--fml\.mcVersion\s+(\S+)/);

		if (match?.[1]) {
			return match[1];
		}
	}

	return undefined;
}

/**
 * The heap the directory's own launcher asks for. Read so an adopted instance
 * keeps running with the memory it was tuned for instead of silently dropping
 * to luna's default. Neoforge keeps it in `user_jvm_args.txt`, everything else
 * in whatever start script the operator wrote by hand.
 */
async function detectMemory(dir: string): Promise<string | undefined> {
	for (const file of ["user_jvm_args.txt", "run.sh", "start", "start.sh"]) {
		const path = join(dir, file);

		if (!existsSync(path)) {
			continue;
		}

		const text = await Bun.file(path).text();

		// a commented-out example (# -Xmx4G) is documentation, not a setting
		for (const line of text.split(/\r?\n/)) {
			if (line.trimStart().startsWith("#")) {
				continue;
			}

			const match = line.match(/-Xmx(\d+[KMG]?)\b/i);

			if (match?.[1]) {
				return match[1].toUpperCase();
			}
		}
	}

	return undefined;
}

/**
 * Work out what an existing server directory is, without changing anything in
 * it. The forge family is recognised by the installer's `libraries/` tree
 * (either era: an argument file, or legacy's universal jar), velocity by its
 * jar, and everything else is assumed to be paper, which is what
 * `version_history.json` then confirms with an MC version.
 *
 * A relative path is resolved against this daemon's cluster root, so callers
 * can pass the plain directory name an instance would be registered under.
 */
export async function inspectInstanceDir(path: string): Promise<InstanceDetection> {
	const dir = isAbsolute(path) ? path : join(root(), path);

	if (!existsSync(dir)) {
		throw new Error(t("core.admin.dirMissing", { dir }));
	}

	const properties = join(dir, "server.properties");
	const detection: InstanceDetection = { software: "paper" };

	if (existsSync(properties)) {
		const port = await getConfValue(properties, "properties", "server-port");
		const bind = await getConfValue(properties, "properties", "server-ip");

		if (port !== undefined && /^\d+$/.test(port)) {
			detection.port = parseInt(port);
		}

		if (bind !== undefined) {
			detection.bindAddress = bind;
		}
	}

	const memory = await detectMemory(dir);

	if (memory) {
		detection.memory = memory;
	}

	// modern loaders are recognised by the library tree their installer wrote;
	// legacy forge has none, so it is probed separately by its universal jar
	for (const software of SOFTWARE_IDS) {
		const libraryPath = traitsOf(software).libraryPath;

		if (!libraryPath) {
			continue;
		}

		const loaderVersion = await detectLoaderVersion(dir, libraryPath);

		if (!loaderVersion) {
			continue;
		}

		detection.software = software;

		// forge names its tree `<mc>-<forge>`; the registry stores the halves apart
		const split = software === "forge" ? loaderVersion.indexOf("-") : -1;

		detection.loaderVersion = split > 0 ? loaderVersion.slice(split + 1) : loaderVersion;

		const mcVersion = split > 0
			? loaderVersion.slice(0, split)
			: await detectLoaderMcVersion(dir, libraryPath, loaderVersion);

		if (mcVersion) {
			detection.mcVersion = mcVersion;
		}

		return detection;
	}

	if (existsSync(join(dir, "velocity.jar"))) {
		detection.software = "velocity";

		return detection;
	}

	// pumpkin is a native executable, so its own binary is the only marker
	if (existsSync(join(dir, "pumpkin")) && existsSync(join(dir, PUMPKIN_CONFIG))) {
		detection.software = "pumpkin";

		return detection;
	}

	// fabric's launcher jar is what its installer leaves behind; the paper forks
	// all look alike from here and are adopted as paper, which they behave as
	if (existsSync(join(dir, "fabric-server-launch.jar"))) {
		detection.software = "fabric";
	}

	const mcVersion = await detectMcVersion(dir);

	if (mcVersion) {
		detection.mcVersion = mcVersion;
	}

	return detection;
}

export interface AdoptOptions {
	/** directory name under the cluster root (default: the instance name) */
	dir?: string;
	/** override the detected game port */
	port?: number;
	/** override the detected heap size */
	memory?: string;
	/** java profile whose flags the generated run script uses (default aikar) */
	profile?: string;
	/** pin a java binary; a modpack often needs an older JDK than the host default */
	java?: string;
	/** extra JVM flags for the generated run script */
	javaArgs?: string[];
	/** register in velocity.toml (default true) */
	register?: boolean;
	/** hostnames force-routed to this instance */
	forcedHosts?: string[];
	/** daemon that owns the instance (absent = the primary's host) */
	daemon?: string;
}

export interface AdoptResult {
	name: string;
	dir: string;
	detected: InstanceDetection;
	inst: InstanceConfig;
	/** things worth telling the operator that adopt deliberately did not change */
	notes: string[];
}

/**
 * Register a server directory that already exists as a managed instance.
 *
 * Adoption is **read-only against the directory**: it inspects the files to
 * work out what the server is, then writes the registry entry. It never edits
 * server.properties, never touches plugins or mods, and never adds anything to
 * the lockfile: the directory is already configured and working, and rewriting
 * it is exactly the way to break a server that was fine. Anything luna would
 * have done differently comes back as a note instead.
 *
 * Mutates cfg with the new entry; the caller saves and runs the proxy sync.
 */
export async function adoptInstance(
	cfg: ClusterConfig,
	name: string,
	opts: AdoptOptions = {},
): Promise<AdoptResult> {
	if (!/^[a-z0-9_-]+$/.test(name)) {
		throw new Error(t("core.admin.badName"));
	}

	if (name === "proxy") {
		throw new Error(t("core.admin.proxyNotAdoptable"));
	}

	const existing = cfg.instances[name];

	// an external entry is a placeholder for exactly this server, so adopting it
	// is an upgrade of that registration rather than a conflict
	if (existing && !existing.external) {
		throw new Error(t("core.admin.alreadyManaged", { name }));
	}

	const dirName = opts.dir ?? existing?.dir ?? name;
	const dir = join(root(), dirName);

	if (!existsSync(dir)) {
		throw new Error(t("core.admin.adoptDirMissing", { dir }));
	}

	const badArgs = validateJavaArgs(opts.javaArgs ?? []);

	if (badArgs) {
		throw new Error(badArgs);
	}

	const detected = await inspectInstanceDir(dir);
	const port = opts.port ?? detected.port ?? existing?.port;

	if (!port) {
		throw new Error(t("core.admin.noPortDetected", { name }));
	}

	// A port is only taken on the machine that binds it: the proxy holds 25565 on
	// the primary, which says nothing about a follower's own 25565.
	const check = checkPort(cfg, port, { machine: opts.daemon, instance: name });

	if (!check.ok) {
		throw new Error(check.error);
	}

	const notes: string[] = [];

	// adopt takes the port the directory already binds, so a number outside the
	// machine's pools is reported rather than moved; the server is running on it
	if (check.warning) {
		notes.push(check.warning);
	}

	const memory = opts.memory ?? detected.memory;

	if (!memory) {
		notes.push(t("core.admin.noXmx"));
	}

	const inst: InstanceConfig = {
		dir: dirName,
		software: detected.software,
		port,
		memory: memory ?? "2G",
		profile: opts.profile ?? "aikar",
		proxy: {
			register: opts.register ?? existing?.proxy?.register ?? true,
		},
	};

	if (detected.mcVersion) {
		inst.mcVersion = detected.mcVersion;
	}

	if (detected.loaderVersion) {
		inst.loaderVersion = detected.loaderVersion;
	}

	if (opts.java) {
		inst.java = opts.java;
	}

	if (opts.javaArgs?.length) {
		inst.javaArgs = opts.javaArgs;
	}

	const forcedHosts = opts.forcedHosts ?? existing?.proxy?.forcedHosts;

	if (forcedHosts?.length) {
		inst.proxy!.forcedHosts = forcedHosts;
	}

	if (existing?.proxy?.priority !== undefined) {
		inst.proxy!.priority = existing.proxy.priority;
	}

	if (opts.daemon) {
		inst.daemon = opts.daemon;
	}

	// A follower's backend is reached across the LAN, so a loopback bind makes it
	// unreachable no matter what velocity.toml says. Reported, not corrected:
	// server.properties belongs to the server, and adopt does not rewrite it.
	if (inst.proxy!.register) {
		const wanted = opts.daemon ? "0.0.0.0" : "127.0.0.1";
		const bind = detected.bindAddress;

		if (bind !== undefined && bind !== "" && bind !== wanted) {
			notes.push(t("core.admin.bindMismatch", { bind, wanted }));
		}

		if (opts.daemon && bind === "") {
			notes.push(t("core.admin.bindEmpty"));
		}
	}

	if (detected.port !== undefined && detected.port !== port) {
		notes.push(
			t("core.admin.portMismatch", {
				port,
				detected: detected.port,
				command: `luna instance config ${name} port ${port}`,
			}),
		);
	}

	// A jar launch runs exactly `-jar <binaryName>`, and a hand-made directory
	// usually keeps the jar under its distribution name (`forge-1.12.2-….jar`,
	// `paper-1.20.1-196.jar`). Reported, not renamed: adopt does not write into
	// the directory, and the operator may be pointing a symlink at it.
	const binary = traitsOf(inst.software, inst.mcVersion).binaryName;

	if (binary && !existsSync(join(dir, binary))) {
		notes.push(t("core.admin.binaryMissing", { binary }));
	}

	// what the directory already contains is accounted for separately, by
	// `adoptInstanceAddons`; adopt itself never reads or writes an addon
	notes.push(t("core.admin.addonsUnmanaged", { dir: addonDirsOf(inst.software).join(", ") }));

	cfg.instances[name] = inst;

	return { name, dir, detected, inst, notes };
}

/**
 * server.properties for a fresh backend: every setting luna knows about, at the
 * value the caller asked for or at the schema's default. Paper fills in the keys
 * outside that list on first boot. The keys marked `managed` in the schema keep
 * their default whatever was requested; they are what makes velocity forwarding
 * work.
 *
 * `bindAddress` is the one managed key that is not a constant: a backend on the
 * primary's own machine is reached over loopback, but one on a follower has to
 * accept the proxy's connection across the LAN, so binding it to 127.0.0.1
 * would make it unreachable no matter what velocity.toml says.
 */
function serverPropertiesTemplate(
	port: number,
	settings: Record<string, string>,
	bindAddress: string,
): string {
	const values: Record<string, string> = {};

	for (const spec of SERVER_SETTINGS) {
		values[spec.key] = spec.managed ? spec.fallback : (settings[spec.key] ?? spec.fallback);
	}

	values["server-ip"] = bindAddress;
	values["server-port"] = String(port);
	values["enable-query"] = "false";

	const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);

	return `#Minecraft server properties (generated by luna)\n${lines.join("\n")}\n`;
}

/** Paper's velocity modern-forwarding block, keyed with the proxy's shared secret. */
function paperGlobalTemplate(secret: string): string {
	return `# Generated by luna. Paper merges in remaining defaults on first boot.
proxies:
  velocity:
    enabled: true
    online-mode: false
    secret: "${secret}"
`;
}

/** Pumpkin's whole config file; it is one document rather than paper's several. */
const PUMPKIN_CONFIG = "pumpkin.toml";

/**
 * Pumpkin's bind address, forwarding block and the listeners luna turns off.
 * Every field it reads is `serde(default)`, so a partial document is legitimate
 * and the server fills in the rest on first boot, exactly as paper does with
 * `paper-global.yml`.
 *
 * Online mode and encryption are off together on purpose: behind a proxy the
 * player is already authenticated, and pumpkin refuses to start with encryption
 * on and online mode off.
 *
 * The three side listeners are off for the reason `enable-query=false` is
 * forced into every server.properties: each defaults to a *fixed* port of its
 * own (query 25565, bedrock 19132, LAN broadcast), which no port pool allocated
 * and which the second instance on a machine cannot bind. Pumpkin does not
 * survive that; it panics on the collision and takes the server down with it.
 */
function pumpkinConfigTemplate(port: number, bindAddress: string, secret: string): string {
	return `# Generated by luna. Pumpkin merges in remaining defaults on first boot.
[networking.java]
address = "${bindAddress}:${port}"
online_mode = false
encryption = false

[networking.query]
enabled = false

[networking.bedrock]
enabled = false

[networking.lan_broadcast]
enabled = false

[networking.proxy]
enabled = true

[networking.proxy.velocity]
enabled = true
secret = "${secret}"
`;
}

export interface CreateOptions {
	/** Server software to provision; absent = paper */
	software?: Software;
	/** Minecraft version; absent = the newest release the software publishes */
	mcVersion?: string;
	/** Loader build to pin, for software that has one beside the MC version */
	loaderVersion?: string;
	port?: number;
	memory?: string;
	profile?: string;
	register?: boolean;
	/** server.properties values to write instead of the schema defaults */
	settings?: Record<string, string>;
	/** extra JVM flags for the generated run script */
	javaArgs?: string[];
	/** java agents to attach, `<jar>` or `addon:<key>`, optionally `=<options>` */
	javaAgents?: string[];
	/** managed java runtime id; installed on the owning machine at first start */
	runtime?: string;
	/** relaunch after an unexpected exit; absent = on */
	autoRestart?: boolean;
	/** seconds before relaunching after a crash; absent = the default */
	restartDelay?: number;
	/** addon groups beside "default" (which always applies) */
	addonGroups?: string[];
	/** per-instance plugin overrides (plugin name → force-add/disable) */
	pluginOverrides?: Record<string, boolean>;
	/** daemon that will own the instance (absent = the primary's host) */
	daemon?: string;
	/**
	 * Staging token of an uploaded world zip to provision the instance onto.
	 *
	 * A token rather than the bytes: options cross the daemon socket as JSON, and
	 * a world is gigabytes. The file is already on disk under `<root>/.staging`,
	 * and on a follower-owned instance that daemon pulls its own copy first.
	 */
	worldStage?: string;
	/** level name for an uploaded world; absent uses the instance's own */
	worldLevel?: string;
	/** live progress for the caller's renderer */
	reporter?: ProgressReporter;
}

export interface CreateResult {
	name: string;
	dir: string;
	port: number;
	build: SoftwareBuild;
}

/**
 * Lay down a new backend: directory skeleton, the software's newest build for
 * the given MC version, EULA, server.properties on a free port, and whatever
 * proxy forwarding that software needs. Mutates cfg with the new registry entry
 * (caller saves).
 *
 * Everything the caller passes is validated before the first byte is written, so
 * a rejected setting or JVM flag can never leave a half-built instance directory
 * behind.
 */
export async function createInstance(
	cfg: ClusterConfig,
	name: string,
	opts: CreateOptions,
): Promise<CreateResult> {
	// a detached reporter when the caller does not want progress, so the reporting
	// calls below need no branches
	const progress = opts.reporter ?? new ProgressReporter(`create ${name}`);
	const software = opts.software ?? "paper";
	const traits = traitsOf(software);

	const checks = progress.child("Validate request", 1);
	const fetching = progress.child(t("core.admin.phaseInstallServer", { software }), 6);
	const writing = progress.child("Write instance files", 2);
	// weighted heavily and created unconditionally: an uploaded world is usually
	// the largest thing in the operation, and the progress mirror pairs trees by
	// position, so a node that only sometimes exists shifts everything after it
	const world = progress.child(t("core.admin.phaseWorld"), 6);

	// this node's work is entirely its children's, so it contributes none of its own
	progress.weighOwn(0);

	const machine = opts.daemon ?? PRIMARY_MACHINE;
	let port = 0;

	// An uploaded world is laid out under its target level name, and the server
	// only loads what `level-name` points at; folding the name into the settings
	// writes the two as one fact. Without this the archive lands under its level
	// while server.properties keeps "world", and the first boot generates a
	// fresh world beside the import instead of loading it.
	if (opts.worldStage && opts.worldLevel?.trim()) {
		opts = {
			...opts,
			settings: { ...(opts.settings ?? {}), "level-name": opts.worldLevel.trim() },
		};
	}

	await checks.task({ start: `checking ${name}` }, async (step) => {
		if (managedInstances(cfg)[name] || cfg.instances[name]) {
			throw new Error(t("core.admin.alreadyExists", { name }));
		}

		if (!/^[a-z0-9_-]+$/.test(name)) {
			throw new Error(t("core.admin.badName"));
		}

		if (!hasProvider(software)) {
			throw new Error(t("core.services.software.noProvider", { software }));
		}

		// a server with no JVM has nothing to point a runtime, a profile or a flag
		// at, so asking is a mistake worth naming rather than silently ignoring
		if (!traits.usesJava && (opts.runtime || opts.javaArgs?.length)) {
			throw new Error(t("core.admin.softwareHasNoJava", { software }));
		}

		if (existsSync(join(root(), name))) {
			throw new Error(t("core.admin.dirExists", { dir: join(root(), name) }));
		}

		const badSettings = validateSettings(opts.settings ?? {});

		if (badSettings.length) {
			throw new Error(badSettings.map((problem) => problem.error).join("; "));
		}

		const badArgs = validateJavaArgs(opts.javaArgs ?? []);

		if (badArgs) {
			throw new Error(badArgs);
		}

		const badAgents = validateJavaAgents(opts.javaAgents ?? []);

		if (badAgents) {
			throw new Error(badAgents);
		}

		if (opts.restartDelay !== undefined) {
			const badDelay = validateRestartDelay(opts.restartDelay);

			if (badDelay) {
				throw new Error(badDelay);
			}
		}

		if (opts.runtime) {
			const badRuntime = validateRuntimeId(opts.runtime);

			if (badRuntime) {
				throw new Error(badRuntime);
			}
		}

		// The port is taken here, before the first byte is written: a provision runs
		// for as long as a server jar takes to download, and a second one started in
		// that window must not be handed the same number. The reservation is dropped
		// once the registry records it (or when this fails, below).
		if (opts.port === undefined) {
			port = acquirePort(cfg, {
				machine: opts.daemon,
				pool: GAME_POOL,
				protocol: "tcp",
				reserve: true,
			}).port;

			step.info(0.8, t("core.admin.portAcquired", { port, machine: machineLabel(machine) }));

			return;
		}

		const check = checkPort(cfg, opts.port, { machine: opts.daemon });

		if (!check.ok) {
			throw new Error(check.error);
		}

		port = opts.port;
		reservePort(machine, port);

		if (check.warning) {
			step.warn(0.8, check.warning);
		}
	});

	const dir = join(root(), name);

	try {
		return await buildInstance(cfg, name, opts, { dir, port, fetching, writing, world });
	} catch (err) {
		// nothing landed in the registry, so the number goes straight back to its pool
		releaseReservation(machine, port);

		throw err;
	}
}

/**
 * The half of `createInstance` that writes: the server build, the instance
 * files and the registry entry. Split out so the port acquired before it can be
 * released again when any of it fails.
 */
async function buildInstance(
	cfg: ClusterConfig,
	name: string,
	opts: CreateOptions,
	ctx: {
		dir: string;
		port: number;
		fetching: ProgressReporter;
		writing: ProgressReporter;
		world: ProgressReporter;
	},
): Promise<CreateResult> {
	const { dir, port, fetching, writing, world } = ctx;
	const software = opts.software ?? "paper";

	const build = await resolveBuild(software, {
		...(opts.mcVersion ? { mcVersion: opts.mcVersion } : {}),
		...(opts.loaderVersion ? { loaderVersion: opts.loaderVersion } : {}),
		// this runs on the daemon that will own the instance, so its own platform
		// is the one a native build has to match
		platform: buildPlatform(),
	});

	// after the build resolves, not before: forge's launch traits depend on the
	// era the resolved MC version belongs to
	const traits = traitsOf(software, build.mcVersion);

	// the registry entry is assembled before the install, because an installer
	// build needs the java this instance resolves in order to run at all
	const inst: InstanceConfig = {
		dir: name,
		software,
		port,
		// validated here rather than trusted: create used to accept any string at
		// all, so "5 gigs" reached the registry and only failed at the JVM
		memory: opts.memory ? assertMemoryValue(opts.memory) : MEMORY_FALLBACK,
		profile: opts.profile ?? "aikar",
		proxy: { register: opts.register ?? true },
	};

	if (build.mcVersion) {
		inst.mcVersion = build.mcVersion;
	}

	if (build.loaderVersion) {
		inst.loaderVersion = build.loaderVersion;
	}

	recordBuildId(inst, build);

	if (opts.javaArgs?.length) {
		inst.javaArgs = opts.javaArgs;
	}

	if (opts.javaAgents?.length) {
		inst.javaAgents = opts.javaAgents;
	}

	if (opts.runtime) {
		inst.runtime = opts.runtime;
	}

	if (opts.autoRestart === false) {
		inst.autoRestart = false;
	}

	// absent means the default, so only a departure from it is worth recording
	if (opts.restartDelay !== undefined && opts.restartDelay !== DEFAULT_RESTART_DELAY) {
		inst.restartDelay = opts.restartDelay;
	}

	if (opts.addonGroups?.length) {
		inst.addonGroups = opts.addonGroups.filter((group) => group !== "default");
	}

	if (opts.pluginOverrides && Object.keys(opts.pluginOverrides).length) {
		inst.pluginOverrides = opts.pluginOverrides;
	}

	if (opts.daemon) {
		inst.daemon = opts.daemon;
	}

	// the instance directory in its own right: software with no addon directory
	// at all (a server with no plugin ecosystem) would otherwise have nothing
	// create it before the download lands
	await mkdir(dir, { recursive: true });

	for (const addonDir of traits.addonDirs) {
		await mkdir(join(dir, addonDir), { recursive: true });
	}

	if (traits.forwarding === "paper-global" || traits.forwardingMod) {
		await mkdir(join(dir, "config"), { recursive: true });
	}

	// Before anything is launched, and before an installer build needs a java of
	// its own: the game version's floor rose four times, most recently to 25 for
	// the 26.x line, and the machine's own java is whatever the image happened to
	// ship. A caller that named a runtime is left with it.
	if (traits.usesJava && !opts.runtime) {
		// the outcome is reported on the step's own node, not the parent's: the
		// parent's message is overwritten by whatever it reports next, and this is
		// exactly the line an operator needs to still be able to read afterwards
		const step = fetching.child(t("core.admin.javaFloorStep"), 2);
		const floor = await ensureJavaFloor(cfg, inst, step, build.javaMinimum);

		if (floor.outcome === "pinned") {
			step.complete(t("core.admin.javaPinned", { runtime: floor.id!, feature: floor.needed }));
		} else if (floor.outcome === "unavailable") {
			step.warn(1, t("core.admin.javaFloorUnmet", { feature: floor.needed }));
		}
	}

	fetching.info(0.02, t("core.admin.resolvingBuild", { project: software, version: build.buildId }));

	await installBuild(dir, traits.binaryName ?? build.fileName, build, {
		// an installer needs a JVM whatever the launch shape is: the legacy line runs
		// one too, it just leaves a jar behind instead of an argument file
		...(build.kind === "installer" ? { java: await installerJava(cfg, inst, fetching) } : {}),
		...(traits.argsFile ? { expectArgsFile: traits.argsFile(inst) } : {}),
		...(traits.installedJar ? { expectJar: traits.installedJar } : {}),
		reporter: fetching,
	});

	fetching.complete(t("core.admin.serverInstalled", { software, version: build.buildId }));

	await writing.task(
		{ start: t("core.admin.writingFiles"), done: t("core.admin.filesWritten") },
		async (step) => {
			if (traits.needsEula) {
				await Bun.write(join(dir, "eula.txt"), "eula=true\n");
				step.info(0.3, t("core.admin.eulaAccepted"));
			}

			const bindAddress = opts.daemon ? "0.0.0.0" : "127.0.0.1";

			if (traits.portConfig === "properties") {
				await Bun.write(
					join(dir, "server.properties"),
					serverPropertiesTemplate(port, opts.settings ?? {}, bindAddress),
				);
				step.info(0.6, t("core.admin.propertiesOnPort", { port }));
			}

			const secret = await readForwardingSecret(cfg);

			if (traits.forwarding === "paper-global") {
				await Bun.write(join(dir, "config", "paper-global.yml"), paperGlobalTemplate(secret));
				step.info(0.9, t("core.admin.forwardingKeyed"));
			} else if (traits.forwarding === "pumpkin-toml") {
				await Bun.write(join(dir, PUMPKIN_CONFIG), pumpkinConfigTemplate(port, bindAddress, secret));
				step.info(0.9, t("core.admin.pumpkinConfigWritten"));
			}

			// a mod loader's forwarding is `ensureForwardingMod`'s whole job, config
			// and jar together: writing the config here would leave an instance
			// keyed with the real secret and no mod able to read it, which refuses
			// every proxied login and says nothing about why
		},
	);

	// After the config files, because the world's directory name comes out of
	// `server.properties` and it has only just been written; and before the
	// registry entry below, so an unreadable archive leaves nothing registered.
	// The node is created unconditionally and settled when there is no world to
	// install: the progress mirror pairs the daemon's tree with the client's by
	// position, so a phase that sometimes does not exist misaligns the rest.
	if (opts.worldStage) {
		await importStagedWorld(cfg, name, inst, opts, world);
	} else {
		world.settle();
	}

	cfg.instances[name] = inst;

	return { name, dir, port, build };
}

/**
 * Lay an uploaded world into a freshly provisioned instance.
 *
 * The instance is not in the registry yet, so this cannot go through the normal
 * replace path (which resolves everything from `cfg`). It does the same two
 * things by hand - convert the archive's layout into the target's, then put it
 * where the server will look - minus the swap protocol, which exists to protect
 * an existing world and there is none here.
 */
async function importStagedWorld(
	cfg: ClusterConfig,
	name: string,
	inst: InstanceConfig,
	opts: CreateOptions,
	reporter: ProgressReporter,
): Promise<void> {
	const archive = stagePath(opts.worldStage!);

	if (!existsSync(archive)) {
		throw new Error(t("core.admin.worldStageMissing", { token: opts.worldStage! }));
	}

	await reporter.task(
		{ start: t("core.admin.installingWorld"), done: t("core.admin.worldInstalled") },
		async (step) => {
			const dir = instanceDir(inst);
			const level = opts.worldLevel?.trim() || opts.settings?.["level-name"]?.trim() || "world";
			const scan = await scanWorldArchive(archive);
			const plan = planWorldImport(scan, {
				level,
				layout: layoutOf(inst),
				mcVersion: inst.mcVersion,
			});

			const blocking = plan.findings.filter((finding: WorldFinding) => finding.level === "error");

			if (blocking.length > 0) {
				throw new Error(t("core.admin.worldRefused", { code: blocking[0]!.code }));
			}

			const listing = await listArchive(archive);

			await materializeWorld(dir, archive, plan, listing.fileCount, step);
		},
	);
}

/**
 * Pool the addons an instance's software cannot do without: whatever its
 * ecosystem requires to boot at all, plus the forwarding mod that lets it sit
 * behind the proxy.
 *
 * Two different needs, one pass, because they fail the same way and at the same
 * moment. A mod loader has no native support for velocity's modern forwarding,
 * so without that mod the backend refuses every proxied login; and a loader that
 * ships no game API of its own cannot resolve *any* of the mods luna installs -
 * its own core included - so without that one the server will not start. Neither
 * is a state worth handing an operator who asked for a working instance.
 *
 * Idempotent, and a no-op for a software that needs neither. The jars land in
 * the pool targeted at this instance; the caller's deploy pass is what copies
 * them in, exactly as for any other addon.
 */
export async function ensureForwardingMod(
	cfg: ClusterConfig,
	lock: PluginsLock,
	name: string,
	reporter?: ProgressReporter,
): Promise<{ installed: boolean; slug?: string; required: string[]; configOnly?: boolean }> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const traits = traitsOf(inst.software, inst.mcVersion);
	const mod = traits.forwardingMod;
	const family = familyForDir(inst.software, "mods");
	const required: string[] = [];

	// these come first: they are what the forwarding mod itself depends on
	for (const addon of traits.requiredAddons ?? []) {
		if (await poolAddonFor(cfg, lock, name, family, addon.provider, addon.slug)) {
			required.push(addon.slug);
		}
	}

	// a standalone instance gets neither the mod nor its config: nothing is
	// forwarding to it, and a config keyed with the cluster secret is not
	// something to leave lying in a directory that never needed it
	if (!mod || !inst.proxy?.register) {
		reporter?.settle();

		return { installed: false, required };
	}

	// the config is written every time: an instance that already has the mod
	// pooled may still be missing it, and it is what carries the secret
	await mkdir(join(instanceDir(inst), "config"), { recursive: true });
	await Bun.write(join(instanceDir(inst), mod.configFile), mod.config(await readForwardingSecret(cfg)));

	// legacy forge: the file above is all luna can deliver (the mod itself needs
	// a patched proxy on this line), and it is what luna-core reads the heartbeat
	// secret from - so the write happens, the install does not
	if (mod.configOnly) {
		reporter?.settle();

		return { installed: false, slug: mod.slug, required, configOnly: true };
	}

	reporter?.info(0.2, t("core.admin.installingForwardingMod", { mod: mod.slug }));

	const installed = await poolAddonFor(cfg, lock, name, family, mod.provider, mod.slug);

	reporter?.complete(
		t(installed ? "core.admin.forwardingModInstalled" : "core.admin.forwardingModPooled", { mod: mod.slug }),
	);

	return { installed, slug: mod.slug, required };
}

/**
 * Make one provider addon available to an instance, and say whether that meant
 * downloading it. An entry already in the lockfile is only given this instance
 * as another target: the jar is shared by every instance of the ecosystem, so
 * pooling it a second time would be a second copy of the same file.
 */
async function poolAddonFor(
	cfg: ClusterConfig,
	lock: PluginsLock,
	name: string,
	family: Exclude<PluginFamily, "universal">,
	provider: ProviderId,
	slug: string,
): Promise<boolean> {
	const existing = lock.plugins[`${slug}@${family}`];

	if (existing) {
		if (!existing.targets.includes(name)) {
			existing.targets.push(name);
		}

		return false;
	}

	const project = await getProject(provider, slug, projectTypeFor(family));

	if (!project) {
		throw new Error(t("core.admin.forwardingModMissing", { mod: slug }));
	}

	await installFromProvider(cfg, lock, provider, project, family, [name]);

	return true;
}

/**
 * The java a loader installer runs under, installing the managed runtime first
 * when the instance resolves one. The installer is a normal JVM program, so it
 * needs the same java the server will; asking the operator to have one already
 * would make a first provision on a fresh machine fail for no good reason.
 */
async function installerJava(
	cfg: ClusterConfig,
	inst: InstanceConfig,
	reporter: ProgressReporter,
): Promise<string> {
	const selection = javaSelection(cfg, inst);

	if (selection.kind === "runtime") {
		await ensureRuntime(selection.id, { reporter: reporter.child(t("core.runtimes.phaseDownload"), 3) });
	}

	return resolveJavaPath(cfg, inst);
}

export interface SetVersionResult {
	from?: string;
	to: string;
	build: SoftwareBuild;
	/** The previous binary, kept beside the new one; absent for a loader install */
	backedUpJar?: string;
}

/** Which build to move an instance onto; absent fields mean "newest". */
export interface SetVersionOptions {
	mcVersion?: string;
	loaderVersion?: string;
}

/**
 * Swap an instance onto another version of its own software.
 *
 * A single-file server (a jar, or pumpkin's executable) keeps its previous
 * binary as `.old` and is rolled back to it when the download fails. A loader
 * that installs itself has no single file to swap: its installer writes a new
 * library tree beside the old one, so the version an instance runs is decided
 * by the registry, and rolling back means leaving the registry as it was. The
 * superseded tree is left on disk, because it is what a rollback would need.
 *
 * Mutates cfg (caller saves).
 */
export async function setVersion(
	cfg: ClusterConfig,
	name: string,
	opts: SetVersionOptions,
	reporter?: ProgressReporter,
): Promise<SetVersionResult> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const progress = reporter ?? new ProgressReporter(`set-version ${name}`);

	progress.info(0.05, t("core.admin.resolvingBuild", {
		project: inst.software,
		version: opts.mcVersion ?? opts.loaderVersion ?? "latest",
	}));

	const build = await resolveBuild(inst.software, {
		...(opts.mcVersion ? { mcVersion: opts.mcVersion } : {}),
		...(opts.loaderVersion ? { loaderVersion: opts.loaderVersion } : {}),
		platform: buildPlatform(),
	});

	const dir = instanceDir(inst);
	const from = inst.mcVersion;

	// the *target* version's traits, not the current one's: a forge move across
	// the 1.13 boundary changes the launch shape, and the branch below has to
	// follow the era the instance is moving to
	const traits = traitsOf(inst.software, build.mcVersion ?? inst.mcVersion);

	if (traits.kind === "argsfile") {
		// the loader version is what decides which library tree boots, so the
		// registry only moves once the installer has actually written one
		const target: InstanceConfig = { ...inst, mcVersion: build.mcVersion, loaderVersion: build.loaderVersion };

		await installBuild(dir, build.fileName, build, {
			java: await installerJava(cfg, target, progress),
			expectArgsFile: traits.argsFile!(target),
			reporter: progress,
		});

		inst.mcVersion = build.mcVersion;
		inst.loaderVersion = build.loaderVersion;

		recordBuildId(inst, build);

		progress.complete(`${from ?? "?"} → ${build.mcVersion} (${build.loaderVersion})`);

		return { from, to: build.mcVersion ?? build.buildId, build };
	}

	const binary = join(dir, traits.binaryName ?? build.fileName);
	const backup = binary + ".old";

	if (existsSync(binary)) {
		await rm(backup, { force: true });
		await rename(binary, backup);
	}

	try {
		// java for the installer resolves against the target version, so a move
		// onto the legacy line runs its installer under the java 8 it needs
		const target: InstanceConfig = { ...inst, mcVersion: build.mcVersion, loaderVersion: build.loaderVersion };

		await installBuild(dir, traits.binaryName ?? build.fileName, build, {
			// the legacy loaders reach here too: a jar-kind launch whose build is
			// still an installer, which needs a JVM and leaves a versioned jar to
			// rename over the one just backed up
			...(build.kind === "installer" ? { java: await installerJava(cfg, target, progress) } : {}),
			...(traits.installedJar ? { expectJar: traits.installedJar } : {}),
			reporter: progress,
		});
	} catch (err) {
		progress.error(progress.progress, t("core.admin.downloadRolledBack"));

		if (existsSync(backup)) {
			await rename(backup, binary);
		}

		throw err;
	}

	inst.mcVersion = build.mcVersion;

	if (build.loaderVersion) {
		inst.loaderVersion = build.loaderVersion;
	}

	recordBuildId(inst, build);

	// a version bump can cross a java floor (1.20.5 and 26.1 both raised one, and
	// velocity 4 raised its own without any MC release moving), and an instance
	// that was fine a moment ago would then refuse to boot
	if (traits.usesJava && !inst.runtime) {
		const step = progress.child(t("core.admin.javaFloorStep"), 1);
		const floor = await ensureJavaFloor(cfg, inst, step, build.javaMinimum);

		if (floor.outcome === "pinned") {
			step.complete(t("core.admin.javaPinned", { runtime: floor.id!, feature: floor.needed }));
		} else if (floor.outcome === "unavailable") {
			step.warn(1, t("core.admin.javaFloorUnmet", { feature: floor.needed }));
		}
	}

	progress.complete(`${from ?? "?"} → ${build.mcVersion} (build ${build.buildId})`);

	return { from, to: build.mcVersion ?? build.buildId, build, backedUpJar: backup };
}

/**
 * The instance fields a caller may change after creation. An explicit `null`
 * clears one, which is not the same as leaving it out: omitted means "leave it
 * alone", null means "go back to whatever the profile or the machine decides".
 */
export interface InstanceOptionUpdate {
	memory?: string;
	profile?: string;
	runtime?: string | null;
	java?: string | null;
	javaArgs?: string[];
	javaAgents?: string[];
	autoRestart?: boolean;
	restartDelay?: number;
}

/**
 * Change an instance's own settings: the ones in the registry rather than in
 * `server.properties`.
 *
 * Everything is validated before anything is written, so a rejected field cannot
 * leave the instance half-updated. Nothing here touches disk - these reach the
 * server through the run script, which is regenerated on the next start - so the
 * caller saves the cluster config and says so.
 *
 * Returns the names of the fields that actually changed value, which is what a
 * caller reports; a field set to what it already held is not one of them.
 */
export function applyInstanceOptions(
	cfg: ClusterConfig,
	name: string,
	update: InstanceOptionUpdate,
): { changed: string[] } {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const traits = traitsOf(inst.software, inst.mcVersion);

	// same rule create applies: a server with no JVM has nothing to point these at
	const wantsJava =
		update.runtime || update.java || update.javaArgs?.length || update.javaAgents?.length;

	if (!traits.usesJava && wantsJava) {
		throw new Error(t("core.admin.softwareHasNoJava", { software: inst.software }));
	}

	if (update.memory !== undefined) {
		assertMemoryValue(update.memory);
	}

	if (update.profile !== undefined && !cfg.javaProfiles[update.profile]) {
		throw new Error(t("core.instances.unknownProfile", { name: update.profile }));
	}

	if (update.runtime) {
		const problem = validateRuntimeId(update.runtime);

		if (problem) {
			throw new Error(problem);
		}
	}

	if (update.java) {
		if (!isAbsolute(update.java)) {
			throw new Error(t("core.admin.javaPathNotAbsolute", { path: update.java }));
		}
	}

	if (update.javaArgs) {
		const problem = validateJavaArgs(update.javaArgs);

		if (problem) {
			throw new Error(problem);
		}
	}

	if (update.javaAgents) {
		const problem = validateJavaAgents(update.javaAgents);

		if (problem) {
			throw new Error(problem);
		}
	}

	if (update.restartDelay !== undefined) {
		const problem = validateRestartDelay(update.restartDelay);

		if (problem) {
			throw new Error(problem);
		}
	}

	const changed: string[] = [];

	const set = <K extends keyof InstanceConfig>(key: K, value: InstanceConfig[K]): void => {
		if (inst[key] === value) {
			return;
		}

		if (value === undefined) {
			delete inst[key];
		} else {
			inst[key] = value;
		}

		changed.push(key);
	};

	if (update.memory !== undefined) {
		set("memory", assertMemoryValue(update.memory));
	}

	if (update.profile !== undefined) {
		set("profile", update.profile);
	}

	if (update.runtime !== undefined) {
		set("runtime", update.runtime || undefined);
	}

	if (update.java !== undefined) {
		set("java", update.java || undefined);
	}

	if (update.autoRestart !== undefined) {
		// stored only when it departs from the default, so an untouched instance
		// keeps the registry entry it has always had
		set("autoRestart", update.autoRestart ? undefined : false);
	}

	if (update.restartDelay !== undefined) {
		set("restartDelay", update.restartDelay === DEFAULT_RESTART_DELAY ? undefined : update.restartDelay);
	}

	if (update.javaArgs) {
		const before = inst.javaArgs?.join(" ") ?? "";

		setJavaArgs(cfg, name, update.javaArgs);

		if ((inst.javaArgs?.join(" ") ?? "") !== before) {
			changed.push("javaArgs");
		}
	}

	if (update.javaAgents) {
		const before = inst.javaAgents?.join(" ") ?? "";

		setJavaAgents(cfg, name, update.javaAgents);

		if ((inst.javaAgents?.join(" ") ?? "") !== before) {
			changed.push("javaAgents");
		}
	}

	return { changed };
}

/**
 * Replace an instance's custom JVM flags. Registry only; the flags reach the
 * server through the run script, which is regenerated on every start.
 */
export function setJavaArgs(cfg: ClusterConfig, name: string, args: string[]): void {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const problem = validateJavaArgs(args);

	if (problem) {
		throw new Error(problem);
	}

	if (args.length) {
		inst.javaArgs = args;
	} else {
		delete inst.javaArgs;
	}
}

/**
 * Replace an instance's java agents. Registry only, like the flags beside them.
 *
 * The jars are not checked for here: an agent is routinely attached before the
 * jar is put in place, and refusing that would make the order of two unrelated
 * steps matter. `writeRunScript` is where a missing jar is caught, which is the
 * last moment it can still be reported instead of aborting the JVM.
 */
export function setJavaAgents(cfg: ClusterConfig, name: string, agents: string[]): void {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const problem = validateJavaAgents(agents);

	if (problem) {
		throw new Error(problem);
	}

	if (agents.length) {
		inst.javaAgents = agents;
	} else {
		delete inst.javaAgents;
	}
}

/**
 * Change an instance's game port (server.properties + registry; caller runs proxy
 * sync). The number is checked against its own machine's allocations first; a
 * port moved onto one another instance on that host already binds would take both
 * servers down, and nothing else in the pipeline would notice.
 */
export async function setPort(cfg: ClusterConfig, name: string, port: number): Promise<void> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const check = checkPort(cfg, port, { machine: inst.daemon, instance: name });

	if (!check.ok) {
		throw new Error(check.error);
	}

	// velocity's port lives in velocity.toml, which proxy sync owns; a backend
	// keeps it wherever its own config puts it
	const portConfig = traitsOf(inst.software, inst.mcVersion).portConfig;

	if (portConfig === "properties") {
		const props = join(instanceDir(inst), "server.properties");

		if (!(await setConfValue(props, "properties", "server-port", port))) {
			throw new Error(t("core.admin.portUpdateFailed", { file: props }));
		}
	} else if (portConfig === "pumpkin-toml") {
		const conf = join(instanceDir(inst), PUMPKIN_CONFIG);

		// pumpkin binds one composite value rather than a bare port, so the host
		// half of the address it already has is kept and only the port replaced
		const current = await getConfValue(conf, "toml", "address");
		const host = current?.replace(/^"|"$/g, "").split(":")[0] ?? "0.0.0.0";

		if (!(await setConfValue(conf, "toml", "address", `"${host}:${port}"`))) {
			throw new Error(t("core.admin.portUpdateFailed", { file: conf }));
		}
	}

	// an instance provisioned moments ago still has its reservation held, and the
	// number it is moving off would otherwise sit blocked until that expires
	releaseReservation(machineOf(inst), inst.port);

	inst.port = port;
}

/** Read one key from an instance's server.properties. */
export async function getServerProperty(
	cfg: ClusterConfig,
	name: string,
	key: string,
): Promise<string | undefined> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	return await getConfValue(join(instanceDir(inst), "server.properties"), "properties", key);
}

/** Write one key into an instance's server.properties. False when the key is absent. */
export async function setServerProperty(
	cfg: ClusterConfig,
	name: string,
	key: string,
	value: string,
): Promise<boolean> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	return await setConfValue(
		join(instanceDir(inst), "server.properties"),
		"properties",
		key,
		value,
	);
}

/**
 * Drop an instance from the registry, optionally deleting its directory too.
 * External instances are never purged; their files live on another machine.
 * A purge deletes the directory entry by entry so the reporter can say which
 * part of a multi-gigabyte world is currently going.
 */
export async function deleteInstance(
	cfg: ClusterConfig,
	name: string,
	purge: boolean,
	reporter?: ProgressReporter,
): Promise<{ purged: boolean; released: number[] }> {
	const progress = reporter ?? new ProgressReporter(`delete ${name}`);
	const inst = cfg.instances[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	// dropping the entry *is* the release: what a pool has free is derived from the
	// registry, so every number this instance held is available again from here
	const released = heldPorts(inst);

	progress.info(0.05, t("core.admin.deregistering"));
	delete cfg.instances[name];
	releaseInstancePorts(inst);

	if (released.length) {
		progress.info(
			0.08,
			`released ${released.map((entry) => `${entry.port} (${entry.key})`).join(", ")} on ${machineLabel(machineOf(inst))}`,
		);
	}

	if (purge && !inst.external) {
		const dir = instanceDir(inst);
		let entries: string[] = [];

		try {
			entries = await readdir(dir);
		} catch {
			// the directory is already gone; nothing left to purge
		}

		for (let i = 0; i < entries.length; i++) {
			progress.info(0.1 + (i / Math.max(1, entries.length)) * 0.85, t("core.admin.deleting", { name: entries[i] ?? "" }));

			await rm(join(dir, entries[i]!), { recursive: true, force: true });
		}

		await rm(dir, { recursive: true, force: true });
	}

	// the templates and env overrides described an instance that no longer exists;
	// leaving them would resurrect themselves onto the next instance of that name
	const forgotten = await forgetInstance(name);

	if (forgotten) {
		progress.info(0.97, t("core.admin.droppedConfigs", { count: forgotten }));
	}

	// same reasoning for the lockfile, plus one of its own: a target list holding a
	// name the registry no longer knows fails validation on the next `plugins
	// apply`, which is the only verb that could have taken it back out
	const lock = await loadLock();
	const untargeted = forgetInstancePlugins(lock, name);

	if (untargeted) {
		await saveLock(lock);
		progress.info(0.98, t("core.admin.droppedPluginTargets", { count: untargeted }));
	}

	const env = await loadEnv();

	if (unsetInstanceScope(env, name)) {
		await saveEnv(env);
	}

	progress.complete(
		purge && !inst.external ? t("core.admin.dirDeleted") : t("core.admin.deregisteredKept"),
	);

	return { purged: purge, released: released.map((entry) => entry.port) };
}
