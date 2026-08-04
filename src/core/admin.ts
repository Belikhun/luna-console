import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { ClusterConfig, InstanceConfig, Software } from "./types";
import { addonDirOf, instanceDir, managedInstances, root } from "./config";
import * as papermc from "./services/papermc";
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
import { ProgressReporter } from "./progress";
import { SERVER_SETTINGS, validateJavaArgs, validateSettings } from "./settings";

/** Parse "1.21.11-127-bd74bf6 (MC: 1.21.11)" from version_history.json. */
export async function detectMcVersion(dir: string): Promise<string | undefined> {
	const path = join(dir, "version_history.json");

	if (!existsSync(path)) {
		return undefined;
	}

	try {
		const data = await Bun.file(path).json();
		const version = String(data.currentVersion ?? "").match(/MC:\s*([\d.]+)/);

		return version?.[1];
	} catch {
		return undefined;
	}
}

/** Directory the neoforge installer writes its per-build launch files into. */
const NEOFORGE_LIBRARIES = join("libraries", "net", "neoforged", "neoforge");

/** What an existing server directory says about itself. */
export interface InstanceDetection {
	software: Software;
	mcVersion?: string;
	/** neoforge only — the installed loader build */
	loaderVersion?: string;
	/** server.properties `server-port`, when the file has one */
	port?: number;
	/** `-Xmx` found in the launcher the directory already ships with */
	memory?: string;
	/** server.properties `server-ip`, when the file has one */
	bindAddress?: string;
}

/** Newest neoforge build installed under `libraries/`, by directory name. */
async function detectNeoForgeVersion(dir: string): Promise<string | undefined> {
	const libraries = join(dir, NEOFORGE_LIBRARIES);

	if (!existsSync(libraries)) {
		return undefined;
	}

	const builds: string[] = [];

	for (const entry of await readdir(libraries, { withFileTypes: true })) {
		if (entry.isDirectory() && existsSync(join(libraries, entry.name, "unix_args.txt"))) {
			builds.push(entry.name);
		}
	}

	// numeric-aware so 21.1.9 sorts before 21.1.233
	builds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

	return builds.at(-1);
}

/**
 * The MC version a neoforge pack targets. The launcher script records it in
 * `.previousrun` after a successful boot; a pack that has never run only has
 * the installer's `--fml.mcVersion` in its argument file.
 */
