// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What an MCP tool asks of the console's authorization when it runs for a
 * console account.
 *
 * Mèo Béo acts through an MCP token, and the token's scope is what any client
 * holding it may do. A run, though, belongs to one signed-in account, and the
 * agent must never be a way around that account's own policies: so a call made
 * for an account must pass **both** the token's scope and the account's IAM
 * verdict for every action and resource listed here. A tool missing from this
 * table is refused for an account (fail closed), exactly as an API route
 * missing from the route catalog is; `TOOL_IAM_COVERAGE` lets a test say so.
 *
 * Data scope follows the same account: the instances it may not describe are
 * cut from the token's instance allowlist for the call (`accountScope`), which
 * every handler's existing instance check already honours, and the listings of
 * other resource types are filtered with `iamVisible`.
 */

import { authorize, authorizeMany } from '$core/iam';
import { loadCluster } from '$core/config';
import type { KnowledgeItem, McpPrincipal } from '$core/mcp';
import { actionPossible, type PrincipalContext } from '$shared/iam/grammar';
import { resourceId } from '$shared/iam/resources';
import type { IamResourceType } from '$shared/iam/actions';
import { MCP_TOOLS, type McpScope } from '$shared/mcptools';

import type { ToolArgs, ToolContext } from './errors';
import {
	archiveHoldsChat,
	datapackRemovalChecks,
	datapackTargetChecks,
	envIsCode,
	moveTargetIsCode,
	onInstances,
	packRuleTargets,
	pathIsCode,
	pathIsLog,
	pluginRemovalChecks,
	pluginTargetChecks,
	pluginUnpinChecks,
	respackEnableChecks,
	respackServerChecks
} from '$lib/server/authz/routes';
import { packKeyFrom } from '$core/packslock';
import { hiddenInstances } from '$lib/server/fleetscope';

export interface IamCheck {
	action: string;
	resource: string | null;
}

type Rule = (args: ToolArgs) => IamCheck[];

function text(args: ToolArgs, key: string): string | null {
	const value = args[key];

	return typeof value === 'string' && value !== '' ? value : null;
}

function list(args: ToolArgs, key: string): string[] {
	const value = args[key];

	if (Array.isArray(value)) {
		return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
	}

	return typeof value === 'string' && value !== '' ? [value] : [];
}

/** The pack key a name becomes, or '' (a pack not pooled yet) when it makes none. */
function packKey(name: string | null): string {
	try {
		return name
			? packKeyFrom(name)
			: '';
	} catch {
		return '';
	}
}

/** A list argument, or undefined when the call does not carry one. */
function optionalList(args: ToolArgs, key: string): string[] | undefined {
	return Array.isArray(args[key])
		? list(args, key)
		: undefined;
}

function id(type: IamResourceType, name: string | null): string | null {
	return name ? resourceId(type, name) : null;
}

/** A hostname argument may be the label or the full name; the resource is keyed by the label. */
function domainLabel(name: string | null): string | null {
	return name ? (name.split('.')[0] ?? name) : null;
}

/** One action, no resource. */
const plain = (action: string): Rule => () => [{ action, resource: null }];

/** One action on the resource an argument names (none when the argument is absent). */
const on = (action: string, type: IamResourceType, key: string): Rule => (args) => [
	{ action, resource: id(type, text(args, key)) }
];

/** One action on every resource a list argument names, or once without one when it names none. */
const each = (action: string, type: IamResourceType, key: string): Rule => (args) => {
	const names = list(args, key);

	if (names.length === 0) {
		return [{ action, resource: null }];
	}

	return names.map((name) => ({ action, resource: resourceId(type, name) }));
};

/** Several rules at once; every check must pass. */
const all = (...rules: Rule[]): Rule => (args) => rules.flatMap((rule) => rule(args));

/** A rule that applies only when the argument is present. */
const when = (key: string, rule: Rule): Rule => (args) => (args[key] === undefined || args[key] === '' ? [] : rule(args));

const instance = (action: string, key = 'instance'): Rule => on(action, 'instance', key);

