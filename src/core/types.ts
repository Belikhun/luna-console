export type Software = "paper" | "velocity";

export interface JavaProfile {
	/** Path to java binary, default "java" */
	java?: string;
	/** JVM flags placed before -jar */
	flags: string[];
	/** Extra args appended after the jar (e.g. --nogui is added automatically for paper) */
	jarArgs?: string[];
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
	/** Minecraft version, e.g. "1.21.11" (paper only) */
	mcVersion?: string;
	port: number;
	memory: string; // "4G"
	profile: string;
	/** Override java binary for this instance */
	java?: string;
	/** Extra JVM flags for this instance, appended after the profile's own flags */
	javaArgs?: string[];
	/** Plugin port allocations, key = "<plugin>/<portId>" */
	ports?: Record<string, number>;
	/** Plugin groups applied to this instance ("default" is always applied, never listed) */
	pluginGroups?: string[];
	/** Per-instance plugin overrides, plugin name → enabled. `true` force-adds the
	 *  plugin regardless of groups; `false` disables it even when a group (or an
	 *  explicit lockfile target) provides it. Overrides win over groups. */
	pluginOverrides?: Record<string, boolean>;
	/** External server (proxy-registered but not managed on this machine) */
	external?: string; // "host:port"
	proxy?: ProxyRegistration;
}

/** Where the in-house `luna-*` plugin sources live and how they are built. */
export interface LunaSourceConfig {
	/** Absolute path of the luna-plugins gradle workspace (default ~/luna-plugins) */
	dir: string;
	/** Gradle task that produces the shadow jars */
	task?: string;
	/** Platforms whose artifacts are pooled — neoforge is built but not deployed here */
	platforms?: string[];
}

export interface ClusterConfig {
	screenPrefix: string;
	/** Port pool for new paper instances */
	serverPortRange: [number, number];
	javaProfiles: Record<string, JavaProfile>;
	proxy: InstanceConfig;
	instances: Record<string, InstanceConfig>;
	/** In-house plugin build source, for `mrds luna …` */
	luna?: LunaSourceConfig;
}

export type PluginSource = "modrinth" | "luna" | "manual";

/** Platform a plugin build runs on. "universal" jars load on paper and velocity alike. */
export type PluginFamily = "paper" | "velocity" | "universal" | "neoforge";

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
	/** Bukkit `api-version` — the oldest MC API the plugin targets */
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

/** A named set of plugin names, applied to instances as a unit. */
export interface PluginGroup {
	description?: string;
	/** Plugin names (`PluginEntry.plugin`), not entry keys */
	plugins: string[];
	/** The "default" group: applied to every instance, hardcoded members locked */
	builtin?: boolean;
}

export interface PortBindingSpec {
	id: string;
	protocol: "tcp" | "udp";
	scope: "instance" | "proxy";
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
	loader: "paper" | "velocity";
	/** Plugin name this build belongs to (several entries share one); defaults to the entry key */
	plugin?: string;
	/** Platform this build runs on; defaults to `loader` */
	family?: PluginFamily;
	/** Names this build goes by in server logs (plugin.yml `name`, velocity id/name).
	 *  First entry is the display name. Extracted from the pool jar on demand. */
	aliases?: string[];
	/** Descriptor read from the jar (plugin.yml / paper-plugin.yml /
	 *  velocity-plugin.json / neoforge.mods.toml), extracted on demand. */
	meta?: PluginMeta;
	/** Config-template ops applied on deploy */
	config?: ConfigOp[];
	modrinth?: { projectId: string; slug: string };
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
	/** Plugin groups, keyed by group name ("default" always exists after migration) */
	groups?: Record<string, PluginGroup>;
}
