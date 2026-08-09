// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import type { InstanceSelectorEntry, SelectorStatus, ServerSelectorConfig } from "../shared/selector";

export * from "../shared/selector";

/**
 * Server software luna can launch. Everything that differs between them is one
 * row of `SOFTWARE_TRAITS` (core/software.ts): where addons live, how the
 * server is launched, which plugin families load, how proxy forwarding is
 * configured. A mod loader keeps its addons in `mods/` rather than `plugins/`,
 * and the two ecosystems never cross except on the hybrids, which carry both.
 */
export type Software =
	| "paper"
	| "folia"
	| "velocity"
	| "purpur"
	| "fabric"
	| "forge"
	| "neoforge"
	| "pumpkin"
	| "youer"
	| "asyncyouer";

/** The directory name an addon of one kind lives in, inside an instance. */
export type AddonDir = "plugins" | "mods";

export interface JavaProfile {
	/** Path to java binary, default "java" */
	java?: string;
	/** Managed runtime id, e.g. "temurin@21.0.5+11". Used when `java` is unset. */
	runtime?: string;
	/** JVM flags placed before -jar */
	flags: string[];
	/** Extra args appended after the jar (e.g. --nogui is added automatically for paper) */
	jarArgs?: string[];
}

/**
 * Java distributions luna can install. Temurin comes from the Adoptium API in
 * both its JDK and JRE image, GraalVM Community from its own GitHub releases;
 * a vendor is the half of a runtime id before the "@".
 */
export type RuntimeVendor = "temurin" | "temurin-jre" | "graalvm-ce";

/** A runtime the vendor publishes for one platform, ready to be installed. */
export interface AvailableRuntime {
	/** Canonical id, "<vendor>@<version>", e.g. "temurin@21.0.5+11" */
	id: string;
	vendor: RuntimeVendor;
	version: string;
	/** Major/feature release: 21 for "21.0.5+11", 8 for "8u432-b06" */
	feature: number;
	lts?: boolean;
	/** Platform triple the archive is built for, e.g. "linux-x64" */
	platform: string;
	url: string;
	sha256?: string;
	/** Sidecar holding the sha256, when the vendor publishes it as its own file */
	digestUrl?: string;
	size?: number;
}

/** A runtime installed under `<root>/.runtimes` on one machine. */
export interface InstalledRuntime {
	id: string;
	vendor: RuntimeVendor;
	version: string;
	feature: number;
	/** Directory under `.runtimes`; the id with "+" folded to "_" */
	dirName: string;
	/** Absolute path to the java binary on the machine holding it */
	javaPath: string;
	platform: string;
	/** ISO 8601 */
	installedAt: string;
	sizeBytes?: number;
	/** First line of `bin/java -version`, recorded once at install */
	javaVersionLine?: string;
}

/** What one machine has installed, as that machine reports it. */
export interface LocalRuntimeInventory {
	/** The answering daemon's own platform triple */
	platform: string;
	runtimes: InstalledRuntime[];
}

/** One machine's slice of the fleet-wide inventory. */
export interface MachineRuntimes {
	/** Machine key; "" is the primary */
	machine: string;
	platform: string | null;
	/** null = the machine did not answer, which is not the same as "none" */
	runtimes: InstalledRuntime[] | null;
}

/**
 * Which of the four possible sources decides an instance's java binary. The
 * decision is pure config, so it resolves identically on a client; only the
 * absolute path behind a `runtime` is machine-local.
 */
export type JavaSelection =
	| { kind: "path"; path: string; source: "instance" | "profile" }
	| { kind: "runtime"; id: string; source: "instance" | "profile" }
	| { kind: "default" };

/** Something that asked for a runtime id, and where it runs. */
export interface RuntimeConsumer {
	kind: "instance" | "profile";
	/** Instance name, or the profile's name */
	name: string;
	/** Machine key the use lands on ("" = primary); absent for an unused profile */
	machine?: string;
}

export interface ProxyRegistration {
	register: boolean;
	/** Hostnames force-routed to this instance */
	forcedHosts?: string[];
	/** Position in the velocity `try` list; lower = earlier. Omit = not in try list. */
	priority?: number;
}

