// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import type { AddonDir, InstanceConfig, PluginFamily, Software } from "./types";
import type { SoftwareProviderId } from "./services/software/types";
import { t } from "../shared/i18n";

// Loader facets accepted per ecosystem, in the providers' own vocabulary. A
// paper server loads bukkit/spigot/paper plugins; a mod loader accepts only its
// own artifacts. Packs publish under pseudo-loaders ("minecraft" for resource
// packs, "datapack" for data packs).
export const PAPER_LOADERS = ["paper", "spigot", "bukkit", "folia"];
export const VELOCITY_LOADERS = ["velocity"];
export const NEOFORGE_LOADERS = ["neoforge"];
export const FABRIC_LOADERS = ["fabric"];
export const FORGE_LOADERS = ["forge"];
// no upstream index publishes pumpkin components yet, so nothing resolves
// against this; it exists so the family is complete and in-house builds deploy.
export const PUMPKIN_LOADERS = ["pumpkin"];
export const RESOURCEPACK_LOADERS = ["minecraft"];
export const DATAPACK_LOADERS = ["datapack"];

/**
 * How a server is launched.
 *
 * `jar` runs `java -jar <binary>`; `argsfile` runs `java @<file>`, where the
 * loader's installer already wrote the classpath and the launch target;
 * `native` is an executable luna runs directly, with no JVM anywhere.
 */
export type LaunchKind = "jar" | "argsfile" | "native";

/**
 * How velocity's modern forwarding is configured on a backend that supports it
 * natively: `paper-global` is a config file the server itself reads,
 * `pumpkin-toml` is pumpkin's own configuration file, and `none` is the proxy
 * itself, which forwards rather than being forwarded to.
 *
 * An ecosystem with no native support says so by carrying a `forwardingMod`
 * instead; that is one fact, so it is stored once rather than as a kind here
 * that a mod has to agree with.
 */
export type ForwardingKind = "paper-global" | "pumpkin-toml" | "none";

/**
 * How a server derives a player's UUID from their name when authentication is
 * off. Vanilla and everything descended from it hash `OfflinePlayer:<name>`
 * with MD5 into a v3 UUID; pumpkin takes the first 16 bytes of SHA-256 over
 * the bare name, which is a different id for the same player.
 *
 * It only shows in direct connections - behind velocity the proxy supplies the
 * id and every backend agrees - but a whitelist or op entry luna writes to a
 * stopped server is written from this, so guessing wrong writes an entry the
 * server will never match.
 */
export type OfflineIdentity = "vanilla" | "pumpkin";

/** Which file carries the port an instance binds. */
export type PortConfig = "properties" | "velocity-toml" | "pumpkin-toml";

/**
 * Where a server records the name of its world directory, for the software that
 * has one at all.
 *
 * Everything about a world hangs off this: data packs deploy into
 * `<instance>/<level>/datapacks`, so reading the wrong file puts them in a
 * folder the server never opens, and nothing fails loudly when it happens. The
 * key is not the same on both sides of the JVM boundary, which is exactly why
 * it is a trait rather than a `server.properties` read at the call site.
 */
export interface LevelNameSource {
	/** Config file, relative to the instance directory */
	file: string;
	format: "properties" | "toml";
	key: string;
	/** What the server itself falls back to when the key is absent */
	fallback: string;
}

/** `server.properties`, which every JVM server names its world in. */
const PROPERTIES_LEVEL: LevelNameSource = {
	file: "server.properties",
	format: "properties",
	key: "level-name",
	fallback: "world",
};

/**
 * The shape of a software's console log, for boot-session and addon
 * attribution. Several softwares share one grammar, which is the point: the
 * parser branches on the grammar, never on the software.
 */
export type LogGrammar = "bukkit" | "velocity" | "modlauncher" | "fabric" | "pumpkin" | "generic";

/** An addon the ecosystem cannot run luna's own mods without. */
export interface RequiredAddon {
	provider: "modrinth";
	slug: string;
}

/** A forwarding mod luna installs when the ecosystem has no native support. */
export interface ForwardingMod {
	provider: "modrinth";
	slug: string;
	/** Config file the mod reads, relative to the instance directory */
	configFile: string;
	/** That file's contents, keyed with the proxy's shared secret. The mod owns
	 *  the shape of its own config, so it travels with the mod rather than as a
	 *  branch on its slug somewhere else. */
	config: (secret: string) => string;
}