/** Reading or copying a log file through a tool also asks for that server's chat. */
const chatIfLog = (pathKey: string, instanceKey: string): Rule => (args) =>
	pathIsLog(text(args, pathKey))
		? [{ action: 'chat:Read', resource: id('chat', text(args, instanceKey)) }]
		: [];

/** Copying a folder that holds logs (the instance root, a logs folder) asks for chat too. */
const chatIfArchive = (pathKey: string, instanceKey: string): Rule => (args) =>
	archiveHoldsChat(text(args, pathKey))
		? [{ action: 'chat:Read', resource: id('chat', text(args, instanceKey)) }]
		: [];

/** `code:Deploy` on the instance, whatever the arguments: a jar or a pack file from bytes or a URL. */
const code = (instanceKey?: string): Rule => (args) => [
	{ action: 'code:Deploy', resource: instanceKey ? id('instance', text(args, instanceKey)) : null }
];

/** Writing a file whose path is code (a jar, a script, the JVM's own argument files). */
const codeIfPath = (pathKey: string, instanceKey = 'instance'): Rule => (args) =>
	pathIsCode(text(args, pathKey))
		? code(instanceKey)(args)
		: [];

/**
 * Copying or moving to a destination that is code, or that carries a folder into
 * a code folder; a `to` ending in "/" lands the source under its own name.
 */
const codeIfMoved = (instanceKey = 'instance'): Rule => (args) => {
	const to = text(args, 'to') ?? '';
	const from = text(args, 'from') ?? '';
	const target = to.endsWith('/')
		? `${to}${from.replace(/\/+$/, '').split('/').pop() ?? ''}`
		: to;

	return moveTargetIsCode(target)
		? code(instanceKey)(args)
		: [];
};

/** A modpack from an attachment or a URL rather than a Modrinth slug. */
const codeIfPackFile = (instanceKey: string): Rule => (args) =>
	text(args, 'upload') !== null || text(args, 'url') !== null
		? code(instanceKey)(args)
		: [];

/** `instance:ManageAddons` on every target a list argument names; a wildcard asks for `luna:instance/*`. */
const addonTargets = (key: string): Rule => (args) => onInstances('instance:ManageAddons', list(args, key));

/**
 * A verb on a shared addon that names the servers it acts on reaches only
 * those: it asks `instance:ManageAddons` on each and to see the addon, which is
 * how the owner of a server manages what runs there. With no servers named it
 * acts on the addon everywhere and asks the addon-wide verb.
 */
const perServer = (wide: string, type: 'plugin' | 'datapack', listKey: string): Rule => (args) => {
	const servers = list(args, listKey);

	if (servers.length === 0) {
		return on(wide, type, 'name')(args);
	}

	return [
		{ action: `${type}:Describe`, resource: id(type, text(args, 'name')) },
		...addonTargets(listKey)(args)
	];
};

/** The same for a resource pack's server rules (`!x` names x, `all` is every server). */
const packServers: Rule = (args) => onInstances('instance:ManageAddons', packRuleTargets(list(args, 'servers')));