export interface InstanceConfig {
	/** Directory name under the root */
	dir: string;
	software: Software;
	/** Minecraft version, e.g. "1.21.11". Absent only on software that does not
	 *  pin one, which today means the proxy. */
	mcVersion?: string;
	/** Loader build, for software that has one beside the MC version: the args-file
	 *  loaders (neoforge "21.1.233" → libraries/net/neoforged/neoforge/21.1.233,
	 *  forge "52.0.20"), fabric's loader, and the hybrids' bundled loader. */
	loaderVersion?: string;
	port: number;
	memory: string; // "4G"
	profile: string;
	/** Override java binary for this instance; wins over every runtime id */
	java?: string;
	/** Managed runtime id for this instance, e.g. "temurin@21.0.5+11" */
	runtime?: string;
	/** Extra JVM flags for this instance, appended after the profile's own flags */
	javaArgs?: string[];
	/** Relaunch after an unexpected exit; absent = on. A requested stop never
	 *  relaunches, whatever this says. */
	autoRestart?: boolean;
	/** Seconds to wait before relaunching after a crash; absent = 3 */
	restartDelay?: number;
	/** Plugin port allocations, key = "<plugin>/<portId>" */
	ports?: Record<string, number>;
	/** Addon groups applied to this instance ("default" is always applied, never
	 *  listed). Read through `instanceGroupNames`. */
	addonGroups?: string[];
	/** Per-instance plugin overrides, plugin name → enabled. `true` force-adds the
	 *  plugin regardless of groups; `false` disables it even when a group (or an
	 *  explicit lockfile target) provides it. Overrides win over groups. */
	pluginOverrides?: Record<string, boolean>;
	/** External server (proxy-registered but not managed on this machine) */
	external?: string; // "host:port"
	/** Daemon that owns this instance; absent = the primary daemon's host */
	daemon?: string;
	proxy?: ProxyRegistration;

	// -- server selector presentation ------------------------------------------
	// These describe how the instance appears in the proxy's `/servers` GUI and in
	// the messages around it. cluster.json owns them; `servers.yml` is generated
	// from them (core/selector.ts), never the other way round.

	/** MiniMessage display name, e.g. "<gradient:#AC92FE:#25EED0>SMP</gradient>" */
	serverDisplay?: string;
	/** Hex accent colour, "#RRGGBB" */
	accentColor?: string;
	/** Bukkit material of the selector item */
	serverIcon?: string;
	/** Material overrides per selector status */
	serverStatusIcons?: Partial<Record<SelectorStatus, string>>;
	/** MiniMessage lore lines shown under the item's name */
	description?: string[];
	/** Placement in the GUI and click behaviour; absent = not shown */
	selector?: InstanceSelectorEntry;
}

/** Persisted registration of a follower daemon (live state comes from the hub). */
export interface DaemonRegistration {
	/** LAN host the follower's instances are reachable on (from its connection) */
	host: string;
	/** Every non-loopback IPv4 address the follower reported for itself */
	addresses?: string[];
	/** Cluster root on the follower's own disk */
	root?: string;
	/** Daemon binary version last seen */
	version?: string;
	/** ISO 8601; first registration */
	addedAt?: string;
	/** ISO 8601; last time the follower was connected */
	lastSeen?: string;
}

/** Where the in-house `luna-*` plugin sources live and how they are built. */
export interface LunaSourceConfig {
	/** Absolute path of the luna-plugins gradle workspace (default ~/luna-plugins) */
	dir: string;
	/** Gradle task that produces the shadow jars */
	task?: string;
	/** Platforms whose artifacts are pooled (paper, velocity, neoforge) */
	platforms?: string[];
}

/** One machine's departure from a pool's cluster-wide numbers. */
export interface PortPoolOverride {
	/** Range this machine hands out instead of the pool's default */
	range?: [number, number];
	/** Numbers this machine must never hand out (replaces the pool's own list) */
	reserved?: number[];
}

/**
 * A named range of ports, addressed by id. The id is the whole mapping: a
 * consumer asks for a pool by name; instance provisioning takes the game port
 * from `game`, a plugin's port spec (`PortBindingSpec.pool`) names the pool its
 * per-instance port comes from; and the pool answers with a number on the
 * machine the consumer lands on. Provisioning acquires from a pool and the
 * number stays on the instance until it is deleted, so a pool's free set is
 * derived from the registry rather than tracked separately (DESIGN.md §2.7).
 *
 * The definition is cluster-wide so every machine can serve every consumer;
 * only the *numbers* vary per machine (`overrides`), because a port is only
 * taken on the host that binds it and two hosts may hand out the same range.
 */
