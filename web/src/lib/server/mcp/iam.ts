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
import type { McpPrincipal } from '$core/mcp';
import { actionPossible, type PrincipalContext } from '$shared/iam/grammar';
import { resourceId } from '$shared/iam/resources';
import type { IamResourceType } from '$shared/iam/actions';
import { MCP_TOOLS, type McpScope } from '$shared/mcptools';

import type { ToolArgs, ToolContext } from './errors';

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

export const TOOL_IAM: Record<string, Rule> = {
	cluster_status: plain('instance:List'),
	instance_status: instance('instance:Describe'),
	instance_logs: instance('instance:ReadLogs'),
	players_online: all(plain('player:List'), when('instance', instance('instance:Describe'))),
	player_lookup: on('player:Describe', 'player', 'player'),
	player_search: plain('player:List'),
	player_chat: all(on('player:ReadChat', 'player', 'player'), when('server', instance('instance:ReadChat', 'server'))),
	chat_log: all(plain('player:List'), when('server', instance('instance:ReadChat', 'server'))),
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

	env_list: all(plain('env:List'), when('instance', instance('instance:Describe'))),
	env_set: all(on('env:Set', 'env', 'name'), when('instance', instance('instance:ManageEnvironment'))),
	env_unset: all(on('env:Unset', 'env', 'name'), when('instance', instance('instance:ManageEnvironment'))),
	settings_get: instance('instance:Describe'),

	file_list: instance('instance:ReadFiles'),
	file_read: instance('instance:ReadFiles'),
	file_stat: instance('instance:ReadFiles'),
	file_find: instance('instance:ReadFiles'),
	file_write: instance('instance:WriteFiles'),
	file_edit: instance('instance:WriteFiles'),
	file_mkdir: instance('instance:WriteFiles'),
	file_copy: instance('instance:WriteFiles'),
	file_move: instance('instance:WriteFiles'),
	file_delete: instance('instance:WriteFiles'),
	file_transfer: all(instance('instance:ReadFiles', 'fromInstance'), instance('instance:WriteFiles', 'toInstance')),

	// the CLI and bash run with the machine's own authority, so only an account
	// trusted with the terminal drawer may reach them through the agent
	luna_shell: plain('shell:Execute'),
	shell_bash: plain('shell:Execute'),

	addons_list: plain('plugin:List'),
	addon_info: on('plugin:Describe', 'plugin', 'name'),
	addon_search: plain('catalog:Read'),
	addon_versions: all(plain('catalog:Read'), when('instance', instance('instance:Describe'))),
	addon_check_updates: each('plugin:Describe', 'plugin', 'names'),
	addon_install: plain('plugin:Install'),
	addon_install_url: plain('plugin:Install'),
	addon_install_upload: plain('plugin:Install'),
	addon_configure: on('plugin:Configure', 'plugin', 'name'),
	addon_update: each('plugin:Update', 'plugin', 'names'),
	addon_pin: on('plugin:Configure', 'plugin', 'name'),
	addon_unpin: on('plugin:Configure', 'plugin', 'name'),
	addon_deploy: all(on('plugin:Configure', 'plugin', 'name'), each('instance:ManageAddons', 'instance', 'instances')),
	addon_remove: on('plugin:Remove', 'plugin', 'name'),
	modpack_search: plain('catalog:Read'),
	modpack_versions: plain('catalog:Read'),
	modpack_install: on('instance:Create', 'instance', 'name'),
	modpack_update: instance('instance:Configure'),

	domain_list: plain('domain:List'),
	domain_records: (args) => [{ action: 'domain:Describe', resource: id('domain', domainLabel(text(args, 'name'))) }],
	domain_create: all(plain('domain:Create'), when('instance', instance('instance:ManageNetwork'))),
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
	respack_install: plain('pack:Install'),
	respack_install_upload: plain('pack:Install'),
	respack_configure: on('pack:Configure', 'pack', 'key'),
	respack_update: each('pack:Update', 'pack', 'names'),
	respack_push: all(on('pack:Configure', 'pack', 'key'), plain('player:Act')),
	respack_remove: on('pack:Remove', 'pack', 'key'),
	datapack_install: plain('datapack:Install'),
	datapack_install_upload: plain('datapack:Install'),
	datapack_configure: on('datapack:Configure', 'datapack', 'name'),
	datapack_update: each('datapack:Update', 'datapack', 'names'),
	datapack_remove: on('datapack:Remove', 'datapack', 'name'),

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
	skill_delete: plain('knowledge:Delete')
};

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
function requiredPlaceholders(tool: string): ToolArgs {
	const spec = MCP_TOOLS.find((entry) => entry.name === tool);
	const out: ToolArgs = {};

	for (const key of spec?.inputSchema.required ?? []) {
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

	return rule(requiredPlaceholders(tool)).every((check) =>
		actionPossible(context, check.action, check.resource === null)
	);
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
	return { ...principal, scope: await accountScope(username, principal.scope) };
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
