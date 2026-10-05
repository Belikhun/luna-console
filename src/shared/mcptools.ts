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
				command: { type: "string", description: "The console command.", maxLength: 700 },
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