export const TOOL_IAM: Record<string, Rule> = {
	cluster_status: plain('instance:List'),
	instance_status: instance('instance:Describe'),
	// a server's logs carry every chat line it printed
	instance_logs: all(instance('instance:ReadLogs'), on('chat:Read', 'chat', 'instance')),
	// rows are kept to the servers the call may reach, so who is online on them is
	// a fact about those servers rather than the network's player directory
	players_online: (args) => text(args, 'instance')
		? instance('instance:Describe')(args)
		: plain('instance:List')(args),
	player_lookup: on('player:Describe', 'player', 'player'),
	player_search: plain('player:List'),
	// chat is checked per server on the lines returned as well (`readableChat`)
	player_chat: all(on('chat:ReadPlayer', 'player', 'player'), when('server', on('chat:Read', 'chat', 'server'))),
	chat_log: (args) => text(args, 'server')
		? on('chat:Read', 'chat', 'server')(args)
		: plain('player:List')(args),
	fleet_status: plain('machine:List'),
	daemon_detail: on('machine:Describe', 'machine', 'daemon'),
	cluster_events: all(plain('event:Read'), when('instance', instance('instance:Describe'))),
	plugins_list: instance('instance:Describe'),
	backups_list: instance('instance:Describe'),
	schedules_list: plain('schedule:List'),
	console_journal: plain('journal:Read'),

	instance_start: instance('instance:Start'),
	instance_stop: instance('instance:Stop'),
	instance_restart: instance('instance:Restart'),
	instance_delete: instance('instance:Delete'),
	instance_command: instance('instance:SendCommand'),
	broadcast: all(plain('player:Act'), when('instance', instance('instance:SendCommand'))),

	player_transfer: all(on('player:Act', 'player', 'player'), instance('instance:Describe', 'server')),
	player_message: on('player:Act', 'player', 'player'),

	// the same actions the console's Moderation page is gated on
	bans_list: plain('player:List'),
	player_kick: on('player:Moderate', 'player', 'player'),
	player_ban: on('player:Moderate', 'player', 'player'),
	player_unban: on('player:Moderate', 'player', 'player'),
	ip_ban: plain('player:Moderate'),
	ip_unban: plain('player:Moderate'),

	env_list: all(plain('env:List'), when('instance', instance('instance:Describe'))),
	env_set: all(
		on('env:Set', 'env', 'name'),
		when('instance', instance('instance:ManageEnvironment')),
		// a variable the JVM or the shell reads by itself runs code at start
		(args) => envIsCode(text(args, 'name'))
			? [{ action: 'code:Deploy', resource: id('instance', text(args, 'instance')) }]
			: []
	),
	env_unset: all(on('env:Unset', 'env', 'name'), when('instance', instance('instance:ManageEnvironment'))),
	settings_get: instance('instance:Describe'),

	file_list: instance('instance:ReadFiles'),
	file_read: all(instance('instance:ReadFiles'), chatIfLog('path', 'instance')),
	file_stat: instance('instance:ReadFiles'),
	file_find: instance('instance:ReadFiles'),
	file_write: all(instance('instance:WriteFiles'), codeIfPath('path')),
	file_edit: all(instance('instance:WriteFiles'), codeIfPath('path')),
	file_mkdir: all(instance('instance:WriteFiles'), codeIfPath('path')),
	file_copy: all(instance('instance:WriteFiles'), chatIfLog('from', 'instance'), codeIfMoved()),
	file_move: all(instance('instance:WriteFiles'), chatIfLog('from', 'instance'), codeIfMoved()),
	file_delete: instance('instance:WriteFiles'),
	file_transfer: all(
		instance('instance:ReadFiles', 'fromInstance'),
		instance('instance:WriteFiles', 'toInstance'),
		chatIfArchive('from', 'fromInstance'),
		codeIfMoved('toInstance')
	),

	// the CLI and bash run with the machine's own authority, so only an account
	// trusted with the terminal drawer may reach them through the agent
	luna_shell: plain('shell:Execute'),
	shell_bash: plain('shell:Execute'),

	addons_list: plain('plugin:List'),
	addon_info: on('plugin:Describe', 'plugin', 'name'),
	addon_search: plain('catalog:Read'),
	addon_versions: all(plain('catalog:Read'), when('instance', instance('instance:Describe'))),
	addon_check_updates: each('plugin:Describe', 'plugin', 'names'),
	addon_install: all(plain('plugin:Install'), addonTargets('targets')),
	addon_install_url: all(plain('plugin:Install'), code(), addonTargets('targets')),
	addon_install_upload: all(plain('plugin:Install'), code(), addonTargets('targets')),
	// a change of targets is checked against the pool as it stands (`TOOL_IAM_LIVE`)
	addon_configure: on('plugin:Configure', 'plugin', 'name'),
	addon_update: each('plugin:Update', 'plugin', 'names'),
	addon_pin: perServer('plugin:Configure', 'plugin', 'targets'),
	addon_unpin: perServer('plugin:Configure', 'plugin', 'targets'),
	addon_deploy: perServer('plugin:Configure', 'plugin', 'instances'),
	addon_remove: perServer('plugin:Remove', 'plugin', 'from'),
	modpack_search: plain('catalog:Read'),
	modpack_versions: plain('catalog:Read'),
	modpack_install: all(on('instance:Create', 'instance', 'name'), codeIfPackFile('name')),
	modpack_update: all(instance('instance:Configure'), codeIfPackFile('instance')),

	domain_list: plain('domain:List'),
	domain_records: (args) => [{ action: 'domain:Describe', resource: id('domain', domainLabel(text(args, 'name'))) }],
	domain_create: all(
		plain('domain:Create'),
		when('instance', instance('instance:ManageNetwork')),
		// another address, or adopting an existing record, is editing DNS records
		(args) => args.address || args.adopt === true
			? [{ action: 'domain:ManageRecords', resource: null }]
			: []
	),
	domain_update: (args) => [{ action: 'domain:ManageRecords', resource: id('domain', domainLabel(text(args, 'name'))) }],
	domain_link: all(
		(args) => [{ action: 'domain:Link', resource: id('domain', domainLabel(text(args, 'name'))) }],
		instance('instance:ManageNetwork')
	),
	domain_unlink: (args) => [{ action: 'domain:Link', resource: id('domain', domainLabel(text(args, 'name'))) }],
	domain_delete: (args) => [{ action: 'domain:Delete', resource: id('domain', domainLabel(text(args, 'name'))) }],

	server_menu_list: plain('network:Describe'),
	proxy_registrations: plain('network:Describe'),
	ports_list: plain('network:Describe'),
	port_check: plain('network:Describe'),
	server_menu_set: plain('network:ManageProxy'),
	server_menu_apply: plain('network:ManageProxy'),
	proxy_register: plain('network:ManageProxy'),
	proxy_sync: plain('network:ManageProxy'),
	ports_fix: plain('network:ManageProxy'),
	instance_set_port: instance('instance:ManageNetwork'),

	respacks_list: plain('pack:List'),
	datapacks_list: plain('datapack:List'),
	pack_search: plain('catalog:Read'),
	pack_check_updates: plain('catalog:Read'),
	respack_install: all(plain('pack:Install'), packServers),
	respack_install_upload: all(plain('pack:Install'), packServers),
	respack_configure: on('pack:Configure', 'pack', 'key'),
	respack_update: each('pack:Update', 'pack', 'names'),
	respack_push: all(on('pack:Configure', 'pack', 'key'), plain('player:Act')),
	respack_remove: on('pack:Remove', 'pack', 'key'),
	datapack_install: all(plain('datapack:Install'), addonTargets('targets')),
	datapack_install_upload: all(plain('datapack:Install'), addonTargets('targets')),
	datapack_configure: on('datapack:Configure', 'datapack', 'name'),
	datapack_update: each('datapack:Update', 'datapack', 'names'),
	datapack_remove: perServer('datapack:Remove', 'datapack', 'from'),

	// the agent's own memory: what it remembers for one account it remembers for
	// every account, so writing to it is a knowledge action like any other
	memory_search: plain('knowledge:List'),
	skill_list: plain('knowledge:List'),
	skill_get: plain('knowledge:List'),
	context_get: plain('knowledge:List'),
	memory_save: plain('knowledge:Create'),
	memory_update: on('knowledge:Update', 'knowledge', 'id'),
	memory_forget: on('knowledge:Delete', 'knowledge', 'id'),
	skill_save: plain('knowledge:Create'),
	skill_delete: plain('knowledge:Delete'),

	// access management: the same actions the /api/iam and /api/resources routes ask
	iam_policies_list: plain('iam:ListPolicies'),
	iam_policy_get: on('iam:DescribePolicy', 'policy', 'name'),
	iam_policy_validate: plain('iam:ListPolicies'),
	iam_groups_list: plain('iam:ListGroups'),
	iam_group_get: on('iam:DescribeGroup', 'group', 'name'),
	iam_account_permissions: on('account:Describe', 'account', 'username'),
	iam_simulate: plain('iam:Simulate'),
	iam_audit: plain('iam:ReadAudit'),
	resources_find: plain('tag:List'),
	resource_get: (args) => [{ action: 'tag:Describe', resource: text(args, 'id') }],
	iam_policy_create: plain('iam:CreatePolicy'),
	iam_policy_update: on('iam:UpdatePolicy', 'policy', 'name'),
	iam_policy_delete: on('iam:DeletePolicy', 'policy', 'name'),
	iam_group_create: all(plain('iam:CreateGroup'), when('policies', plain('iam:Attach'))),
	iam_group_update: on('iam:UpdateGroup', 'group', 'name'),
	iam_group_delete: on('iam:DeleteGroup', 'group', 'name'),
	iam_group_members: on('iam:UpdateGroup', 'group', 'group'),
	iam_attach: plain('iam:Attach'),
	iam_detach: plain('iam:Detach'),
	iam_inline_put: plain('iam:Attach'),
	iam_inline_delete: plain('iam:Detach'),
	resource_tag: (args) => [{ action: 'tag:Tag', resource: text(args, 'id') }],
	resource_untag: (args) => [{ action: 'tag:Untag', resource: text(args, 'id') }]
};