export interface PortPool {
	/** Pool id, unique across the cluster; what a consumer asks for */
	id: string;
	/** What the pool is for, shown in the console */
	label?: string;
	/** `both` reserves the number for either protocol; use it for pools whose
	 *  consumers bind tcp and udp on the same port */
	protocol: "tcp" | "udp" | "both";
	/** Range every machine hands out, unless it overrides */
	range: [number, number];
	/** Numbers inside the range no machine may hand out */
	reserved?: number[];
	/** Per-machine departures, keyed by daemon name ("" = the primary) */
	overrides?: Record<string, PortPoolOverride>;
}

export interface ClusterConfig {
	screenPrefix: string;
	/** Default range of the `game` port pool, for machines that define no pool of
	 *  their own (per-machine pools live in `portPools`) */
	serverPortRange: [number, number];
	javaProfiles: Record<string, JavaProfile>;
	proxy: InstanceConfig;
	instances: Record<string, InstanceConfig>;
	/** In-house plugin build source, for `luna luna …` */
	luna?: LunaSourceConfig;
	/** Cluster-wide half of the server selector; per-server halves live on the
	 *  instances themselves (core/selector.ts renders both into servers.yml) */
	serverSelector?: ServerSelectorConfig;
	/** Known follower daemons, keyed by daemon name */
	daemons?: Record<string, DaemonRegistration>;
	/** Cluster-wide port pool catalog. An entry replaces the built-in default of
	 *  the same id; a new id adds a pool. Read through `poolCatalog`/`poolsFor`
	 *  (core/ports.ts), which merge in the defaults. */
	portPools?: PortPool[];
}

/** An upstream platform luna can install addons from (core/services/providers.ts). */
export type ProviderId = "modrinth" | "curseforge" | "hangar" | "smithed";

/**
 * Where a provider-sourced entry installs and updates from. `projectId` is the
 * provider's immutable identity (Modrinth project id, CurseForge mod id,
 * Hangar numeric id, Smithed docId); `slug` is the human name used in URLs.
 */
export interface RemoteRef {
	provider: ProviderId;
	projectId: string;
	slug: string;
	/** Hangar only: the project's owner, half of its web URL */
	owner?: string;
}

export type PluginSource = ProviderId | "luna" | "manual";

/**
 * Platform a plugin build runs on. "universal" jars load on paper and velocity
 * alike. Which families a given software accepts is one column of
 * `SOFTWARE_TRAITS` (core/software.ts), not a rule spelled out per call site.
 */
export type PluginFamily = "paper" | "velocity" | "universal" | "neoforge" | "fabric" | "forge" | "pumpkin";

/** Every family, in the order they are offered. */
export const PLUGIN_FAMILIES: PluginFamily[] = [
	"paper",
	"velocity",
	"universal",
	"neoforge",
	"fabric",
	"forge",
	"pumpkin",
];

/** What the jar says about itself, read from its own descriptor. */
export interface PluginMeta {
	/** Display name (plugin.yml `name`, velocity `name`, neoforge `displayName`) */
	name?: string;
	/** Machine id (velocity `id`, neoforge `modId`) */
	id?: string;
	/** Version the descriptor declares (may differ from the resolved pool version) */
	version?: string;
	description?: string;
	authors?: string[];
	website?: string;
	/** Bukkit `api-version`; the oldest MC API the plugin targets */
	apiVersion?: string;
}

/**
 * One config-template operation, applied whenever its plugin deploys to an
 * instance. Values may reference `${VARS}` from the environment manager.
 */
export interface ConfigOp {
	/** Path relative to the instance directory, e.g. "plugins/LuckPerms/config.yml" */
	file: string;
	/** Config syntax for `set` ops; inferred from the file extension when omitted */
	format?: "properties" | "hocon" | "yaml" | "toml";
	/** Surgical key edits (line-preserving; the first occurrence of a key wins) */
	set?: Record<string, string>;
	/** Full file body, written only when the file does not exist yet (bootstrap) */
	write?: string;
}