async function detectNeoForgeMcVersion(dir: string, loaderVersion: string): Promise<string | undefined> {
	const previous = join(dir, ".previousrun");

	if (existsSync(previous)) {
		const text = await Bun.file(previous).text();
		const match = text.match(/^PREVIOUS_MINECRAFT_VERSION=(.+)$/m);

		if (match?.[1]) {
			return match[1].trim();
		}
	}

	const args = join(dir, NEOFORGE_LIBRARIES, loaderVersion, "unix_args.txt");

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
 * to luna's default — neoforge keeps it in `user_jvm_args.txt`, everything else
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
 * it. NeoForge is recognised by the installer's `libraries/` tree, velocity by
 * its jar, and everything else is assumed to be paper — which is what
 * `version_history.json` then confirms with an MC version.
 *
 * A relative path is resolved against this daemon's cluster root, so callers
 * can pass the plain directory name an instance would be registered under.
 */
export async function inspectInstanceDir(path: string): Promise<InstanceDetection> {
	const dir = isAbsolute(path) ? path : join(root(), path);

	if (!existsSync(dir)) {
		throw new Error(`directory does not exist: ${dir}`);
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

	const loaderVersion = await detectNeoForgeVersion(dir);

	if (loaderVersion) {
		detection.software = "neoforge";
		detection.loaderVersion = loaderVersion;

		const mcVersion = await detectNeoForgeMcVersion(dir, loaderVersion);

		if (mcVersion) {
			detection.mcVersion = mcVersion;
		}

		return detection;
	}

	if (existsSync(join(dir, "velocity.jar"))) {
		detection.software = "velocity";

		return detection;
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
	/** pin a java binary — a modpack often needs an older JDK than the host default */
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
 * the lockfile — the directory is already configured and working, and rewriting
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
		throw new Error("instance name must be lowercase alphanumeric/-/_");
	}

	if (name === "proxy") {
		throw new Error("the proxy is registered by `luna setup`, not adopted");
	}

	const existing = cfg.instances[name];

	// an external entry is a placeholder for exactly this server, so adopting it
	// is an upgrade of that registration rather than a conflict
	if (existing && !existing.external) {
		throw new Error(`instance "${name}" is already managed`);
	}

	const dirName = opts.dir ?? existing?.dir ?? name;
	const dir = join(root(), dirName);

	if (!existsSync(dir)) {
		throw new Error(
			`${dir} does not exist — adopt runs on the daemon that owns the instance, ` +
				"so the path is resolved against that machine's cluster root",
		);
	}

	const badArgs = validateJavaArgs(opts.javaArgs ?? []);

	if (badArgs) {
		throw new Error(badArgs);
	}

	const detected = await inspectInstanceDir(dir);
	const port = opts.port ?? detected.port ?? existing?.port;

	if (!port) {
		throw new Error(`could not determine a port for ${name} — pass one explicitly`);
	}

	// A port is only taken on the machine that binds it: the proxy holds 25565 on
	// the primary, which says nothing about a follower's own 25565.
	const check = checkPort(cfg, port, { machine: opts.daemon, instance: name });

	if (!check.ok) {
		throw new Error(check.error);
	}

	const notes: string[] = [];

	// adopt takes the port the directory already binds, so a number outside the
	// machine's pools is reported rather than moved — the server is running on it
	if (check.warning) {
		notes.push(check.warning);
	}

	const memory = opts.memory ?? detected.memory;

	if (!memory) {
		notes.push("no -Xmx found in the directory's launcher — defaulting to 2G");
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
	// unreachable no matter what velocity.toml says. Reported, not corrected —
	// server.properties belongs to the server, and adopt does not rewrite it.
	if (inst.proxy!.register) {
		const wanted = opts.daemon ? "0.0.0.0" : "127.0.0.1";
		const bind = detected.bindAddress;

		if (bind !== undefined && bind !== "" && bind !== wanted) {
			notes.push(`server-ip is "${bind}" — a proxied backend here wants ${wanted}`);
		}

		if (opts.daemon && bind === "") {
			notes.push('server-ip is empty (all interfaces) — luna would set 0.0.0.0');
		}
	}

	if (detected.port !== undefined && detected.port !== port) {
		notes.push(
			`registered on port ${port} but server.properties says ${detected.port} — ` +
				`run \`luna instance config ${name} port ${port}\` to align them`,
		);
	}

	// what the directory already contains is accounted for separately, by
	// `adoptInstanceAddons` — adopt itself never reads or writes an addon
	notes.push(
		`existing ${addonDirOf(inst.software)}/ stay unmanaged — only addons already in the pool are registered`,
	);

	cfg.instances[name] = inst;

	return { name, dir, detected, inst, notes };
}

/**
 * server.properties for a fresh backend: every setting luna knows about, at the
 * value the caller asked for or at the schema's default. Paper fills in the keys
 * outside that list on first boot. The keys marked `managed` in the schema keep
 * their default whatever was requested — they are what makes velocity forwarding
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
	return `# Generated by luna — paper merges in remaining defaults on first boot.
proxies:
  velocity:
    enabled: true
    online-mode: false
    secret: "${secret}"
`;
}

export interface CreateOptions {
	mcVersion: string;
	port?: number;
	memory?: string;
	profile?: string;
	register?: boolean;
	/** server.properties values to write instead of the schema defaults */
	settings?: Record<string, string>;
	/** extra JVM flags for the generated run script */
	javaArgs?: string[];
	/** addon groups beside "default" (which always applies) */
	addonGroups?: string[];
	/** per-instance plugin overrides (plugin name → force-add/disable) */
	pluginOverrides?: Record<string, boolean>;
	/** daemon that will own the instance (absent = the primary's host) */
	daemon?: string;
	/** live progress for the caller's renderer */
	reporter?: ProgressReporter;
}

export interface CreateResult {
	name: string;
	dir: string;
	port: number;
	build: papermc.BuildInfo;
}

/**
 * Lay down a new Paper backend: directory skeleton, newest build for the given
 * MC version, EULA, server.properties on a free port, and the proxy forwarding
 * config. Mutates cfg with the new registry entry (caller saves).
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

	const checks = progress.child("Validate request", 1);
	const fetching = progress.child("Download paper server", 6);
	const writing = progress.child("Write instance files", 2);

	// this node's work is entirely its children's, so it contributes none of its own
	progress.weighOwn(0);

	const machine = opts.daemon ?? PRIMARY_MACHINE;
	let port = 0;

	await checks.task({ start: `checking ${name}` }, async (step) => {
		if (managedInstances(cfg)[name] || cfg.instances[name]) {
			throw new Error(`instance "${name}" already exists`);
		}

		if (!/^[a-z0-9_-]+$/.test(name)) {
			throw new Error("instance name must be lowercase alphanumeric/-/_");
		}

		if (existsSync(join(root(), name))) {
			throw new Error(`directory ${join(root(), name)} already exists`);
		}

		const badSettings = validateSettings(opts.settings ?? {});

		if (badSettings.length) {
			throw new Error(badSettings.map((problem) => problem.error).join("; "));
		}

		const badArgs = validateJavaArgs(opts.javaArgs ?? []);

		if (badArgs) {
			throw new Error(badArgs);
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

			step.info(0.8, `port ${port} acquired on ${machineLabel(machine)}`);

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
		return await buildInstance(cfg, name, opts, { dir, port, fetching, writing });
	} catch (err) {
		// nothing landed in the registry, so the number goes straight back to its pool
		releaseReservation(machine, port);

		throw err;
	}
}

/**
 * The half of `createInstance` that writes: the paper build, the instance files
 * and the registry entry. Split out so the port acquired before it can be
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
	},
): Promise<CreateResult> {
	const { dir, port, fetching, writing } = ctx;

	const build = await fetching.task(
		{
			start: `resolving newest paper ${opts.mcVersion} build`,
			done: `paper ${opts.mcVersion} downloaded`,
			failed: `could not download paper ${opts.mcVersion}`,
		},
		async (step) => {
			const info = await papermc.latestBuild("paper", opts.mcVersion);

			await mkdir(join(dir, "plugins"), { recursive: true });
			await mkdir(join(dir, "config"), { recursive: true });

			step.info(0.05, `build ${info.build} — starting download`);

			await papermc.downloadBuild(info, join(dir, "server.jar"), (received, total) => {
				const mb = (received / 1024 / 1024).toFixed(1);

				// with no content-length there is nothing to divide by, so the step
				// only reports the byte count and its progress stays where it was
				if (!total) {
					step.info(step.progress, `build ${info.build} — ${mb} MB`);

					return;
				}

				const ratio = received / total;

				step.info(
					0.05 + ratio * 0.95,
					`build ${info.build} — ${mb} / ${(total / 1024 / 1024).toFixed(1)} MB`,
				);
			});

			return info;
		},
	);

	await writing.task(
		{ start: "writing eula, properties and forwarding config", done: "instance files written" },
		async (step) => {
			await Bun.write(join(dir, "eula.txt"), "eula=true\n");
			step.info(0.3, "eula accepted");

			await Bun.write(
				join(dir, "server.properties"),
				serverPropertiesTemplate(port, opts.settings ?? {}, opts.daemon ? "0.0.0.0" : "127.0.0.1"),
			);
			step.info(0.6, `server.properties on port ${port}`);

			const secret = await readForwardingSecret(cfg);

			await Bun.write(join(dir, "config", "paper-global.yml"), paperGlobalTemplate(secret));
			step.info(0.9, "velocity modern forwarding keyed");
		},
	);

	const inst: InstanceConfig = {
		dir: name,
		software: "paper",
		mcVersion: opts.mcVersion,
		port,
		memory: opts.memory ?? "2G",
		profile: opts.profile ?? "aikar",
		proxy: { register: opts.register ?? true },
	};

	if (opts.javaArgs?.length) {
		inst.javaArgs = opts.javaArgs;
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

	cfg.instances[name] = inst;

	return { name, dir, port, build };
}

export interface SetVersionResult {
	from?: string;
	to: string;
	build: papermc.BuildInfo;
	backedUpJar: string;
}

/**
 * Swap an instance onto another Minecraft version, keeping the previous jar as
 * `.old` and rolling back to it if the download fails. Mutates cfg (caller saves).
 */
export async function setVersion(
	cfg: ClusterConfig,
	name: string,
	mcVersion: string,
	reporter?: ProgressReporter,
): Promise<SetVersionResult> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(`unknown instance: ${name}`);
	}

	// PaperMC's Fill API is the only jar source luna has; a mod loader's server
	// is installed by its own installer against a pinned MC version, so moving it
	// is a modpack operation and not something luna can do behind the operator.
	if (inst.software === "neoforge") {
		throw new Error(
			`${name} runs neoforge — reinstall the pack against the target version instead`,
		);
	}

	const progress = reporter ?? new ProgressReporter(`set-version ${name}`);
	const project = inst.software === "velocity" ? "velocity" : "paper";

	progress.info(0.05, `resolving newest ${project} ${mcVersion} build`);

	const build = await papermc.latestBuild(project, mcVersion);
	const jar = join(instanceDir(inst), inst.software === "velocity" ? "velocity.jar" : "server.jar");
	const backup = jar + ".old";

	if (existsSync(jar)) {
		await rm(backup, { force: true });
		await rename(jar, backup);
	}

	try {
		await papermc.downloadBuild(build, jar, (received, total) => {
			const mb = (received / 1024 / 1024).toFixed(1);

			if (!total) {
				progress.info(progress.progress, `build ${build.build} — ${mb} MB`);

				return;
			}

			progress.info(
				0.1 + (received / total) * 0.85,
				`build ${build.build} — ${mb} / ${(total / 1024 / 1024).toFixed(1)} MB`,
			);
		});
	} catch (err) {
		progress.error(progress.progress, "download failed — rolled back to the previous jar");

		if (existsSync(backup)) {
			await rename(backup, jar);
		}

		throw err;
	}

	const from = inst.mcVersion;

	inst.mcVersion = mcVersion;

	progress.complete(`${from ?? "?"} → ${mcVersion} (build ${build.build})`);

	return { from, to: mcVersion, build, backedUpJar: backup };
}