/** Everything that differs between one server software and another. */
export interface SoftwareTraits {
	/** i18n key of the human label */
	label: string;
	kind: LaunchKind;
	/** Server executable inside the instance directory. Absent for `argsfile`,
	 *  which has no single runnable file. */
	binaryName?: string;
	/** Console command that shuts it down gracefully */
	stopCommand: string;
	/** How "no window" is asked for: paper takes `--nogui`, vanilla-derived and
	 *  modlauncher servers take a bare `nogui` program argument */
	noGui?: "flag" | "bare";
	isProxy: boolean;
	needsEula: boolean;
	/** Whether its addons declare a Minecraft version they support. Derived:
	 *  only a proxy hosts nothing tied to a game version. */
	carriesMcRequirement: boolean;
	/** Whether java profiles, managed runtimes and JVM flags mean anything for
	 *  it. Derived: a native server is not a JVM program. */
	usesJava: boolean;
	/** Directories addons deploy into. The hybrids carry both, and the first is
	 *  the one an unqualified question about "the addon directory" means. */
	addonDirs: AddonDir[];
	/** Plugin families whose builds load here: the compatibility matrix */
	acceptsFamilies: PluginFamily[];
	forwarding: ForwardingKind;
	/** Set when the ecosystem needs luna to install a mod for proxy forwarding */
	forwardingMod?: ForwardingMod;
	/** Addons the server cannot boot without once luna has provisioned it. A
	 *  loader that ships no standard library of its own needs one, and every mod
	 *  luna installs on top - its own core included - hard-depends on it, so an
	 *  instance created without it fails mod resolution before it ever starts. */
	requiredAddons?: RequiredAddon[];
	portConfig: PortConfig;
	/** How it derives a UUID from a name with authentication off */
	offlineIdentity: OfflineIdentity;
	/** Where its world directory is named; absent for a proxy, which has none */
	levelName?: LevelNameSource;
	/** First line of a boot; everything below it is one session */
	bootMarker: RegExp;
	/** The line where the server says it is up. Capture 1 is how long it took,
	 *  with an optional unit suffix; without one it is read as seconds. */
	readyMarker: RegExp;
	logGrammar: LogGrammar;
	/** The line naming one addon as it comes up, for the start-progress tree;
	 *  capture 1 or 2 is its name. Absent when the software says nothing per
	 *  addon, which a progress phase then reports as such rather than inventing. */
	addonLoadMarker?: RegExp;
	/** Whether it announces the vanilla data pack registry as it loads (a new
	 *  pack, then recipe and advancement counts). A server reimplemented from
	 *  scratch logs none of that, and a phase that completes anyway is claiming
	 *  a fact nothing in the log supports. */
	announcesDataPacks: boolean;
	/** Provider serving its builds; absent means luna can only adopt it */
	provider?: SoftwareProviderId;
	/** Its builds are identified by a loader version beside the MC version, so a
	 *  version picker offers two lists rather than one */
	pinsLoaderVersion?: boolean;
	/** Where an `argsfile` loader's installer writes its per-build tree, relative
	 *  to the instance directory. Also what adoption probes for. */
	libraryPath?: string;
	/** Argument file for `argsfile`, relative to the instance directory */
	argsFile?: (inst: InstanceConfig) => string;
	/** Where the daemon drops this instance's own CPU and memory, relative to
	 *  the instance directory, for a server that cannot measure itself.
	 *
	 *  A JVM reads its heap and process load from inside and puts them on its
	 *  heartbeat. Pumpkin's plugins are wasm components with one preopened
	 *  directory and no `/proc`, so the numbers exist only out here. The daemon
	 *  already samples both per instance for the console's own columns; this is
	 *  where it leaves them for the server to pick up. Absent means the server
	 *  reports its own. */
	hostMetricsFile?: string;
	/** Upstream publishes no stable release yet, so the operator is told */
	experimental?: boolean;
}

/**
 * ModLauncher's banner: the true first line of a forge-family run. It has to
 * sit *before* the server says anything about its addons, which rules out
 * "Starting minecraft server version" — the game server only starts once mod
 * construction is finished, so anchoring there would cut the mod roster off
 * the top of the session.
 */
const MODLAUNCHER_BOOT = /ModLauncher running:/;