/**
 * A named set of *addons*; plugins, resource packs and data packs; applied to
 * instances as a unit. Membership is by name, never by file: a plugin name
 * (`PluginEntry.plugin`) covers every family build of it, a resource pack key
 * covers its zip + definition, a data pack name covers its pooled zip.
 */
export interface AddonGroup {
	description?: string;
	/** Plugin names (`PluginEntry.plugin`), not entry keys */
	plugins: string[];
	/** Resource pack keys (`packs.lock.json` → resourcepacks) served on the group's instances */
	respacks?: string[];
	/** Data pack names (`packs.lock.json` → datapacks) deployed into their worlds */
	datapacks?: string[];
	/** The "default" group: applied to every instance, hardcoded members locked */
	builtin?: boolean;
}

export interface PortBindingSpec {
	id: string;
	protocol: "tcp" | "udp";
	scope: "instance" | "proxy";
	/** Pool id the allocation is acquired from on the target's machine; `range` is
	 *  the fallback for a machine that has no such pool */
	pool?: string;
	range: [number, number];
	/** Fixed port (proxy scope), overrides range */
	fixed?: number;
	config: {
		/** Relative to the instance dir */
		file: string;
		format: "properties" | "hocon" | "yaml" | "toml";
		key: string;
	};
}

/** An additional pooled version of a plugin, for instances that can't run the primary. */
export interface PluginVariant {
	versionId?: string;
	versionNumber: string;
	sha512: string;
	/** File name under plugins/versions/ */
	file: string;
	/** MC versions this build supports (server version requirement) */
	gameVersions?: string[];
}

/** Build provenance of an in-house (`source: "luna"`) jar, recorded on deploy. */
export interface LunaBuildInfo {
	/** Gradle module the jar is built from, e.g. "luna-core-paper" */
	module: string;
	/** Short commit hash of the source tree at build time */
	commit?: string;
	/** Whether that tree had uncommitted changes */
	dirty?: boolean;
	/** When the jar was pooled, ISO 8601 */
	pooledAt?: string;
}

export interface PluginEntry {
	/** File name in the common pool (the primary/newest version) */
	file: string;
	source: PluginSource;
	/** Plugin name this build belongs to (several entries share one); defaults to the entry key */
	plugin?: string;
	/** Platform this build runs on */
	family: PluginFamily;
	/** Names this build goes by in server logs (plugin.yml `name`, velocity id/name).
	 *  First entry is the display name. Extracted from the pool jar on demand. */
	aliases?: string[];
	/** Descriptor read from the jar (plugin.yml / paper-plugin.yml /
	 *  velocity-plugin.json / neoforge.mods.toml), extracted on demand. */
	meta?: PluginMeta;
	/** Config-template ops applied on deploy */
	config?: ConfigOp[];
	/** Provider the entry installs/updates from; absent for luna/manual entries */
	remote?: RemoteRef;
	installed?: {
		versionId?: string;
		versionNumber?: string;
		sha512: string;
		/** MC versions the primary build supports (server version requirement) */
		gameVersions?: string[];
	};
	/** Extra pooled versions, keyed by versionNumber */
	variants?: Record<string, PluginVariant>;
	/** Auto-resolved per-instance version assignments (instance → versionNumber).
	 *  Instances not listed run the primary. Refreshed by plugins update. */
	assign?: Record<string, string>;
	/** User-forced per-instance version pins (instance → versionNumber). Win over assign. */
	pins?: Record<string, string>;
	autoUpdate: boolean;
	/** Most unstable release channel to accept for updates (default "release").
	 *  Seeded by scan from the installed version's channel. */
	channel?: "release" | "beta" | "alpha";
	/** Instance names, or wildcards: "*", "*paper", "*velocity" */
	targets: string[];
	ports?: PortBindingSpec[];
	/** Build provenance, for `source: "luna"` entries only */
	luna?: LunaBuildInfo;
}

export interface PluginsLock {
	/** Lockfile schema revision; 2 = plugin identity + groups. Absent = v1. */
	version?: number;
	plugins: Record<string, PluginEntry>;
	/** Addon groups, keyed by group name ("default" always exists after migration) */
	groups?: Record<string, AddonGroup>;
}