/**
 * The checks that depend on the cluster as it stands, run beside a tool's
 * `TOOL_IAM` rule: a new target list is checked for every instance it adds or
 * drops, and a verb with no list ("unpin everywhere", "remove from the pool")
 * for every instance it would reach. Kept apart because `toolPossible` probes the
 * static rules without touching the daemon.
 */
const TOOL_IAM_LIVE: Record<string, (args: ToolArgs, hidden: Set<string> | null) => Promise<IamCheck[]>> = {
	addon_configure: async (args, hidden) => Array.isArray(args.targets)
		? await pluginTargetChecks(text(args, 'name') ?? '', list(args, 'targets'), hidden)
		: [],
	addon_unpin: async (args) => list(args, 'targets').length === 0
		? await pluginUnpinChecks(text(args, 'name') ?? '', [])
		: [],
	addon_remove: async (args) => list(args, 'from').length === 0
		? await pluginRemovalChecks(text(args, 'name') ?? '', [])
		: [],
	datapack_configure: async (args, hidden) => Array.isArray(args.targets)
		? await datapackTargetChecks(text(args, 'name') ?? '', list(args, 'targets'), hidden)
		: [],
	datapack_remove: async (args) => list(args, 'from').length === 0
		? await datapackRemovalChecks(text(args, 'name') ?? '', [])
		: [],
	respack_configure: async (args, hidden) => [
		...(Array.isArray(args.servers)
			? await respackServerChecks(text(args, 'key') ?? '', list(args, 'servers'), hidden)
			: []),
		...await respackEnableChecks(text(args, 'key') ?? '', args.enabled, optionalList(args, 'servers'), hidden)
	],
	respack_install: async (args, hidden) =>
		await respackEnableChecks(packKey(text(args, 'slug')), args.enabled, optionalList(args, 'servers'), hidden),
	respack_install_upload: async (args, hidden) =>
		await respackEnableChecks(packKey(text(args, 'name')), args.enabled, optionalList(args, 'servers'), hidden)
};

