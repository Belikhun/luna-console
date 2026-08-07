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

/** Which file carries the port an instance binds. */
export type PortConfig = "properties" | "velocity-toml" | "pumpkin-toml";

/**
 * The shape of a software's console log, for boot-session and addon
 * attribution. Several softwares share one grammar, which is the point: the
 * parser branches on the grammar, never on the software.
 */
export type LogGrammar = "bukkit" | "velocity" | "modlauncher" | "generic";

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
	portConfig: PortConfig;
	/** First line of a boot; everything below it is one session */
	bootMarker: RegExp;
	/** The line where the server says it is up. Capture 1 is how long it took,
	 *  with an optional unit suffix; without one it is read as seconds. */
	readyMarker: RegExp;
	logGrammar: LogGrammar;
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

/** Paper's bootstrap line, or the vanilla server line it is followed by. */
const VANILLA_BOOT = /\[bootstrap\] Running Java|Starting minecraft server version/;

const FABRIC_BOOT = /Loading Minecraft [\d.]+ with Fabric Loader|Starting minecraft server version/;

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
	bootMarker: VANILLA_BOOT,
	readyMarker: VANILLA_READY,
	logGrammar: "bukkit",
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
	bootMarker: MODLAUNCHER_BOOT,
	readyMarker: VANILLA_READY,
	logGrammar: "bukkit",
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
		bootMarker: /Booting up Velocity/,
		readyMarker: VANILLA_READY,
		logGrammar: "velocity",
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
		portConfig: "properties",
		bootMarker: FABRIC_BOOT,
		readyMarker: VANILLA_READY,
		logGrammar: "generic",
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
		bootMarker: MODLAUNCHER_BOOT,
		readyMarker: VANILLA_READY,
		logGrammar: "modlauncher",
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
		bootMarker: MODLAUNCHER_BOOT,
		readyMarker: VANILLA_READY,
		logGrammar: "modlauncher",
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
		addonDirs: [],
		acceptsFamilies: [],
		forwarding: "pumpkin-toml",
		portConfig: "pumpkin-toml",
		bootMarker: /Starting Pumpkin /i,
		// pumpkin reports in whatever unit fits, commonly milliseconds
		readyMarker: /Started server; took (\d+\s*[a-z]+)/i,
		logGrammar: "generic",
		provider: "pumpkin",
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
};

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