/**
 * Bukkit announces a plugin twice on the way up: once as it reads the jar, once
 * as it enables it. Both are worth a progress line, so both are matched, and
 * whichever capture fired is the plugin's name.
 */
const BUKKIT_ADDON = /Loading server plugin (\S+)|\[\S+?\] Enabling (\S+)/;

/** Velocity names a plugin once, with its version after it. */
const VELOCITY_ADDON = /Loaded plugin (\S+) /;

/**
 * A mod loader prints no per-mod load line; what it prints is a roster, one mod
 * to a line, each ending in the mod id in brackets. Anchoring at the end is what
 * keeps it off every other line that happens to close on a parenthesis.
 */
const MODLAUNCHER_ADDON = /\(([a-z0-9_-]+)\)$/;

/** Fabric prints its roster as a tree, with the id first rather than last. */
const FABRIC_ADDON = /^\s*(?:[|\\]--|-)\s*([a-z0-9_.-]+)(?:\s+\S+)?$/;

/** Pumpkin prints one line per component, once its on_load has returned. */
const PUMPKIN_ADDON = /Loaded (\S+) \(/;

/** Paper's bootstrap line, or the vanilla server line it is followed by. */
const VANILLA_BOOT = /\[bootstrap\] Running Java|Starting minecraft server version/;

/**
 * Fabric loader's first line, and deliberately only that one.
 *
 * A session starts at the *last* line matching this, so an alternative that also
 * appears later in the same boot silently truncates it - and the vanilla
 * "Starting minecraft server version" line comes after the loader has already
 * printed the mod roster, which is the one part of a fabric log that says what
 * is installed.
 */
const FABRIC_BOOT = /Loading Minecraft [\d.]+ with Fabric Loader/;

/**
 * "Done (12.345s)!" - the line every vanilla-derived server, and velocity,
 * prints once it is accepting connections.
 */
const VANILLA_READY = /Done \(([\d.]+)s\)!/;

// Where each forge flavour's installer writes its per-build launch files,
// relative to the instance directory. The two ecosystems differ only here.
const NEOFORGE_LIBRARIES = "libraries/net/neoforged/neoforge";
const FORGE_LIBRARIES = "libraries/net/minecraftforge/forge";

/** Modern forwarding for the fabric ecosystem. */
const FABRIC_PROXY: ForwardingMod = {
	provider: "modrinth",
	slug: "fabricproxy-lite",
	configFile: "config/FabricProxy-Lite.toml",

	config: (secret) => `# Generated by luna.
hackOnlineMode = true
hackEarlySend = false
hackMessageChain = true
secret = "${secret}"
`,
};

/** Modern forwarding for both forge flavours; the mod serves each. */
const FORGE_PROXY: ForwardingMod = {
	provider: "modrinth",
	slug: "proxy-compatible-forge",
	configFile: "config/pcf-common.toml",

	config: (secret) => `# Generated by luna.
modernForwarding = true
forwardingSecret = "${secret}"
bungeeCordForwarding = false
`,
};

/** Traits shared by every server built on the Paper API. */
const PAPER_LIKE = {
	kind: "jar",
	binaryName: "server.jar",
	stopCommand: "stop",
	noGui: "flag",
	isProxy: false,
	needsEula: true,
	addonDirs: ["plugins"],
	acceptsFamilies: ["paper", "universal"],
	forwarding: "paper-global",
	portConfig: "properties",
	offlineIdentity: "vanilla",
	levelName: PROPERTIES_LEVEL,
	bootMarker: VANILLA_BOOT,
	readyMarker: VANILLA_READY,
	logGrammar: "bukkit",
	addonLoadMarker: BUKKIT_ADDON,
	announcesDataPacks: true,
} as const satisfies Partial<SoftwareTraits>;

/**
 * Traits shared by the mohist hybrids: a neoforge server that also runs the
 * bukkit plugin ecosystem, so it carries both addon directories and speaks the
 * Paper API well enough to read paper's own forwarding config.
 */
const YOUER_LIKE = {
	kind: "jar",
	binaryName: "server.jar",
	stopCommand: "stop",
	noGui: "bare",
	isProxy: false,
	needsEula: true,
	addonDirs: ["plugins", "mods"],
	acceptsFamilies: ["paper", "universal", "neoforge"],
	forwarding: "paper-global",
	portConfig: "properties",
	offlineIdentity: "vanilla",
	levelName: PROPERTIES_LEVEL,
	bootMarker: MODLAUNCHER_BOOT,
	readyMarker: VANILLA_READY,
	logGrammar: "bukkit",
	addonLoadMarker: BUKKIT_ADDON,
	announcesDataPacks: true,
	provider: "mohist",
} as const satisfies Partial<SoftwareTraits>;

/** What a table entry spells out; the rest is computed from it. */
type SoftwareRow = Omit<SoftwareTraits, "carriesMcRequirement" | "usesJava">;

/**
 * Every difference between the softwares luna launches, in one table.
 *
 * The record is exhaustive on purpose: adding a member to `Software` without
 * describing it here is a compile error rather than a branch that silently
 * falls through to paper's behaviour.
 */
const SOFTWARE_ROWS: Record<Software, SoftwareRow> = {
	paper: {
		...PAPER_LIKE,
		label: "core.software.paper",
		provider: "papermc",
	},

	folia: {
		...PAPER_LIKE,
		label: "core.software.folia",
		provider: "papermc",
	},

	purpur: {
		...PAPER_LIKE,
		label: "core.software.purpur",
		provider: "purpur",
	},

	velocity: {
		label: "core.software.velocity",
		kind: "jar",
		binaryName: "velocity.jar",
		stopCommand: "end",
		isProxy: true,
		needsEula: false,
		addonDirs: ["plugins"],
		acceptsFamilies: ["velocity", "universal"],
		forwarding: "none",
		portConfig: "velocity-toml",
		// the proxy is the one issuing ids, never deriving one
		offlineIdentity: "vanilla",
		bootMarker: /Booting up Velocity/,
		readyMarker: VANILLA_READY,
		logGrammar: "velocity",
		addonLoadMarker: VELOCITY_ADDON,
		// the proxy hosts no world, so nothing about packs is ever logged
		announcesDataPacks: false,
		provider: "papermc",
	},

	fabric: {
		label: "core.software.fabric",
		kind: "jar",
		binaryName: "server.jar",
		stopCommand: "stop",
		noGui: "bare",
		isProxy: false,
		needsEula: true,
		addonDirs: ["mods"],
		acceptsFamilies: ["fabric"],
		forwarding: "none",
		forwardingMod: FABRIC_PROXY,
		// fabric loader ships no game API of its own; fabricproxy-lite and
		// luna-core-fabric both hard-depend on this, so without it the server
		// refuses to start rather than starting without them
		requiredAddons: [{ provider: "modrinth", slug: "fabric-api" }],
		portConfig: "properties",
		offlineIdentity: "vanilla",
		levelName: PROPERTIES_LEVEL,
		bootMarker: FABRIC_BOOT,
		readyMarker: VANILLA_READY,
		logGrammar: "fabric",
		addonLoadMarker: FABRIC_ADDON,
		announcesDataPacks: true,
		provider: "fabric",
		pinsLoaderVersion: true,
	},

	forge: {
		label: "core.software.forge",
		kind: "argsfile",
		stopCommand: "stop",
		noGui: "bare",
		isProxy: false,
		needsEula: true,
		addonDirs: ["mods"],
		acceptsFamilies: ["forge"],
		forwarding: "none",
		forwardingMod: FORGE_PROXY,
		portConfig: "properties",
		offlineIdentity: "vanilla",
		levelName: PROPERTIES_LEVEL,
		bootMarker: MODLAUNCHER_BOOT,
		readyMarker: VANILLA_READY,
		logGrammar: "modlauncher",
		addonLoadMarker: MODLAUNCHER_ADDON,
		announcesDataPacks: true,
		provider: "forge",
		pinsLoaderVersion: true,
		libraryPath: FORGE_LIBRARIES,
		argsFile: (inst) => argsFilePath(inst, `${FORGE_LIBRARIES}/${inst.mcVersion}-${inst.loaderVersion}`),
	},

	neoforge: {
		label: "core.software.neoforge",
		kind: "argsfile",
		stopCommand: "stop",
		noGui: "bare",
		isProxy: false,
		needsEula: true,
		addonDirs: ["mods"],
		acceptsFamilies: ["neoforge"],
		forwarding: "none",
		forwardingMod: FORGE_PROXY,
		portConfig: "properties",
		offlineIdentity: "vanilla",
		levelName: PROPERTIES_LEVEL,
		bootMarker: MODLAUNCHER_BOOT,
		readyMarker: VANILLA_READY,
		logGrammar: "modlauncher",
		addonLoadMarker: MODLAUNCHER_ADDON,
		announcesDataPacks: true,
		provider: "neoforge",
		pinsLoaderVersion: true,
		libraryPath: NEOFORGE_LIBRARIES,
		argsFile: (inst) => argsFilePath(inst, `${NEOFORGE_LIBRARIES}/${inst.loaderVersion}`),
	},

	pumpkin: {
		label: "core.software.pumpkin",
		kind: "native",
		binaryName: "pumpkin",
		stopCommand: "stop",
		isProxy: false,
		needsEula: false,
		// wasm components, dropped in plugins/ like any other server plugin
		addonDirs: ["plugins"],
		acceptsFamilies: ["pumpkin"],
		forwarding: "pumpkin-toml",
		portConfig: "pumpkin-toml",
		offlineIdentity: "pumpkin",
		levelName: { file: "pumpkin.toml", format: "toml", key: "default_level_name", fallback: "world" },
		bootMarker: /Starting Pumpkin /i,
		// pumpkin reports in whatever unit fits, commonly milliseconds
		readyMarker: /Started server; took (\d+\s*[a-z]+)/i,
		logGrammar: "pumpkin",
		addonLoadMarker: PUMPKIN_ADDON,
		// pumpkin is not vanilla-derived; its world loads without a word about packs
		announcesDataPacks: false,
		provider: "pumpkin",
		// the one directory luna-core's sandbox may read is its own data folder
		hostMetricsFile: "plugins/data/luna-core/host-metrics",
		experimental: true,
	},

	youer: {
		...YOUER_LIKE,
		label: "core.software.youer",
	},

	asyncyouer: {
		...YOUER_LIKE,
		label: "core.software.asyncyouer",
		experimental: true,
	},
};

/**
 * The table as everything reads it, with the derived columns filled in. They
 * are computed rather than written per row because each restates a fact the row
 * already carries, and two columns kept in step by hand drift.
 */
export const SOFTWARE_TRAITS: Record<Software, SoftwareTraits> = Object.fromEntries(
	Object.entries(SOFTWARE_ROWS).map(([id, row]) => [
		id,
		{
			...row,
			carriesMcRequirement: !row.isProxy,
			usesJava: row.kind !== "native",
		},
	]),
) as Record<Software, SoftwareTraits>;

/** Every software id, in the order they are offered. */
export const SOFTWARE_IDS: Software[] = Object.keys(SOFTWARE_TRAITS) as Software[];

/**
 * The directory a build of each family belongs in. A bukkit jar in `mods/` is
 * ignored at best and a crash at worst, so this pairing is what keeps the two
 * ecosystems apart even on a hybrid that runs both.
 */
export const FAMILY_DIRS: Record<PluginFamily, AddonDir> = {
	paper: "plugins",
	velocity: "plugins",
	universal: "plugins",
	neoforge: "mods",
	fabric: "mods",
	forge: "mods",
	pumpkin: "plugins",
};

/**
 * What a build of each family is called on disk.
 *
 * Everything on a JVM is a jar; a pumpkin plugin is a WebAssembly component and
 * the server loads `plugins/*.wasm` and nothing else. The pool, the lockfile key
 * and the deployed copy all have to agree on this, which is why it is one table
 * rather than a `.jar` written wherever a name is built.
 */
export const FAMILY_EXTENSIONS: Record<PluginFamily, string> = {
	paper: ".jar",
	velocity: ".jar",
	universal: ".jar",
	neoforge: ".jar",
	fabric: ".jar",
	forge: ".jar",
	pumpkin: ".wasm",
};

/** Every extension an addon may carry, for listing a directory. */
export const ADDON_EXTENSIONS: string[] = [...new Set(Object.values(FAMILY_EXTENSIONS))];

/**
 * Loader facets each family's builds are published under, upstream. A paper
 * server also loads bukkit and spigot jars; a mod loader accepts only its own.
 * A universal jar is a paper build that happens to carry a velocity descriptor
 * too, so the paper facets are what find it.
 */
export const FAMILY_LOADERS: Record<PluginFamily, string[]> = {
	paper: PAPER_LOADERS,
	universal: PAPER_LOADERS,
	velocity: VELOCITY_LOADERS,
	neoforge: NEOFORGE_LOADERS,
	fabric: FABRIC_LOADERS,
	forge: FORGE_LOADERS,
	pumpkin: PUMPKIN_LOADERS,
};

/**
 * The family a jar found in one of an instance's own addon directories belongs
 * to: the software's first accepted family that deploys there. A universal
 * build is only ever declared by hand, never guessed from one instance, so it
 * is not a candidate here.
 */
export function familyForDir(software: Software, dir: AddonDir): Exclude<PluginFamily, "universal"> {
	const accepted = traitsOf(software).acceptsFamilies;

	const own = accepted.find(
		(family): family is Exclude<PluginFamily, "universal"> =>
			family !== "universal" && FAMILY_DIRS[family] === dir,
	);

	return own ?? (dir === "mods" ? "neoforge" : "paper");
}

/** Whether luna can download builds of this software, or only adopt it. */
export function hasProvider(software: Software): boolean {
	return Boolean(traitsOf(software).provider);
}

/** Whether a version pick for this software needs a loader build as well. */
export function hasLoaderVersions(software: Software): boolean {
	return Boolean(traitsOf(software).pinsLoaderVersion);
}

/** What differs about one software. */
export function traitsOf(software: Software): SoftwareTraits {
	const traits = SOFTWARE_TRAITS[software];

	if (!traits) {
		throw new Error(t("core.software.unknown", { software }));
	}

	return traits;
}

/**
 * The loader's generated argument file, relative to the instance directory.
 * The installer writes the whole classpath and launch target in there, so it
 * is the only supported way to boot; there is no runnable `-jar`.
 */
function argsFilePath(inst: InstanceConfig, buildDir: string): string {
	if (!inst.loaderVersion) {
		throw new Error(t("core.instances.noLoaderVersion"));
	}

	return `${buildDir}/unix_args.txt`;
}

/**
 * Split a Minecraft version into numeric components.
 *
 * Two schemes are in circulation: the historical `1.<minor>.<patch>` and the
 * date-based `<year>.<release>` that arrived with 26.2. Plain component-wise
 * numeric ordering happens to sort them correctly against each other, because
 * every legacy version starts with 1 and every new one starts with a year.
 */
export function mcVersionParts(version: string): number[] {
	return version
		.split(".")
		.map((part) => Number.parseInt(part, 10))
		.map((part) => (Number.isFinite(part) ? part : 0));
}

/**
 * Lowest major number the date-based scheme can produce. The `1.<minor>` line
 * never reached a second component anywhere near a year, and it stopped at
 * 1.21.11, so the leading number alone separates the two schemes.
 */
const DATE_SCHEME_FLOOR = 22;

/**
 * Whether a version belongs to the date-based scheme (26.1 and up).
 *
 * The distinction is not cosmetic: that line is where Mojang stopped obfuscating
 * the server and raised the Java floor, so several things key off it.
 */
export function isDateScheme(version: string): boolean {
	const [major = 0] = mcVersionParts(version);

	return major >= DATE_SCHEME_FLOOR;
}

/** Whether a version string is a plain release, not a snapshot or pre-release. */
export function isReleaseVersion(version: string): boolean {
	return /^\d+\.\d+(\.\d+)?$/.test(version);
}

/** Order Minecraft versions newest first, numerically rather than as text. */
export function compareMcVersionsDesc(a: string, b: string): number {
	const left = mcVersionParts(a);
	const right = mcVersionParts(b);
	const len = Math.max(left.length, right.length);

	for (let i = 0; i < len; i++) {
		const diff = (right[i] ?? 0) - (left[i] ?? 0);

		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

/**
 * The newest version worth defaulting to.
 *
 * Normally that is the newest plain release, so a default pick can never land
 * on a snapshot or a pre-release. Not every upstream versions itself by the
 * game though: pumpkin publishes release tags, and filtering those to
 * release-shaped strings leaves nothing at all. So a list with no release in it
 * answers with its own first entry, which every provider returns newest-first.
 */
export function newestRelease(versions: string[]): string | undefined {
	const releases = versions.filter(isReleaseVersion);

	if (!releases.length) {
		return versions[0];
	}

	return releases.sort(compareMcVersionsDesc)[0];
}