/**
 * Replace an instance's custom JVM flags. Registry only — the flags reach the
 * server through the run script, which is regenerated on every start.
 */
export function setJavaArgs(cfg: ClusterConfig, name: string, args: string[]): void {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(`unknown instance: ${name}`);
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
 * Change an instance's game port (server.properties + registry; caller runs proxy
 * sync). The number is checked against its own machine's allocations first — a
 * port moved onto one another instance on that host already binds would take both
 * servers down, and nothing else in the pipeline would notice.
 */
export async function setPort(cfg: ClusterConfig, name: string, port: number): Promise<void> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(`unknown instance: ${name}`);
	}

	const check = checkPort(cfg, port, { machine: inst.daemon, instance: name });

	if (!check.ok) {
		throw new Error(check.error);
	}

	// velocity's port lives in velocity.toml, which proxy sync owns; every
	// backend — paper or a mod loader — keeps it in server.properties
	if (inst.software !== "velocity") {
		const props = join(instanceDir(inst), "server.properties");

		if (!(await setConfValue(props, "properties", "server-port", port))) {
			throw new Error(`could not update server-port in ${props}`);
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
		throw new Error(`unknown instance: ${name}`);
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
		throw new Error(`unknown instance: ${name}`);
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
 * External instances are never purged — their files live on another machine.
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
		throw new Error(`unknown instance: ${name}`);
	}

	// dropping the entry *is* the release: what a pool has free is derived from the
	// registry, so every number this instance held is available again from here
	const released = heldPorts(inst);

	progress.info(0.05, "deregistering from the cluster");
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
			// the directory is already gone — nothing left to purge
		}

		for (let i = 0; i < entries.length; i++) {
			progress.info(0.1 + (i / Math.max(1, entries.length)) * 0.85, `deleting ${entries[i]}`);

			await rm(join(dir, entries[i]!), { recursive: true, force: true });
		}

		await rm(dir, { recursive: true, force: true });
	}

	progress.complete(
		purge && !inst.external ? "directory deleted" : "deregistered — directory kept",
	);

	return { purged: purge, released: released.map((entry) => entry.port) };
}
