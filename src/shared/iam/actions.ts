// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The action catalog: every `service:Verb` a policy can name, as data.
 *
 * It is what the route catalog on the web side declares against, what the
 * policy editor offers, what `ReadOnlyAccess` is built from (every `read`
 * action) and what the simulator lists. A new capability in the console is a new
 * entry here before it is a route, exactly as an MCP tool is a catalog entry
 * before it is a handler.
 *
 * What a human reads about an action is the language key
 * `core.iam.actions.<service>.<verb>`; the name itself is protocol text.
 */

/**
 * What an action does to the cluster; `ReadOnlyAccess` is the `read` set.
 *
 * `sensitive` is a read of private data (what players wrote in chat). It is a
 * class of its own so a grant that sounds harmless ("read only", "everything an
 * owner may see") never carries it: only a policy that names it, or
 * `AdministratorAccess`, does.
 */
export type IamAccess = "read" | "sensitive" | "write" | "destructive";

/** The resource types a resource id can name; `null` on an action means it names none. */
export type IamResourceType =
	| "instance"
	| "chat"
	| "machine"
	| "plugin"
	| "pack"
	| "datapack"
	| "addon-group"
	| "runtime"
	| "profile"
	| "port-pool"
	| "domain"
	| "schedule"
	| "env"
	| "player"
	| "permission-group"
	| "account"
	| "group"
	| "policy"
	| "mcp-token"
	| "knowledge"
	| "conversation";

/** Every resource type, in the order the resource explorer offers them. */
export const IAM_RESOURCE_TYPES: IamResourceType[] = [
	"instance",
	"chat",
	"machine",
	"plugin",
	"pack",
	"datapack",
	"addon-group",
	"runtime",
	"profile",
	"port-pool",
	"domain",
	"schedule",
	"env",
	"player",
	"permission-group",
	"account",
	"group",
	"policy",
	"mcp-token",
	"knowledge",
	"conversation",
];

export interface IamActionSpec {
	/** `service:Verb` */
	name: string;
	service: string;
	verb: string;
	access: IamAccess;
	/** The resource type the action is checked against, or null for a cluster-wide action */
	resourceType: IamResourceType | null;
}

type VerbList = Array<[verb: string, access: IamAccess]>;

function service(name: string, resourceType: IamResourceType | null, verbs: VerbList): IamActionSpec[] {
	return verbs.map(([verb, access]) => ({
		name: `${name}:${verb}`,
		service: name,
		verb,
		access,
		resourceType,
	}));
}