/** The state-dependent checks a call makes on top of its static ones; empty for most tools. */
export async function toolLiveChecks(tool: string, args: ToolArgs, account?: string): Promise<IamCheck[]> {
	const rule = TOOL_IAM_LIVE[tool];

	return rule
		? await rule(args, await hiddenInstances(account))
		: [];
}

/** Catalog tools with no rule; empty when every tool is covered. */
export const TOOL_IAM_COVERAGE: string[] = MCP_TOOLS.map((tool) => tool.name).filter((name) => !TOOL_IAM[name]);

/** The checks a call makes, or null for a tool the table does not know (refused). */
export function toolChecks(tool: string, args: ToolArgs): IamCheck[] | null {
	const rule = TOOL_IAM[tool];

	return rule ? rule(args) : null;
}

/**
 * The arguments a call must carry, filled with a placeholder: what the
 * possibility probe calls a rule with, so a check names a resource exactly when
 * a real call would, and the optional ones (`when`) stay out of it.
 */
function requiredPlaceholders(tool: string, withLists = false): ToolArgs {
	const spec = MCP_TOOLS.find((entry) => entry.name === tool);
	const out: ToolArgs = {};
	const properties = spec?.inputSchema.properties ?? {};
	const lists = withLists
		? Object.keys(properties)
		: [];

	for (const key of [...new Set([...(spec?.inputSchema.required ?? []), ...lists])]) {
		const type = spec?.inputSchema.properties?.[key]?.type;

		out[key] = type === 'array'
			? ['_']
			: '_';
	}

	return out;
}

