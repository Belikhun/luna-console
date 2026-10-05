// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The MCP tool catalog: every tool luna's MCP endpoint can expose, as data.
 *
 * A token's scope names groups and individual tools out of this list, the web
 * endpoint advertises the tools a token resolves to, and the CLI and console
 * render the same list when a scope is edited, so a new tool is one entry here
 * plus its adapter in `web/src/lib/server/mcp/handlers.ts`.
 *
 * `description` and the schema's own descriptions are written for the model on
 * the far side of the connection, in English, and travel as protocol text the
 * way a config key does. What a human reads in the console is the i18n key
 * `core.mcp.tools.<name>`.
 *
 * `network` / `network-write` cover the `/servers` menu, velocity registration
 * and ports; `packs` / `packs-write` cover resource packs and data packs. Like
 * the addon pool, all of it is cluster-wide, so the write groups are closed to a
 * token limited to some instances (instance_set_port excepted, since it names
 * the one instance it changes).
 *
 * Deliberately absent as dedicated tools: deleting instances, set-version,
 * cleanup, accounts, revealing secrets and upgrades. File writes and the two
 * shells exist, but in groups of their own that no token gets by default, and
 * the host shell additionally needs the machine itself to opt in
 * (`mcpHostShell` in that daemon's config).
 */

/** What a tool is for; the unit a scope is usually granted in. */
export type McpToolGroup =
	| "observe"
	| "control"
	| "config"
	| "files"
	| "files-write"
	| "shell"
	| "host-shell"
	| "addons"
	| "addons-write"
	| "network"
	| "network-write"
	| "packs"
	| "packs-write"
	| "knowledge"
	| "knowledge-write";

/** Every group, in the order the scope editor lists them. */
export const MCP_TOOL_GROUPS: McpToolGroup[] = [
	"observe",
	"control",
	"config",
	"files",
	"files-write",
	"shell",
	"host-shell",
	"addons",
	"addons-write",
	"network",
	"network-write",
	"packs",
	"packs-write",
	"knowledge",
	"knowledge-write",
];

/** What a freshly minted token may do until somebody widens it. */
export const MCP_DEFAULT_GROUPS: McpToolGroup[] = ["observe", "knowledge"];

/** The subset of JSON Schema the catalog uses, and the endpoint validates. */
export interface McpSchema {
	type: "object" | "string" | "integer" | "number" | "boolean" | "array";
	description?: string;
	properties?: Record<string, McpSchema>;
	required?: string[];
	items?: McpSchema;
	enum?: string[];
	minimum?: number;
	maximum?: number;
	maxLength?: number;
	additionalProperties?: boolean;
}

/** The MCP tool annotations; hints a client may use to decide how careful to be. */
export interface McpToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface McpToolSpec {
	name: string;
	group: McpToolGroup;
	/** Model-facing description; protocol text, not a language key */
	description: string;
	inputSchema: McpSchema;
	annotations: McpToolAnnotations;
	/** The argument naming an instance, which the token's instance allowlist gates */
	instanceArg?: string;
}

/** A token's grant: groups, then explicit allows, then explicit denies, which win. */
export interface McpScope {
	groups: McpToolGroup[];
	allow: string[];
	deny: string[];
	/** Instances the token may name; null means every instance */
	instances: string[] | null;
}

const INSTANCE = {
	type: "string",
	description: "Instance name, as listed by cluster_status (e.g. \"survival\", \"lobby\", \"proxy\").",
} as const satisfies McpSchema;

const READ: McpToolAnnotations = { readOnlyHint: true, openWorldHint: false };

const FAMILY = {
	type: "string",
	description: "Platform the build runs on: paper (Paper/Purpur/Folia plugins), velocity (proxy plugins), neoforge, forge or fabric (mods), universal (one jar for paper and velocity), pumpkin.",
	enum: ["paper", "velocity", "universal", "neoforge", "fabric", "forge", "pumpkin"],
} as const satisfies McpSchema;

const PROVIDER = {
	type: "string",
	description: "Where to look: modrinth (default), curseforge, hangar or smithed.",
	enum: ["modrinth", "curseforge", "hangar", "smithed"],
} as const satisfies McpSchema;

const CHANNEL = {
	type: "string",
	description: "Least stable release channel allowed: release, beta or alpha.",
	enum: ["release", "beta", "alpha"],
} as const satisfies McpSchema;

const ADDON = {
	type: "string",
	description: "The addon's lock entry key, as addon_info and addons_list show it (\"<plugin>@<family>\", e.g. \"luckperms@paper\").",
	maxLength: 160,
} as const satisfies McpSchema;

/** Registration fields a resource pack install may set straight away. */
const RESPACK_REGISTRATION: Record<string, McpSchema> = {
	enabled: { type: "boolean", description: "Start serving it (a new pack starts disabled)." },
	servers: { type: "array", description: "Servers it is sent on; \"*\" (the default) means all.", items: { type: "string", maxLength: 80 } },
	priority: { type: "integer", description: "Higher priority loads on top of lower (default 0).", minimum: -1000, maximum: 1000 },
	required: { type: "boolean", description: "Players must accept it to stay (default false)." },
};

const TARGETS = {
	type: "array",
	description: "Instances to deploy to. \"*\" means every instance the build fits; an empty list pools the addon without deploying it.",
	items: { type: "string", maxLength: 80 },
} as const satisfies McpSchema;

/** Changes the cluster's addons and redeploys; never removes anything. */
const ADDON_WRITE: McpToolAnnotations = { destructiveHint: false, idempotentHint: false, openWorldHint: true };

function object(properties: Record<string, McpSchema> = {}, required: string[] = []): McpSchema {
	return { type: "object", properties, required, additionalProperties: false };
}

export const MCP_TOOLS: McpToolSpec[] = [
	// -- observe ---------------------------------------------------------------
	{
		name: "cluster_status",
		group: "observe",
		description:
			"List every Minecraft server instance in the Luna cluster with its live state (running, stopped, starting...), software, Minecraft version, player count, TPS, memory and owning machine.",
		inputSchema: object(),
		annotations: READ,
	},
	{
		name: "instance_status",
		group: "observe",
		description: "Detailed live status of one instance, including health checks.",
		inputSchema: object({ instance: INSTANCE }, ["instance"]),
		annotations: READ,
		instanceArg: "instance",
	},
	{
		name: "instance_logs",
		group: "observe",
		description:
			"Read the tail of an instance's live server log (latest.log). Use `search` to keep only lines containing a substring (case-insensitive).",
		inputSchema: object(
			{
				instance: INSTANCE,
				lines: { type: "integer", description: "How many trailing lines to read (default 100).", minimum: 1, maximum: 1000 },
				search: { type: "string", description: "Only return lines containing this text.", maxLength: 200 },
			},
			["instance"],
		),
		annotations: READ,
		instanceArg: "instance",
	},
	{
		name: "players_online",
		group: "observe",
		description:
			"Who is connected to the network right now, per backend server, with ping, client version and session length.",
		inputSchema: object({
			instance: { type: "string", description: "Only players on this backend." },
		}),
		annotations: READ,
	},
	{
		name: "player_lookup",
		group: "observe",
		description:
			"Look up a player the network has seen (by username or UUID): first/last seen, play time, last server and whether they are online now.",
		inputSchema: object(
			{ player: { type: "string", description: "Username or UUID.", maxLength: 64 } },
			["player"],
		),
		annotations: READ,
	},
	{
		name: "fleet_status",
		group: "observe",
		description:
			"The machines (luna daemons) running the cluster: role, link state, build version, CPU, memory, disk and which instances each one owns.",
		inputSchema: object(),
		annotations: READ,
	},
	{
		name: "daemon_detail",
		group: "observe",
		description: "Health and checks of one machine (luna daemon), by name as listed by fleet_status.",
		inputSchema: object(
			{ daemon: { type: "string", description: "Daemon name.", maxLength: 64 } },
			["daemon"],
		),
		annotations: READ,
	},
	{
		name: "cluster_events",
		group: "observe",
		description:
			"Recent cluster events (starts, stops, crashes, errors, operator actions), newest first, optionally for one instance.",
		inputSchema: object({
			instance: { type: "string", description: "Only events for this instance." },
			limit: { type: "integer", description: "Maximum events (default 30).", minimum: 1, maximum: 200 },
		}),
		annotations: READ,
	},
	{
		name: "plugins_list",
		group: "observe",
		description: "Plugins/mods deployed on one instance with their versions and load state.",
		inputSchema: object({ instance: INSTANCE }, ["instance"]),
		annotations: READ,
		instanceArg: "instance",
	},
	{
		name: "backups_list",
		group: "observe",
		description: "World backups recorded for one instance, newest first.",
		inputSchema: object({ instance: INSTANCE }, ["instance"]),
		annotations: READ,
		instanceArg: "instance",
	},
	{
		name: "schedules_list",
		group: "observe",
		description: "Scheduled start/stop/restart jobs configured on the cluster.",
		inputSchema: object(),
		annotations: READ,
	},
	{
		name: "console_journal",
		group: "observe",
		description:
			"The luna console's own journal (what the control plane did: deploys, sign-ins, daemon events), newest first.",
		inputSchema: object({
			limit: { type: "integer", description: "Maximum entries (default 50).", minimum: 1, maximum: 500 },
			search: { type: "string", description: "Substring filter.", maxLength: 200 },
			level: { type: "string", enum: ["debug", "info", "warn", "error"], description: "This level and above." },
		}),
		annotations: READ,
	},

	// -- control ---------------------------------------------------------------
	{
		name: "instance_start",
		group: "control",
		description: "Start a stopped instance and wait until it is up (or the wait times out).",
		inputSchema: object({ instance: INSTANCE }, ["instance"]),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
		instanceArg: "instance",
	},
	{
		name: "instance_stop",
		group: "control",
		description:
			"Gracefully stop a running instance (players on it are disconnected) and wait until it is down.",
		inputSchema: object({ instance: INSTANCE }, ["instance"]),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
		instanceArg: "instance",
	},
	{
		name: "instance_restart",
		group: "control",
		description: "Restart an instance (players on it are disconnected) and wait until it is back up.",
		inputSchema: object({ instance: INSTANCE }, ["instance"]),
		annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
		instanceArg: "instance",
	},
	{
		name: "instance_command",
		group: "control",
		description:
			"Type one command into an instance's server console, exactly as an operator would (no leading slash). Returns once the command is sent; read instance_logs afterwards for its output.",
		inputSchema: object(
			{
				instance: INSTANCE,
				command: { type: "string", description: "The console command. Any length: long lines (a /give with full item components) are pasted rather than typed.", maxLength: 32000 },
			},
			["instance", "command"],
		),
		annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
		instanceArg: "instance",
	},
	{
		name: "broadcast",
		group: "control",
		description: "Broadcast a chat message to every player on the network, or to one backend.",
		inputSchema: object(
			{
				message: { type: "string", description: "The message (MiniMessage formatting allowed).", maxLength: 500 },
				instance: { type: "string", description: "Only players on this backend." },
			},
			["message"],
		),
		annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
	},

	// -- config ----------------------------------------------------------------
	{
		name: "env_list",
		group: "config",
		description:
			"Environment variables defined for the cluster (global, per machine, per instance). Secret values are always masked.",
		inputSchema: object({
			instance: { type: "string", description: "Only variables set on this instance's scope." },
		}),
		annotations: READ,
	},
	{
		name: "env_set",
		group: "config",
		description:
			"Set a non-secret environment variable at global scope or on one instance. Takes effect on the instance's next start.",
		inputSchema: object(
			{
				name: { type: "string", description: "UPPER_SNAKE_CASE variable name.", maxLength: 128 },
				value: { type: "string", description: "The value.", maxLength: 4096 },
				instance: { type: "string", description: "Instance scope; omit for global." },
			},
			["name", "value"],
		),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
		instanceArg: "instance",
	},
	{
		name: "env_unset",
		group: "config",
		description: "Remove a non-secret environment variable from global scope or from one instance.",
		inputSchema: object(
			{
				name: { type: "string", description: "Variable name.", maxLength: 128 },
				instance: { type: "string", description: "Instance scope; omit for global." },
			},
			["name"],
		),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
		instanceArg: "instance",
	},
	{
		name: "settings_get",
		group: "config",
		description: "Read an instance's server.properties values.",
		inputSchema: object({ instance: INSTANCE }, ["instance"]),
		annotations: READ,
		instanceArg: "instance",
	},

	// -- files (read) ------------------------------------------------------------
	{
		name: "file_list",
		group: "files",
		description: "List one directory inside an instance's server folder (not recursive). Paths are relative to the instance root, e.g. \"plugins/LuckPerms\".",
		inputSchema: object(
			{
				instance: INSTANCE,
				path: { type: "string", description: "Directory relative to the instance root; empty for the root.", maxLength: 1024 },
			},
			["instance"],
		),
		annotations: READ,
		instanceArg: "instance",
	},
	{
		name: "file_read",
		group: "files",
		description: "Read a text file inside an instance (configs, logs, scripts). Files over 512 KB and binary files are refused; use offset/limit to page through long files by line.",
		inputSchema: object(
			{
				instance: INSTANCE,
				path: { type: "string", description: "File path relative to the instance root.", maxLength: 1024 },
				offset: { type: "integer", description: "First line to return, 1-based (default 1).", minimum: 1 },
				limit: { type: "integer", description: "Most lines to return (default 400).", minimum: 1, maximum: 5000 },
			},
			["instance", "path"],
		),
		annotations: READ,
		instanceArg: "instance",
	},
	{
		name: "file_stat",
		group: "files",
		description: "Whether a path exists inside an instance, and its kind, size and modification time.",
		inputSchema: object(
			{
				instance: INSTANCE,
				path: { type: "string", description: "Path relative to the instance root.", maxLength: 1024 },
			},
			["instance", "path"],
		),
		annotations: READ,
		instanceArg: "instance",
	},
	{
		name: "file_find",
		group: "files",
		description: "Find files or directories by name below a directory of an instance. `name` is a case-insensitive substring, or a pattern with * wildcards. World region data is skipped.",
		inputSchema: object(
			{
				instance: INSTANCE,
				path: { type: "string", description: "Directory to search from (default the instance root).", maxLength: 1024 },
				name: { type: "string", description: "Name substring or * pattern, e.g. \"config.yml\" or \"*.jar\".", maxLength: 200 },
				depth: { type: "integer", description: "How many levels to descend (default 4, max 8).", minimum: 0, maximum: 8 },
				limit: { type: "integer", description: "Most results (default 100, max 500).", minimum: 1, maximum: 500 },
			},
			["instance"],
		),
		annotations: READ,
		instanceArg: "instance",
	},

	// -- files (write) -----------------------------------------------------------
	{
		name: "file_write",
		group: "files-write",
		description: "Write a text file inside an instance, replacing its contents (parent folders are created). At most 512 KB. A file luna manages as a template is written as the new template. Most configs only apply after the server restarts or reloads.",
		inputSchema: object(
			{
				instance: INSTANCE,
				path: { type: "string", description: "File path relative to the instance root.", maxLength: 1024 },
				content: { type: "string", description: "The complete new file contents." },
				createOnly: { type: "boolean", description: "Refuse if the file already exists." },
			},
			["instance", "path", "content"],
		),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
		instanceArg: "instance",
	},
	{
		name: "file_mkdir",
		group: "files-write",
		description: "Create a directory (and missing parents) inside an instance.",
		inputSchema: object(
			{
				instance: INSTANCE,
				path: { type: "string", description: "Directory path relative to the instance root.", maxLength: 1024 },
			},
			["instance", "path"],
		),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
		instanceArg: "instance",
	},
	{
		name: "file_copy",
		group: "files-write",
		description: "Copy a file or a whole directory to another path in the same instance.",
		inputSchema: object(
			{
				instance: INSTANCE,
				from: { type: "string", description: "Source path relative to the instance root.", maxLength: 1024 },
				to: { type: "string", description: "Target path relative to the instance root.", maxLength: 1024 },
				overwrite: { type: "boolean", description: "Replace an existing target (default false)." },
			},
			["instance", "from", "to"],
		),
		annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
		instanceArg: "instance",
	},
	{
		name: "file_move",
		group: "files-write",
		description: "Move or rename a file or directory within the same instance.",
		inputSchema: object(
			{
				instance: INSTANCE,
				from: { type: "string", description: "Source path relative to the instance root.", maxLength: 1024 },
				to: { type: "string", description: "Target path relative to the instance root.", maxLength: 1024 },
				overwrite: { type: "boolean", description: "Replace an existing target (default false)." },
			},
			["instance", "from", "to"],
		),
		annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
		instanceArg: "instance",
	},
	{
		name: "file_delete",
		group: "files-write",
		description: "Delete a file or directory inside an instance. A non-empty directory needs recursive=true. There is no undo; prefer file_move into a backup name when unsure.",
		inputSchema: object(
			{
				instance: INSTANCE,
				path: { type: "string", description: "Path relative to the instance root.", maxLength: 1024 },
				recursive: { type: "boolean", description: "Allow deleting a non-empty directory." },
			},
			["instance", "path"],
		),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
		instanceArg: "instance",
	},

	// -- shells ------------------------------------------------------------------
	{
		name: "luna_shell",
		group: "shell",
		description: "Run one luna CLI command, exactly as an operator would at the terminal, and return its output. Pass the words after \"luna\" as args, e.g. [\"plugins\", \"--instance\", \"survival\"] or [\"instance\", \"restart\", \"lobby\", \"--yes\"]. Commands that ask for confirmation need --yes, since there is no one to answer. Run [\"help\"] to see the commands. Account, MCP, setup, daemon upgrade/token and secret-revealing commands are refused.",
		inputSchema: object(
			{
				args: { type: "array", items: { type: "string", maxLength: 1000 }, description: "The command words after \"luna\"." },
				timeoutSeconds: { type: "integer", description: "Kill the command after this long (default 120, max 600).", minimum: 1, maximum: 600 },
			},
			["args"],
		),
		annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
	},
	{
		name: "shell_bash",
		group: "host-shell",
		description: "Run a bash command on the machine that hosts an instance, in that instance's folder (or in the cluster root on the primary when no instance is given). Runs as the luna service user with a minimal environment. Only works on machines whose operator enabled it. Output is capped at 64 KB per stream.",
		inputSchema: object(
			{
				command: { type: "string", description: "The bash command line.", maxLength: 8192 },
				instance: { type: "string", description: "Run on this instance's machine, in its folder." },
				timeoutSeconds: { type: "integer", description: "Kill the command after this long (default 60, max 600).", minimum: 1, maximum: 600 },
			},
			["command"],
		),
		annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
		instanceArg: "instance",
	},

	// -- addons ----------------------------------------------------------------
	{
		name: "addons_list",
		group: "addons",
		description: "Every addon (plugin or mod) in the cluster's pool: one row per lock entry with its family, source, installed version, targets, auto-update and channel. Use plugins_list for what one instance actually loads.",
		inputSchema: object({
			kind: { type: "string", description: "Only plugins or only mods.", enum: ["plugins", "mods"] },
			search: { type: "string", description: "Case-insensitive filter on the name.", maxLength: 80 },
		}),
		annotations: READ,
	},
	{
		name: "addon_info",
		group: "addons",
		description: "Everything about one addon: each family build, its pooled versions and variants, version pins, targets and where it is deployed, with the instances it fits.",
		inputSchema: object({ name: { type: "string", description: "Plugin name or lock entry key.", maxLength: 160 } }, ["name"]),
		annotations: READ,
	},
	{
		name: "addon_search",
		group: "addons",
		description: "Search a provider for addons to install. Mods and plugins are separate project types upstream, so the family decides what comes back.",
		inputSchema: object(
			{
				query: { type: "string", description: "Search text.", maxLength: 120 },
				family: FAMILY,
				provider: PROVIDER,
			},
			["query", "family"],
		),
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	{
		name: "addon_versions",
		group: "addons",
		description: "Builds a provider offers for an addon, newest first, each marked compatible or not with one instance's Minecraft version. Give either name (a pooled addon) or provider+slug+family (one not installed yet).",
		inputSchema: object(
			{
				instance: INSTANCE,
				name: { type: "string", description: "Pooled addon: plugin name or lock entry key.", maxLength: 160 },
				provider: PROVIDER,
				slug: { type: "string", description: "Provider project slug or id.", maxLength: 120 },
				family: FAMILY,
			},
			["instance"],
		),
		annotations: { readOnlyHint: true, openWorldHint: true },
		instanceArg: "instance",
	},
	{
		name: "addon_check_updates",
		group: "addons",
		description: "Ask the providers what an update would change, downloading nothing: per addon, the version each group of targets would move to, plus holdbacks and pins. Can take a while for the whole pool.",
		inputSchema: object({
			names: { type: "array", description: "Lock entry keys to check; omit for every addon.", items: { type: "string", maxLength: 160 } },
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
	},

	// -- addons (write) ----------------------------------------------------------
	{
		name: "addon_install",
		group: "addons-write",
		description: "Install an addon from a provider into the pool and deploy it to its targets. The newest build compatible with each target is chosen per instance. Running servers need a restart to load it.",
		inputSchema: object(
			{
				slug: { type: "string", description: "Provider project slug or id, from addon_search.", maxLength: 120 },
				family: FAMILY,
				provider: PROVIDER,
				targets: TARGETS,
				channel: CHANNEL,
			},
			["slug", "family", "targets"],
		),
		annotations: ADDON_WRITE,
	},
	{
		name: "addon_install_url",
		group: "addons-write",
		description: "Download an addon jar from a public http(s) URL (a GitHub release asset, a CI build, a Discord attachment) into the pool and deploy it. The name and family are read from the jar itself unless given. Uploaded jars never auto-update.",
		inputSchema: object(
			{
				url: { type: "string", description: "Direct link to the .jar file.", maxLength: 2048 },
				plugin: { type: "string", description: "Pool name to use instead of the one the jar declares (lowercase, dashes).", maxLength: 64 },
				family: FAMILY,
				targets: TARGETS,
			},
			["url", "targets"],
		),
		annotations: ADDON_WRITE,
	},
	{
		name: "addon_install_upload",
		group: "addons-write",
		description: "Install an addon jar the operator attached in the console's chat panel (an <attachment id=...> in their message) into the pool and deploy it. The name and family are read from the jar itself unless given.",
		inputSchema: object(
			{
				upload: { type: "string", description: "The attachment id from the message.", maxLength: 80 },
				plugin: { type: "string", description: "Pool name to use instead of the one the jar declares.", maxLength: 64 },
				family: FAMILY,
				targets: TARGETS,
			},
			["upload", "targets"],
		),
		annotations: ADDON_WRITE,
	},
	{
		name: "addon_configure",
		group: "addons-write",
		description: "Change an addon's targets (where it is deployed), auto-update or release channel, then redeploy it. Narrowing targets removes the jar from instances no longer listed.",
		inputSchema: object(
			{
				name: ADDON,
				targets: TARGETS,
				autoUpdate: { type: "boolean", description: "Whether update sweeps may move it to newer builds." },
				channel: CHANNEL,
			},
			["name"],
		),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
	},
	{
		name: "addon_update",
		group: "addons-write",
		description: "Download the newer builds addon_check_updates reported and, unless deploy is false, deploy them. Never moves an instance backwards or past its channel. Running servers need a restart to load new jars.",
		inputSchema: object({
			names: { type: "array", description: "Lock entry keys to update; omit for every auto-updating addon.", items: { type: "string", maxLength: 160 } },
			deploy: { type: "boolean", description: "Deploy after downloading (default true)." },
		}),
		annotations: ADDON_WRITE,
	},
	{
		name: "addon_pin",
		group: "addons-write",
		description: "Pin an addon to one provider version on some instances (it then stays there through updates), downloading that build if needed, and redeploy.",
		inputSchema: object(
			{
				name: ADDON,
				version: { type: "string", description: "Version number or id, from addon_versions.", maxLength: 120 },
				targets: { type: "array", description: "Instances the pin applies to.", items: { type: "string", maxLength: 80 } },
				force: { type: "boolean", description: "Pin even where the build does not declare the instance's Minecraft version." },
			},
			["name", "version", "targets"],
		),
		annotations: ADDON_WRITE,
	},
	{
		name: "addon_unpin",
		group: "addons-write",
		description: "Remove version pins so the addon follows updates again, then redeploy.",
		inputSchema: object(
			{
				name: ADDON,
				targets: { type: "array", description: "Instances to unpin; omit for all.", items: { type: "string", maxLength: 80 } },
			},
			["name"],
		),
		annotations: ADDON_WRITE,
	},
	{
		name: "addon_deploy",
		group: "addons-write",
		description: "Copy pooled addons into instance folders so each instance holds exactly what the lock says. Reports what changed and which running instances need a restart.",
		inputSchema: object({
			instances: { type: "array", description: "Only these instances; omit for all.", items: { type: "string", maxLength: 80 } },
			name: ADDON,
		}),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
	},
	{
		name: "addon_remove",
		group: "addons-write",
		description: "Remove an addon from some instances, or from all of them, deleting its jar from their folders; removed from every target, it leaves the pool too. Its config folders are kept.",
		inputSchema: object(
			{
				name: ADDON,
				from: { type: "array", description: "Instances to remove it from; omit to remove it everywhere and drop it from the pool.", items: { type: "string", maxLength: 80 } },
			},
			["name"],
		),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
	},

	{
		name: "modpack_search",
		group: "addons",
		description: "Search Modrinth for modpacks luna can host as a server (neoforge, forge or fabric packs). A modpack provisions a whole new instance; it is not installed onto an existing one.",
		inputSchema: object(
			{
				query: { type: "string", description: "What to search for.", maxLength: 120 },
				loader: { type: "string", description: "Only packs on this loader.", enum: ["neoforge", "forge", "fabric"] },
			},
			["query"],
		),
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	{
		name: "modpack_versions",
		group: "addons",
		description: "Published versions of a Modrinth modpack, newest first, with the Minecraft version and loader each one runs on. Versions marked not runnable need a loader luna cannot host (quilt).",
		inputSchema: object({ slug: { type: "string", description: "Modrinth project slug or id, from modpack_search.", maxLength: 120 } }, ["slug"]),
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	{
		name: "modpack_install",
		group: "addons-write",
		description: "Create a new instance from a Modrinth modpack: installs the server the pack calls for (loader, Minecraft version), downloads every server-side file the pack lists, applies its overrides, registers it with velocity and deploys luna's own addons. Takes minutes; the call waits up to ten and otherwise reports the job still running. The new server is left stopped; start it with instance_start and read its log.",
		inputSchema: object(
			{
				name: { type: "string", description: "Name of the new instance (lowercase letters, digits, - and _).", maxLength: 40 },
				slug: { type: "string", description: "Modrinth project slug or id.", maxLength: 120 },
				version: { type: "string", description: "Version id or number from modpack_versions; omit for the newest stable build luna can run.", maxLength: 80 },
				memory: { type: "string", description: "JVM heap such as \"8G\" (default 6G; modpacks need more than a plain server).", maxLength: 8 },
				machine: { type: "string", description: "Daemon name to create it on, as fleet_status lists them; omit for the primary.", maxLength: 80 },
				port: { type: "integer", description: "Game port; omit to take the next free one.", minimum: 1, maximum: 65535 },
				profile: { type: "string", description: "Java profile name; omit for the default.", maxLength: 40 },
				register: { type: "boolean", description: "Register with velocity so players can reach it (default true)." },
				skipOptional: { type: "boolean", description: "Leave out files the pack marks optional on the server." },
			},
			["name", "slug"],
		),
		annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
	},
	{
		name: "modpack_update",
		group: "addons-write",
		description: "Move an instance created from a modpack to another version of that pack: changes the server version when the pack did, replaces the pack's files and removes the ones the previous version wrote that the new one does not. The instance must be stopped. Files the operators added by hand are kept.",
		inputSchema: object(
			{
				instance: INSTANCE,
				version: { type: "string", description: "Version id or number; omit for the newest stable build.", maxLength: 80 },
				force: { type: "boolean", description: "Reinstall even when already on that version." },
				skipOptional: { type: "boolean", description: "Leave out files the pack marks optional on the server." },
			},
			["instance"],
		),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
		instanceArg: "instance",
	},

	// -- network ---------------------------------------------------------------
	{
		name: "server_menu_list",
		group: "network",
		description: "The /servers menu (LunaCore's server selector on the proxy): every server's display name, accent colour, icon, description lines, page and slot, whether it is listed on the public page, plus whether the applied menu has drifted from the registry and any validation issues. Unplaced servers are not in the menu.",
		inputSchema: object(),
		annotations: READ,
	},
	{
		name: "proxy_registrations",
		group: "network",
		description: "How velocity routes players: each instance's registration (registered, try-list priority, forced hostnames), the server list luna wants in velocity.toml next to what is on disk, and whether a sync is pending.",
		inputSchema: object(),
		annotations: READ,
	},
	{
		name: "ports_list",
		group: "network",
		description: "Every port the cluster allocates (game ports, plugin ports such as voice chat or web maps), per machine, with whether it is listening, which pool it belongs to, pool usage, and audit findings (duplicates, config drift, velocity mismatches).",
		inputSchema: object({
			machine: { type: "string", description: "Only this machine, by daemon name as fleet_status lists it.", maxLength: 80 },
		}),
		annotations: READ,
	},
	{
		name: "port_check",
		group: "network",
		description: "Whether a port number is free to use on a machine, and which pool it falls in. Ports are per machine: the same number may be taken on one machine and free on another.",
		inputSchema: object(
			{
				port: { type: "integer", description: "The port number.", minimum: 1, maximum: 65535 },
				machine: { type: "string", description: "Daemon name; omit for the primary.", maxLength: 80 },
				protocol: { type: "string", description: "tcp (default) or udp.", enum: ["tcp", "udp"] },
			},
			["port"],
		),
		annotations: READ,
	},

	// -- network-write ---------------------------------------------------------
	{
		name: "server_menu_set",
		group: "network-write",
		description: "Edit one server's entry in the /servers menu and save it. Only the fields given change; set placed to false to take the server out of the menu. Text accepts MiniMessage. Nothing reaches players until server_menu_apply.",
		inputSchema: object(
			{
				instance: INSTANCE,
				displayName: { type: "string", description: "Name shown on the item.", maxLength: 120 },
				accentColor: { type: "string", description: "Hex colour such as \"#25EED0\".", maxLength: 16 },
				icon: { type: "string", description: "Bukkit material name of the item, e.g. GRASS_BLOCK, LANTERN.", maxLength: 64 },
				description: { type: "array", description: "Lore lines under the name; replaces the current lines.", items: { type: "string", maxLength: 300 } },
				placed: { type: "boolean", description: "false removes the server from the menu grid; true (or giving page/slot) places it." },
				page: { type: "integer", description: "1-based menu page.", minimum: 1, maximum: 20 },
				slot: { type: "integer", description: "Slot 0-44 in the 9x5 grid (row-major).", minimum: 0, maximum: 44 },
				glint: { type: "boolean", description: "Enchantment glint on the item." },
				permission: { type: "string", description: "Permission node needed to see the server; empty clears it.", maxLength: 120 },
				publicListed: { type: "boolean", description: "Show the server on the public web page." },
			},
			["instance"],
		),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
	{
		name: "server_menu_apply",
		group: "network-write",
		description: "Write the saved menu to the proxy (LunaCore's servers.yml) and reload LunaCore so players see it. Refused while the menu has validation errors; fix them with server_menu_set first.",
		inputSchema: object(),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
	{
		name: "proxy_register",
		group: "network-write",
		description: "Change how velocity routes to one instance: register or unregister it, put it in or take it out of the try list (where players land on join, lowest priority first), and set the hostnames that connect straight to it. Then rewrites velocity.toml and reloads velocity.",
		inputSchema: object(
			{
				instance: INSTANCE,
				register: { type: "boolean", description: "Whether velocity knows this server at all." },
				priority: { type: "integer", description: "Try-list priority (lower is tried first).", minimum: 0, maximum: 9999 },
				tryList: { type: "boolean", description: "false takes the server out of the try list." },
				forcedHosts: { type: "array", description: "Hostnames that connect straight to this server, e.g. \"create.belikhun.dev\"; replaces the current list, empty clears it.", items: { type: "string", maxLength: 253 } },
				reload: { type: "boolean", description: "Reload velocity afterwards (default true)." },
			},
			["instance"],
		),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
	{
		name: "proxy_sync",
		group: "network-write",
		description: "Rewrite velocity.toml's server list from the registry and reload velocity. Needed after creating a server, since velocity does not learn new servers on its own.",
		inputSchema: object({
			reload: { type: "boolean", description: "Reload velocity even when the file was already in sync (default true)." },
		}),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
	{
		name: "ports_fix",
		group: "network-write",
		description: "Re-allocate every plugin port from its pool and rewrite the plugins' config files to match, then report the remaining audit findings. Servers need a restart to bind a moved port.",
		inputSchema: object(),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
	{
		name: "instance_set_port",
		group: "network-write",
		description: "Move an instance to another game port: checked against that machine's allocations, written to its server config, and synced into velocity.toml. The server needs a restart to bind it.",
		inputSchema: object(
			{
				instance: INSTANCE,
				port: { type: "integer", description: "The new port.", minimum: 1, maximum: 65535 },
			},
			["instance", "port"],
		),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
		instanceArg: "instance",
	},

	// -- packs -----------------------------------------------------------------
	{
		name: "respacks_list",
		group: "packs",
		description: "Every resource pack luna-pack serves: key, display name, priority, required or optional, enabled, the servers it is sent on, file size, source and version, whether a plugin registers it at runtime, and auto-update settings.",
		inputSchema: object(),
		annotations: READ,
	},
	{
		name: "datapacks_list",
		group: "packs",
		description: "Every data pack in the pool: source and version, targets (the worlds it is deployed into), whether the file is present, and auto-update settings.",
		inputSchema: object(),
		annotations: READ,
	},
	{
		name: "pack_search",
		group: "packs",
		description: "Search a provider for resource packs or data packs to install.",
		inputSchema: object(
			{
				kind: { type: "string", description: "resourcepack or datapack.", enum: ["resourcepack", "datapack"] },
				query: { type: "string", description: "What to search for.", maxLength: 120 },
				provider: PROVIDER,
			},
			["kind", "query"],
		),
		annotations: { readOnlyHint: true, openWorldHint: true },
	},
	{
		name: "pack_check_updates",
		group: "packs",
		description: "Ask the providers which resource packs or data packs have newer versions, downloading nothing.",
		inputSchema: object(
			{
				kind: { type: "string", description: "resourcepack or datapack.", enum: ["resourcepack", "datapack"] },
				names: { type: "array", description: "Only these packs; omit for all.", items: { type: "string", maxLength: 120 } },
			},
			["kind"],
		),
		annotations: { readOnlyHint: true, openWorldHint: true },
	},

	// -- packs-write -----------------------------------------------------------
	{
		name: "respack_install",
		group: "packs-write",
		description: "Install a resource pack from a provider. A new pack starts disabled and sent on every server unless enabled/servers say otherwise. Players get it on their next join, or now with respack_push.",
		inputSchema: object(
			{
				slug: { type: "string", description: "Provider project slug or id, from pack_search.", maxLength: 120 },
				provider: PROVIDER,
				channel: CHANNEL,
				...RESPACK_REGISTRATION,
			},
			["slug"],
		),
		annotations: ADDON_WRITE,
	},
	{
		name: "respack_install_upload",
		group: "packs-write",
		description: "Install a resource pack zip the operator attached in the console's chat panel (an <attachment id=...>), or replace an existing pack's zip with it. Replacing reloads the proxy so the new hash is served; run respack_push to make players already holding the old one download it.",
		inputSchema: object(
			{
				upload: { type: "string", description: "The attachment id from the message.", maxLength: 80 },
				name: { type: "string", description: "Pack key for a new pack (lowercase, dashes); defaults to the file name.", maxLength: 64 },
				replace: { type: "string", description: "Key of an existing pack whose zip this replaces.", maxLength: 120 },
				...RESPACK_REGISTRATION,
			},
			["upload"],
		),
		annotations: ADDON_WRITE,
	},
	{
		name: "respack_configure",
		group: "packs-write",
		description: "Change a resource pack's registration: display name, priority (higher loads on top), required, enabled, the servers it is sent on, auto-update and channel.",
		inputSchema: object(
			{
				key: { type: "string", description: "Pack key, from respacks_list.", maxLength: 120 },
				name: { type: "string", description: "Display name.", maxLength: 120 },
				priority: { type: "integer", description: "Higher priority loads on top of lower.", minimum: -1000, maximum: 1000 },
				required: { type: "boolean", description: "Players must accept it to stay." },
				enabled: { type: "boolean" },
				servers: { type: "array", description: "Servers it is sent on; \"*\" means all. Replaces the current list.", items: { type: "string", maxLength: 80 } },
				autoUpdate: { type: "boolean" },
				channel: CHANNEL,
			},
			["key"],
		),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
	{
		name: "respack_update",
		group: "packs-write",
		description: "Download the newer resource pack versions pack_check_updates reported over the pack files, then reload the proxy. Run respack_push afterwards so players already holding a pack get the new bytes.",
		inputSchema: object({
			names: { type: "array", description: "Only these packs; omit for every pack with an update.", items: { type: "string", maxLength: 120 } },
		}),
		annotations: ADDON_WRITE,
	},
	{
		name: "respack_push",
		group: "packs-write",
		description: "Make online players download a changed resource pack now. Reloads the proxy (so it re-hashes the zip), then force-reloads the pack for each online player on the servers it is sent to. A plain resend would skip anyone who already holds a pack of that name.",
		inputSchema: object(
			{
				key: { type: "string", description: "Pack key, from respacks_list.", maxLength: 120 },
				players: { type: "array", description: "Only these players; omit for everyone online on the pack's servers.", items: { type: "string", maxLength: 32 } },
			},
			["key"],
		),
		annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
	},
	{
		name: "respack_remove",
		group: "packs-write",
		description: "Unregister a resource pack and delete its zip (or keep the file).",
		inputSchema: object(
			{
				key: { type: "string", description: "Pack key, from respacks_list.", maxLength: 120 },
				keepFile: { type: "boolean", description: "Keep the zip in the packs folder." },
			},
			["key"],
		),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
	},
	{
		name: "datapack_install",
		group: "packs-write",
		description: "Install a data pack from a provider into the pool and deploy it into the target instances' worlds. Run `reload` on a running server (instance_command) to load it; a few packs need a restart.",
		inputSchema: object(
			{
				slug: { type: "string", description: "Provider project slug or id, from pack_search.", maxLength: 120 },
				provider: PROVIDER,
				targets: { type: "array", description: "Instances whose worlds get it.", items: { type: "string", maxLength: 80 } },
				channel: CHANNEL,
			},
			["slug", "targets"],
		),
		annotations: ADDON_WRITE,
	},
	{
		name: "datapack_install_upload",
		group: "packs-write",
		description: "Install a data pack zip the operator attached in the console's chat panel (an <attachment id=...>) into the pool, or replace a pooled pack's file, and deploy it.",
		inputSchema: object(
			{
				upload: { type: "string", description: "The attachment id from the message.", maxLength: 80 },
				name: { type: "string", description: "Pool name; defaults to the file name. Naming an existing pack replaces its file.", maxLength: 64 },
				targets: { type: "array", description: "Instances whose worlds get it (new packs).", items: { type: "string", maxLength: 80 } },
			},
			["upload"],
		),
		annotations: ADDON_WRITE,
	},
	{
		name: "datapack_configure",
		group: "packs-write",
		description: "Change a data pack's targets (deploying or removing world copies to match), auto-update or channel.",
		inputSchema: object(
			{
				name: { type: "string", description: "Data pack name, from datapacks_list.", maxLength: 120 },
				targets: { type: "array", description: "Instances whose worlds get it; replaces the current list.", items: { type: "string", maxLength: 80 } },
				autoUpdate: { type: "boolean" },
				channel: CHANNEL,
			},
			["name"],
		),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
	},
	{
		name: "datapack_update",
		group: "packs-write",
		description: "Download the newer data pack versions pack_check_updates reported and redeploy them. Running servers need `reload` to load them.",
		inputSchema: object({
			names: { type: "array", description: "Only these packs; omit for every pack with an update.", items: { type: "string", maxLength: 120 } },
		}),
		annotations: ADDON_WRITE,
	},
	{
		name: "datapack_remove",
		group: "packs-write",
		description: "Remove a data pack from some worlds, or from every world and the pool.",
		inputSchema: object(
			{
				name: { type: "string", description: "Data pack name, from datapacks_list.", maxLength: 120 },
				from: { type: "array", description: "Instances to remove it from; omit to remove it everywhere and drop it from the pool.", items: { type: "string", maxLength: 80 } },
			},
			["name"],
		),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
	},

	// -- knowledge -------------------------------------------------------------
	{
		name: "memory_search",
		group: "knowledge",
		description:
			"Search the operators' saved memories about this cluster (facts, procedures, past incidents). Returns the best matches first.",
		inputSchema: object(
			{
				query: { type: "string", description: "What to look for.", maxLength: 500 },
				limit: { type: "integer", description: "Maximum results (default 8).", minimum: 1, maximum: 50 },
			},
			["query"],
		),
		annotations: READ,
	},
	{
		name: "skill_list",
		group: "knowledge",
		description:
			"List the skills (named step-by-step procedures written by the operators) available to you, with a one-line description each.",
		inputSchema: object(),
		annotations: READ,
	},
	{
		name: "skill_get",
		group: "knowledge",
		description: "Read the full body of one skill by name. Follow it when the task matches its description.",
		inputSchema: object(
			{ name: { type: "string", description: "Skill name from skill_list.", maxLength: 128 } },
			["name"],
		),
		annotations: READ,
	},
	{
		name: "context_get",
		group: "knowledge",
		description: "Read the standing context documents the operators wrote for you (cluster layout, conventions, rules).",
		inputSchema: object(),
		annotations: READ,
	},

	// -- knowledge-write -------------------------------------------------------
	{
		name: "memory_save",
		group: "knowledge-write",
		description:
			"Save a memory for later: a durable fact or lesson about the cluster worth recalling in future conversations. Keep it short and self-contained.",
		inputSchema: object(
			{
				title: { type: "string", description: "A short title.", maxLength: 120 },
				body: { type: "string", description: "The memory itself.", maxLength: 8000 },
				tags: { type: "array", items: { type: "string", maxLength: 40 }, description: "Optional tags." },
			},
			["title", "body"],
		),
		annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
	},
	{
		name: "memory_update",
		group: "knowledge-write",
		description: "Correct or extend a memory you are allowed to edit, by id from memory_search.",
		inputSchema: object(
			{
				id: { type: "string", description: "Memory id.", maxLength: 64 },
				title: { type: "string", maxLength: 120 },
				body: { type: "string", maxLength: 8000 },
				tags: { type: "array", items: { type: "string", maxLength: 40 } },
			},
			["id"],
		),
		annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
	},
	{
		name: "memory_forget",
		group: "knowledge-write",
		description: "Delete a memory that is wrong or obsolete, by id from memory_search.",
		inputSchema: object({ id: { type: "string", description: "Memory id.", maxLength: 64 } }, ["id"]),
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
	},
];

/** First words of luna commands `luna_shell` refuses: credentials, MCP itself, installation, interactive ones. */
const LUNA_SHELL_DENIED = new Set(["mcp", "account", "accounts", "sessions", "audit", "setup", "web", "console", "shell", "repl"]);

/** `luna daemon` subcommands `luna_shell` refuses: upgrades, the cluster token, unregistering, the service unit. */
const LUNA_SHELL_DENIED_DAEMON = new Set(["upgrade", "token", "remove", "service", "run"]);

/**
 * Why `luna_shell` refuses a command, or null when it may run. A token reaching
 * the CLI must not mint itself wider access (`mcp`, `account`), read credentials
 * (`--reveal`, `daemon token`), or reinstall the machine it runs on.
 */
export function lunaShellRefusal(args: string[]): string | null {
	const words = args.map((word) => word.trim()).filter((word) => word !== "");
	const first = words[0]?.toLowerCase();

	if (!first) {
		return "no command given";
	}

	if (LUNA_SHELL_DENIED.has(first)) {
		return `"luna ${first}" is not available over MCP`;
	}

	if (first === "daemon" && LUNA_SHELL_DENIED_DAEMON.has(words[1]?.toLowerCase() ?? "")) {
		return `"luna daemon ${words[1]}" is not available over MCP`;
	}

	if (words.some((word) => word === "--reveal" || word.startsWith("--reveal="))) {
		return "revealing secrets is not available over MCP";
	}

	return null;
}

/** One tool's spec, or undefined for a name the catalog does not know. */
export function mcpTool(name: string): McpToolSpec | undefined {
	return MCP_TOOLS.find((tool) => tool.name === name);
}

/** A fresh scope at the defaults; what a new token starts with. */
export function defaultMcpScope(): McpScope {
	return { groups: [...MCP_DEFAULT_GROUPS], allow: [], deny: [], instances: null };
}

/**
 * The tools a scope resolves to, in catalog order: every tool of a granted group,
 * plus explicit allows, minus explicit denies. Denies win so that "everything in
 * control except instance_command" is expressible.
 */
export function allowedTools(scope: McpScope): McpToolSpec[] {
	return MCP_TOOLS.filter((tool) => {
		if (scope.deny.includes(tool.name)) {
			return false;
		}

		return scope.groups.includes(tool.group) || scope.allow.includes(tool.name);
	});
}

/** Whether a scope may touch an instance. */
export function scopeCoversInstance(scope: McpScope, instance: string): boolean {
	return scope.instances === null || scope.instances.includes(instance);
}

/**
 * Validate arguments against a tool's schema. Returns the first problem in words a
 * model can act on, or null when the arguments are acceptable. Only the subset of
 * JSON Schema the catalog actually uses is understood.
 */
export function validateMcpArgs(schema: McpSchema, value: unknown, path = "arguments"): string | null {
	if (schema.type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return `${path} must be an object`;
		}

		const record = value as Record<string, unknown>;

		for (const key of schema.required ?? []) {
			if (record[key] === undefined || record[key] === null) {
				return `${path}.${key} is required`;
			}
		}

		for (const [key, child] of Object.entries(record)) {
			const spec = schema.properties?.[key];

			if (!spec) {
				if (schema.additionalProperties === false) {
					return `${path}.${key} is not a known argument`;
				}

				continue;
			}

			if (child === undefined || child === null) {
				continue;
			}

			const problem = validateMcpArgs(spec, child, `${path}.${key}`);

			if (problem) {
				return problem;
			}
		}

		return null;
	}

	if (schema.type === "array") {
		if (!Array.isArray(value)) {
			return `${path} must be an array`;
		}

		for (let i = 0; i < value.length; i++) {
			const problem = schema.items ? validateMcpArgs(schema.items, value[i], `${path}[${i}]`) : null;

			if (problem) {
				return problem;
			}
		}

		return null;
	}

	if (schema.type === "string") {
		if (typeof value !== "string") {
			return `${path} must be a string`;
		}

		if (schema.maxLength !== undefined && value.length > schema.maxLength) {
			return `${path} is longer than ${schema.maxLength} characters`;
		}

		if (schema.enum && !schema.enum.includes(value)) {
			return `${path} must be one of ${schema.enum.join(", ")}`;
		}

		return null;
	}

	if (schema.type === "boolean") {
		return typeof value === "boolean"
			? null
			: `${path} must be a boolean`;
	}

	const isNumber = typeof value === "number" && Number.isFinite(value);

	if (!isNumber || (schema.type === "integer" && !Number.isInteger(value))) {
		return `${path} must be ${schema.type === "integer" ? "an integer" : "a number"}`;
	}

	if (schema.minimum !== undefined && value < schema.minimum) {
		return `${path} must be at least ${schema.minimum}`;
	}

	if (schema.maximum !== undefined && value > schema.maximum) {
		return `${path} must be at most ${schema.maximum}`;
	}

	return null;
}