/** The catalog, grouped by service in the order the editor lists them. */
export const IAM_ACTIONS: IamActionSpec[] = [
	...service("instance", "instance", [
		["List", "read"],
		["Describe", "read"],
		["ReadConsole", "read"],
		["ReadLogs", "read"],
		["ReadMetrics", "read"],
		["ReadFiles", "read"],
		["Create", "write"],
		["Configure", "write"],
		["Start", "write"],
		["Stop", "write"],
		["Restart", "write"],
		["SendCommand", "write"],
		["WriteFiles", "write"],
		["ManageAddons", "write"],
		["ManageWorld", "write"],
		["ManagePlayers", "write"],
		["ManageEnvironment", "write"],
		["ManageNetwork", "write"],
		["Delete", "destructive"],
	]),
	...service("machine", "machine", [
		["List", "read"],
		["Describe", "read"],
		["Upgrade", "write"],
		["Remove", "destructive"],
	]),
	...service("plugin", "plugin", [
		["List", "read"],
		["Describe", "read"],
		["Install", "write"],
		["Update", "write"],
		["Configure", "write"],
		["Remove", "destructive"],
	]),
	...service("pack", "pack", [
		["List", "read"],
		["Describe", "read"],
		["Install", "write"],
		["Update", "write"],
		["Configure", "write"],
		["Remove", "destructive"],
	]),
	...service("datapack", "datapack", [
		["List", "read"],
		["Describe", "read"],
		["Install", "write"],
		["Update", "write"],
		["Configure", "write"],
		["Remove", "destructive"],
	]),
	...service("addon-group", "addon-group", [
		["List", "read"],
		["Describe", "read"],
		["Create", "write"],
		["Update", "write"],
		["Delete", "destructive"],
	]),
	...service("runtime", "runtime", [
		["List", "read"],
		["Install", "write"],
		["Remove", "destructive"],
	]),
	...service("profile", "profile", [
		["List", "read"],
		["Describe", "read"],
		["Create", "write"],
		["Update", "write"],
		["Delete", "destructive"],
	]),
	...service("network", null, [
		["Describe", "read"],
		["ManageProxy", "write"],
	]),
	...service("port-pool", "port-pool", [
		["List", "read"],
		["Create", "write"],
		["Update", "write"],
		["Delete", "destructive"],
	]),
	...service("domain", "domain", [
		["List", "read"],
		["Describe", "read"],
		["Create", "write"],
		["Link", "write"],
		["ManageRecords", "write"],
		["ConfigureProvider", "write"],
		["Delete", "destructive"],
	]),
	...service("schedule", "schedule", [
		["List", "read"],
		["Describe", "read"],
		["Create", "write"],
		["Update", "write"],
		["Delete", "destructive"],
	]),
	...service("env", "env", [
		["List", "read"],
		["Describe", "read"],
		["Reveal", "read"],
		["Set", "write"],
		["Unset", "destructive"],
	]),
	// putting code on a host by any route but the addon catalog (an uploaded jar,
	// a script, a modpack file, a JVM flag) is its own action, asked for beside the
	// route's normal one, so a policy can hand out every instance verb and still
	// refuse what would let an account run arbitrary code on the machine
	...service("code", "instance", [["Deploy", "destructive"]]),
	// `Moderate` is network-wide moderation; banning on one server is that
	// instance's `instance:ManagePlayers`
	...service("player", "player", [
		["List", "read"],
		["Describe", "read"],
		["Act", "write"],
		["Moderate", "write"],
		["ManagePermissions", "write"],
	]),
	// chat is its own service because it is the cluster's most private data: one
	// server's chat is `luna:chat/<server>`, one player's history is that player,
	// and a server's logs, console and log files carry the same lines, so reading
	// them also asks for `chat:Read` on that server (see the route catalog)
	...service("chat", "chat", [
		["Read", "sensitive"],
		["ReadPlayer", "sensitive"],
	]),
	...service("permission-group", "permission-group", [
		["List", "read"],
		["Describe", "read"],
		["Create", "write"],
		["Update", "write"],
		["Delete", "destructive"],
	]),
	...service("cleanup", null, [
		["Describe", "read"],
		["Run", "destructive"],
	]),
	...service("publicsite", null, [
		["Describe", "read"],
		["Configure", "write"],
	]),
	...service("catalog", null, [["Read", "read"]]),
	...service("event", null, [["Read", "read"]]),
	...service("job", null, [["Describe", "read"]]),
	...service("journal", null, [["Read", "read"]]),
	...service("shell", null, [["Execute", "destructive"]]),
	...service("account", "account", [
		["List", "read"],
		["Describe", "read"],
		["ReadAudit", "read"],
		["Create", "write"],
		["Update", "write"],
		["SetPassword", "write"],
		["ManageIdentities", "write"],
		["ManageSessions", "write"],
		["Delete", "destructive"],
	]),
	...service("iam", null, [
		["ListPolicies", "read"],
		["DescribePolicy", "read"],
		["ListGroups", "read"],
		["DescribeGroup", "read"],
		["Simulate", "read"],
		["ReadAudit", "read"],
		["CreatePolicy", "write"],
		["UpdatePolicy", "write"],
		["CreateGroup", "write"],
		["UpdateGroup", "write"],
		["Attach", "write"],
		["Detach", "write"],
		["DeletePolicy", "destructive"],
		["DeleteGroup", "destructive"],
	]),
	...service("tag", null, [
		["List", "read"],
		["Describe", "read"],
		["Tag", "write"],
		["Untag", "write"],
	]),
	...service("mcp", "mcp-token", [
		["ListTokens", "read"],
		["DescribeToken", "read"],
		["ReadCalls", "read"],
		["ReadAudit", "read"],
		["CreateToken", "write"],
		["UpdateToken", "write"],
		["RotateToken", "write"],
		["DeleteToken", "destructive"],
	]),
	...service("knowledge", "knowledge", [
		["List", "read"],
		["Describe", "read"],
		["Create", "write"],
		["Update", "write"],
		["Delete", "destructive"],
		// writing what every token reads, or pinning into the instructions
		["Publish", "write"],
	]),
	...service("agent", "conversation", [
		["Describe", "read"],
		["Chat", "write"],
		["Configure", "write"],
	]),
];

const byName = new Map(IAM_ACTIONS.map((spec) => [spec.name.toLowerCase(), spec]));

/** Every service name, in catalog order. */
export const IAM_SERVICES: string[] = [...new Set(IAM_ACTIONS.map((spec) => spec.service))];

/** The catalog entry for an action name, matched case-insensitively as the grammar does. */
export function iamAction(name: string): IamActionSpec | undefined {
	return byName.get(name.toLowerCase());
}

/** The actions of one service, in catalog order. */
export function actionsOf(serviceName: string): IamActionSpec[] {
	return IAM_ACTIONS.filter((spec) => spec.service === serviceName);
}

/** Language key for what an action does. */
export function actionLabelKey(spec: IamActionSpec): string {
	return `core.iam.actions.${spec.service}.${spec.verb}`;
}