/** Whether an account could ever use a tool; what decides which tools the agent is offered. */
export function toolPossible(context: PrincipalContext, tool: string): boolean {
	const rule = TOOL_IAM[tool];

	if (!rule) {
		return false;
	}

	const possible = (args: ToolArgs): boolean => rule(args).every((check) =>
		actionPossible(context, check.action, check.resource === null)
	);

	// a verb that narrows to the servers (or the one server) it names is possible
	// when its narrow form is
	return possible(requiredPlaceholders(tool)) || possible(requiredPlaceholders(tool, true));
}

export interface IamRefusal {
	check: IamCheck;
	reason: string;
}

/** Decide every check of a call for an account; the first refusal, or null when all pass. */
export async function refuseFor(username: string, checks: IamCheck[]): Promise<IamRefusal | null> {
	for (const check of checks) {
		const result = await authorize(username, check.action, check.resource);

		if (!result.verdict.allowed) {
			return {
				check,
				reason: result.verdict.reason === 'explicit-deny'
					? 'denied by policy'
					: 'not allowed by any policy'
			};
		}
	}

	return null;
}

/**
 * The token's scope narrowed to the instances the account may describe. A
 * scope already limited keeps only the intersection; an unlimited one stays
 * unlimited when the account sees every instance, so a cluster-wide write the
 * token allows is not refused merely because the call came from the agent.
 */
export async function accountScope(username: string, scope: McpScope): Promise<McpScope> {
	const cfg = await loadCluster();
	const names = ['proxy', ...Object.keys(cfg.instances)];
	const candidates = scope.instances === null
		? names
		: scope.instances;
	const ids = candidates.map((name) => resourceId('instance', name));
	const allowed = await authorizeMany(username, 'instance:Describe', ids);
	const visible = candidates.filter((name) => allowed[resourceId('instance', name)]);

	if (scope.instances === null && visible.length === names.length) {
		return scope;
	}

	return { ...scope, instances: visible };
}

/** The principal a call for an account runs as: the token, with the account's instance view. */
export async function accountPrincipal(username: string, principal: McpPrincipal): Promise<McpPrincipal> {
	return { ...principal, scope: await accountScope(username, principal.scope), tokenScope: principal.scope };
}

/**
 * Keep the rows the account behind a call may describe; every row when the call
 * is not made for an account. What a listing handler applies to its rows of a
 * resource type other than instances, which the scope above already covers.
 */
export async function iamVisible<T>(
	ctx: ToolContext,
	action: string,
	rows: T[],
	idOf: (row: T) => string
): Promise<T[]> {
	if (!ctx.account || rows.length === 0) {
		return rows;
	}

	const ids = [...new Set(rows.map(idOf))];
	const allowed = await authorizeMany(ctx.account, action, ids);

	return rows.filter((row) => allowed[idOf(row)]);
}

/**
 * Whether a knowledge item was written for a console account other than this
 * one. What Mèo Béo saves in a conversation is that account's own memory, kept
 * from every other account's runs as conversations are, whatever IAM would
 * allow: one account's notes would otherwise steer another account's agent.
 * Items written from the CLI (`root`) or by a token (`mcp:<name>`) are the
 * operators' shared notes and follow IAM alone.
 */
function privateToAnother(item: KnowledgeItem, account: string): boolean {
	const author = item.createdBy;

	if (item.scope.kind !== 'token' || !author || author === account) {
		return false;
	}

	return author !== 'root' && !author.startsWith('mcp:');
}

/**
 * The knowledge items a call for an account may read: the account's own agent
 * memory and the shared items its policies let it describe. Every item when the
 * call is not made for an account.
 */
export async function knowledgeVisible(account: string | undefined, items: KnowledgeItem[]): Promise<KnowledgeItem[]> {
	if (!account || items.length === 0) {
		return items;
	}

	const candidates = items.filter((item) => !privateToAnother(item, account));
	const ids = candidates.map((item) => resourceId('knowledge', item.id));
	const allowed = await authorizeMany(account, 'knowledge:Describe', ids);

	return candidates.filter((item) => allowed[resourceId('knowledge', item.id)]);
}
