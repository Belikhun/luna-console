// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The API route catalog: for every route id and method, the action an account
 * needs and the resource the call is about.
 *
 * The gate in `hooks.server.ts` reads this before any handler runs, so a
 * handler never has to remember to check; and a route that is **not** here is
 * refused, because an authorization table that forgets a route must fail
 * closed. Adding an endpoint means adding its rule.
 *
 * A resource is read off the params when the URL names it, and off a clone of
 * the body for the few creates that name it there (`/api/env`, `/api/instances`).
 * `session` marks the handful of routes that need nothing beyond being signed in
 * (an avatar, the host vitals in the chrome).
 */

import { getAccount } from '$core/accounts';
import { resourceId } from '$shared/iam/resources';
import type { IamResourceType } from '$shared/iam/actions';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface RuleContext {
	params: Record<string, string>;
	url: URL;
	request: Request;
}

export interface RouteRule {
	action: string;
	/** When the verb depends on the body, this resolves it; `action` is the fallback */
	actionOf?: (ctx: RuleContext) => Promise<string>;
	resource?: (ctx: RuleContext) => string | null | Promise<string | null>;
}

/** `session`: signed in is enough. */
export type MethodRules = Partial<Record<Method, RouteRule | 'session'>>;

const of = (type: IamResourceType, param: string) => (ctx: RuleContext): string | null => {
	const value = ctx.params[param];

	return value ? resourceId(type, value) : null;
};

const instance = of('instance', 'name');
const plugin = of('plugin', 'name');
const pack = of('pack', 'key');
const datapack = of('datapack', 'name');
const addonGroup = of('addon-group', 'name');
const profile = of('profile', 'name');
const domain = of('domain', 'name');
const schedule = of('schedule', 'id');
const env = of('env', 'name');
const player = of('player', 'player');
const permissionGroup = of('permission-group', 'name');
const knowledge = of('knowledge', 'id');
const machine = of('machine', 'name');

/** A resource named by a query parameter. */
const query = (type: IamResourceType, key: string) => (ctx: RuleContext): string | null => {
	const value = ctx.url.searchParams.get(key);

	return value ? resourceId(type, value) : null;
};

/** A resource named by a field of the JSON body; the body is cloned, so the handler still reads it. */
const body = (type: IamResourceType, key: string) => async (ctx: RuleContext): Promise<string | null> => {
	try {
		const parsed = await ctx.request.clone().json();
		const value = parsed?.[key];

		return typeof value === 'string' && value !== '' ? resourceId(type, value) : null;
	} catch {
		return null;
	}
};

/** Accounts are addressed by id in the URL; the resource id carries the username. */
const account = async (ctx: RuleContext): Promise<string | null> => {
	const id = ctx.params.id;

	if (!id) {
		return null;
	}

	const found = await getAccount(id);

	return resourceId('account', found?.username ?? id);
};

/** The resource id itself, sent in the body (the tag routes take any resource). */
const bodyId = (key: string) => async (ctx: RuleContext): Promise<string | null> => {
	try {
		const parsed = await ctx.request.clone().json();
		const value = parsed?.[key];

		return typeof value === 'string' && value !== '' ? value : null;
	} catch {
		return null;
	}
};

/** A verb that depends on the body's `action` field. */
function byAction(
	map: Record<string, string>,
	fallback: string,
	resource?: RouteRule['resource']
): RouteRule {
	return {
		action: fallback,
		resource,
		actionOf: async (ctx: RuleContext) => {
			try {
				const parsed = await ctx.request.clone().json();
				const verb = typeof parsed?.action === 'string' ? parsed.action : '';

				return map[verb] ?? fallback;
			} catch {
				return fallback;
			}
		}
	};
}

export const API_RULES: Record<string, MethodRules> = {
	'/api/auth/session': { GET: 'session', POST: 'session', DELETE: 'session' },
	'/api/auth/bootstrap': { POST: 'session' },
	'/api/host': { GET: 'session' },
	'/api/avatar/[...path]': { GET: 'session' },
	'/api/accounts/[id]/avatar': { GET: 'session', PUT: { action: 'account:Update', resource: account } },

	'/api/accounts': { GET: { action: 'account:List' }, POST: { action: 'account:Create' } },
	'/api/accounts/[id]': {
		GET: { action: 'account:Describe', resource: account },
		PATCH: { action: 'account:Update', resource: account },
		DELETE: { action: 'account:Delete', resource: account }
	},
	'/api/accounts/[id]/password': { POST: { action: 'account:SetPassword', resource: account } },
	'/api/accounts/[id]/identities': {
		POST: { action: 'account:ManageIdentities', resource: account },
		PATCH: { action: 'account:ManageIdentities', resource: account },
		DELETE: { action: 'account:ManageIdentities', resource: account }
	},
	'/api/accounts/[id]/sessions': {
		GET: { action: 'account:Describe', resource: account },
		DELETE: { action: 'account:ManageSessions', resource: account }
	},
	'/api/accounts/[id]/permissions': { GET: { action: 'account:Describe', resource: account } },

	'/api/iam/policies': { GET: { action: 'iam:ListPolicies' }, POST: { action: 'iam:CreatePolicy' } },
	'/api/iam/policies/validate': { POST: { action: 'iam:ListPolicies' } },
	'/api/iam/policies/[name]': {
		GET: { action: 'iam:DescribePolicy' },
		PATCH: { action: 'iam:UpdatePolicy' },
		DELETE: { action: 'iam:DeletePolicy' }
	},
	'/api/iam/groups': { GET: { action: 'iam:ListGroups' }, POST: { action: 'iam:CreateGroup' } },
	'/api/iam/groups/[name]': {
		GET: { action: 'iam:DescribeGroup' },
		PATCH: { action: 'iam:UpdateGroup' },
		DELETE: { action: 'iam:DeleteGroup' }
	},
	'/api/iam/groups/[name]/members': {
		POST: { action: 'iam:UpdateGroup' },
		DELETE: { action: 'iam:UpdateGroup' }
	},
	'/api/iam/attachments': { POST: { action: 'iam:Attach' }, DELETE: { action: 'iam:Detach' } },
	'/api/iam/inline': { PUT: { action: 'iam:Attach' }, DELETE: { action: 'iam:Detach' } },
	'/api/iam/simulate': { POST: { action: 'iam:Simulate' } },
	'/api/iam/audit': { GET: { action: 'iam:ReadAudit' } },
	'/api/iam/can': { POST: 'session' },
	'/api/resources': { GET: { action: 'tag:List' } },
	'/api/resources/describe': { POST: { action: 'tag:Describe' } },
	'/api/resources/tags': {
		PUT: { action: 'tag:Tag', resource: bodyId('id') },
		DELETE: { action: 'tag:Untag', resource: bodyId('id') }
	},

	'/api/instances': {
		GET: { action: 'instance:List' },
		POST: { action: 'instance:Create', resource: body('instance', 'name') }
	},
	'/api/instances/[name]': {
		GET: { action: 'instance:Describe', resource: instance },
		DELETE: { action: 'instance:Delete', resource: instance }
	},
	'/api/instances/[name]/state': {
		POST: byAction(
			{ start: 'instance:Start', stop: 'instance:Stop', restart: 'instance:Restart' },
			'instance:Start',
			instance
		)
	},
	'/api/instances/[name]/access': {
		GET: { action: 'instance:Describe', resource: instance },
		POST: { action: 'instance:ManagePlayers', resource: instance }
	},
	'/api/instances/[name]/addons': { POST: { action: 'instance:ManageAddons', resource: instance } },
	'/api/instances/[name]/addons/collisions': { GET: { action: 'instance:Describe', resource: instance } },
	'/api/instances/[name]/addons/stream': { GET: { action: 'instance:Describe', resource: instance } },
	'/api/instances/[name]/build': {
		GET: { action: 'instance:Describe', resource: instance },
		POST: { action: 'instance:Configure', resource: instance }
	},
	'/api/instances/[name]/chat': { GET: { action: 'instance:ReadChat', resource: instance } },
	'/api/instances/[name]/config': {
		GET: { action: 'instance:Describe', resource: instance },
		PATCH: { action: 'instance:Configure', resource: instance }
	},
	'/api/instances/[name]/console': {
		GET: { action: 'instance:ReadConsole', resource: instance },
		POST: { action: 'instance:SendCommand', resource: instance }
	},
	'/api/instances/[name]/datapacks': {
		GET: { action: 'instance:Describe', resource: instance },
		POST: { action: 'instance:ManageAddons', resource: instance }
	},
	'/api/instances/[name]/env': {
		GET: { action: 'instance:Describe', resource: instance },
		POST: { action: 'instance:ManageEnvironment', resource: instance }
	},
	'/api/instances/[name]/files': {
		GET: { action: 'instance:ReadFiles', resource: instance },
		PUT: { action: 'instance:WriteFiles', resource: instance }
	},
	'/api/instances/[name]/files/download': {
		GET: { action: 'instance:ReadFiles', resource: instance },
		POST: { action: 'instance:ReadFiles', resource: instance }
	},
	'/api/instances/[name]/files/manage': {
		GET: { action: 'instance:ReadFiles', resource: instance },
		POST: { action: 'instance:WriteFiles', resource: instance }
	},
	'/api/instances/[name]/files/ops': { POST: { action: 'instance:WriteFiles', resource: instance } },
	'/api/instances/[name]/files/upload': {
		GET: { action: 'instance:WriteFiles', resource: instance },
		POST: { action: 'instance:WriteFiles', resource: instance }
	},
	'/api/instances/[name]/files/upload/[token]': { PUT: { action: 'instance:WriteFiles', resource: instance } },
	'/api/instances/[name]/logs': { GET: { action: 'instance:ReadLogs', resource: instance } },
	'/api/instances/[name]/metrics': { GET: { action: 'instance:ReadMetrics', resource: instance } },
	'/api/instances/[name]/threads': { GET: { action: 'instance:ReadMetrics', resource: instance } },
	'/api/instances/[name]/modpack': {
		GET: { action: 'instance:Describe', resource: instance },
		POST: { action: 'instance:Configure', resource: instance }
	},
	'/api/instances/[name]/players': { GET: { action: 'instance:Describe', resource: instance } },
	'/api/instances/[name]/players/[player]': { GET: { action: 'instance:Describe', resource: instance } },
	'/api/instances/[name]/plugins': {
		GET: { action: 'instance:Describe', resource: instance },
		POST: { action: 'instance:ManageAddons', resource: instance }
	},
	'/api/instances/[name]/plugins/[plugin]': { GET: { action: 'instance:Describe', resource: instance } },
	'/api/instances/[name]/properties': {
		GET: { action: 'instance:Describe', resource: instance },
		PUT: { action: 'instance:Configure', resource: instance },
		DELETE: { action: 'instance:Configure', resource: instance }
	},
	'/api/instances/[name]/proxy': {
		GET: { action: 'instance:Describe', resource: instance },
		PUT: { action: 'instance:ManageNetwork', resource: instance }
	},
	'/api/instances/[name]/unmanaged/[file]': { GET: { action: 'instance:ReadLogs', resource: instance } },
	'/api/instances/[name]/world': { GET: { action: 'instance:Describe', resource: instance } },
	'/api/instances/[name]/world/actions': { POST: { action: 'instance:ManageWorld', resource: instance } },
	'/api/instances/[name]/world/backups/[id]': {
		PATCH: { action: 'instance:ManageWorld', resource: instance },
		POST: { action: 'instance:ManageWorld', resource: instance },
		DELETE: { action: 'instance:ManageWorld', resource: instance }
	},
	'/api/instances/[name]/world/backups/[id]/download': { GET: { action: 'instance:ReadFiles', resource: instance } },
	'/api/worlds/stage': { POST: { action: 'instance:ManageWorld' } },
	'/api/worlds/stage/[token]': {
		GET: { action: 'instance:ManageWorld' },
		PUT: { action: 'instance:ManageWorld' },
		DELETE: { action: 'instance:ManageWorld' }
	},
	'/api/modpacks/search': { GET: { action: 'catalog:Read' } },
	'/api/modpacks/versions': { GET: { action: 'catalog:Read' } },
	'/api/modpacks/install': { POST: { action: 'instance:Create', resource: body('instance', 'name') } },
	'/api/modpacks/stage': { POST: { action: 'instance:Create' } },
	'/api/modpacks/stage/[token]': { GET: { action: 'instance:Create' } },

	'/api/daemons': { GET: { action: 'machine:List' } },
	'/api/daemons/stream': { GET: { action: 'machine:List' } },
	'/api/daemons/[name]': {
		GET: { action: 'machine:Describe', resource: machine },
		POST: { action: 'machine:Upgrade', resource: machine },
		DELETE: { action: 'machine:Remove', resource: machine }
	},

	'/api/plugins': { GET: { action: 'plugin:List' } },
	'/api/plugins/search': { GET: { action: 'catalog:Read' } },
	'/api/plugins/versions': { GET: { action: 'catalog:Read' } },
	'/api/plugins/validate': { GET: { action: 'catalog:Read' } },
	'/api/plugins/check': { POST: { action: 'plugin:List' } },
	'/api/plugins/add': { POST: { action: 'plugin:Install' } },
	'/api/plugins/fetch': { POST: { action: 'plugin:Install' } },
	'/api/plugins/upload': { POST: { action: 'plugin:Install' } },
	'/api/plugins/update': { POST: { action: 'plugin:Update' } },
	'/api/plugins/deploy': { POST: { action: 'plugin:Configure' } },
	'/api/plugins/scan': { POST: { action: 'plugin:Configure' } },
	'/api/plugins/pin': {
		GET: { action: 'plugin:Describe', resource: query('plugin', 'name') },
		POST: { action: 'plugin:Configure', resource: body('plugin', 'name') }
	},
	'/api/plugins/unpin': { POST: { action: 'plugin:Configure', resource: body('plugin', 'name') } },
	'/api/plugins/[name]': {
		GET: { action: 'plugin:Describe', resource: plugin },
		PATCH: { action: 'plugin:Configure', resource: plugin },
		DELETE: { action: 'plugin:Remove', resource: plugin }
	},
	'/api/plugins/[name]/identify': {
		GET: { action: 'plugin:Describe', resource: plugin },
		POST: { action: 'plugin:Configure', resource: plugin },
		DELETE: { action: 'plugin:Configure', resource: plugin }
	},
	'/api/providers': { GET: { action: 'catalog:Read' } },
	'/api/software': { GET: { action: 'catalog:Read' } },
	'/api/software/[id]/versions': { GET: { action: 'catalog:Read' } },

	'/api/respacks': { GET: { action: 'pack:List' }, POST: { action: 'pack:Install' } },
	'/api/respacks/add': { POST: { action: 'pack:Install' } },
	'/api/respacks/search': { GET: { action: 'catalog:Read' } },
	'/api/respacks/update': { POST: { action: 'pack:Update' } },
	'/api/respacks/reload': { POST: { action: 'pack:Configure' } },
	'/api/respacks/resend': { POST: { action: 'pack:Configure' } },
	'/api/respacks/dynamic': { GET: { action: 'pack:List' }, POST: { action: 'pack:Configure' } },
	'/api/respacks/[key]': {
		PATCH: { action: 'pack:Configure', resource: pack },
		DELETE: { action: 'pack:Remove', resource: pack }
	},
	'/api/respacks/[key]/detail': { GET: { action: 'pack:Describe', resource: pack } },
	'/api/respacks/[key]/file': { POST: { action: 'pack:Update', resource: pack } },
	'/api/respacks/[key]/identify': {
		GET: { action: 'pack:Describe', resource: pack },
		POST: { action: 'pack:Configure', resource: pack },
		DELETE: { action: 'pack:Configure', resource: pack }
	},
	'/api/respacks/[key]/instances': { POST: { action: 'pack:Configure', resource: pack } },
	'/api/respacks/[key]/resend': { POST: { action: 'pack:Configure', resource: pack } },
	'/api/respacks/[key]/versions': {
		GET: { action: 'pack:Describe', resource: pack },
		POST: { action: 'pack:Update', resource: pack }
	},

	'/api/datapacks': { GET: { action: 'datapack:List' }, POST: { action: 'datapack:Install' } },
	'/api/datapacks/add': { POST: { action: 'datapack:Install' } },
	'/api/datapacks/search': { GET: { action: 'catalog:Read' } },
	'/api/datapacks/update': { POST: { action: 'datapack:Update' } },
	'/api/datapacks/deploy': { POST: { action: 'datapack:Configure' } },
	'/api/datapacks/[name]': {
		PATCH: { action: 'datapack:Configure', resource: datapack },
		DELETE: { action: 'datapack:Remove', resource: datapack }
	},
	'/api/datapacks/[name]/identify': {
		GET: { action: 'datapack:Describe', resource: datapack },
		POST: { action: 'datapack:Configure', resource: datapack },
		DELETE: { action: 'datapack:Configure', resource: datapack }
	},

	'/api/addons/groups': {
		GET: { action: 'addon-group:List' },
		POST: { action: 'addon-group:Create', resource: body('addon-group', 'name') },
		DELETE: { action: 'addon-group:Delete', resource: query('addon-group', 'name') }
	},
	'/api/addons/groups/[name]': {
		GET: { action: 'addon-group:Describe', resource: addonGroup },
		PATCH: { action: 'addon-group:Update', resource: addonGroup },
		POST: { action: 'addon-group:Update', resource: addonGroup },
		DELETE: { action: 'addon-group:Delete', resource: addonGroup }
	},

	'/api/runtimes': {
		GET: { action: 'runtime:List' },
		POST: byAction({ install: 'runtime:Install', remove: 'runtime:Remove' }, 'runtime:Install')
	},
	'/api/runtimes/available': { GET: { action: 'catalog:Read' } },
	'/api/profiles': { GET: { action: 'profile:List' }, POST: { action: 'profile:Create' } },
	'/api/profiles/[name]': {
		GET: { action: 'profile:Describe', resource: profile },
		PATCH: { action: 'profile:Update', resource: profile },
		DELETE: { action: 'profile:Delete', resource: profile }
	},

	'/api/ports': {
		GET: { action: 'network:Describe' },
		POST: { action: 'network:ManageProxy' },
		PUT: { action: 'port-pool:Update' }
	},
	'/api/proxy': { GET: { action: 'network:Describe' }, POST: { action: 'network:ManageProxy' } },
	'/api/selector': { GET: { action: 'network:Describe' }, PATCH: { action: 'network:ManageProxy' } },
	'/api/selector/preview': { GET: { action: 'network:Describe' } },
	'/api/selector/apply': { POST: { action: 'network:ManageProxy' } },
	'/api/selector/import': { POST: { action: 'network:ManageProxy' } },
	'/api/domains': { GET: { action: 'domain:List' }, POST: { action: 'domain:Create' } },
	'/api/domains/check': { POST: { action: 'domain:List' } },
	'/api/domains/records': { GET: { action: 'domain:Describe', resource: query('domain', 'name') } },
	'/api/domains/settings': { PATCH: { action: 'domain:ConfigureProvider' } },
	'/api/domains/[name]': {
		PATCH: { action: 'domain:ManageRecords', resource: domain },
		DELETE: { action: 'domain:Delete', resource: domain }
	},
	'/api/domains/[name]/link': { POST: { action: 'domain:Link', resource: domain } },
	'/api/domains/[name]/unlink': { POST: { action: 'domain:Link', resource: domain } },

	'/api/schedules': { GET: { action: 'schedule:List' }, POST: { action: 'schedule:Create' } },
	'/api/schedules/[id]': {
		PATCH: { action: 'schedule:Update', resource: schedule },
		POST: { action: 'schedule:Update', resource: schedule },
		DELETE: { action: 'schedule:Delete', resource: schedule }
	},
	'/api/env': {
		GET: { action: 'env:List' },
		POST: { action: 'env:Set', resource: body('env', 'name') },
		DELETE: { action: 'env:Unset', resource: query('env', 'name') }
	},
	'/api/env/[name]': { GET: { action: 'env:Describe', resource: env } },
	'/api/env/[name]/reveal': { POST: { action: 'env:Reveal', resource: env } },

	'/api/players': { GET: { action: 'player:List' } },
	'/api/players/moderate': { POST: { action: 'player:Moderate' } },
	'/api/players/[player]': { GET: { action: 'player:Describe', resource: player } },
	'/api/players/[player]/chat': { GET: { action: 'player:ReadChat', resource: player } },
	'/api/players/[player]/sessions': { GET: { action: 'player:Describe', resource: player } },
	'/api/players/[player]/vault': { GET: { action: 'player:Describe', resource: player } },
	'/api/players/[player]/vault/transactions': { GET: { action: 'player:Describe', resource: player } },
	'/api/players/[player]/auth': {
		GET: { action: 'player:Describe', resource: player },
		POST: { action: 'player:Act', resource: player }
	},
	'/api/players/[player]/skin': {
		GET: { action: 'player:Describe', resource: player },
		POST: { action: 'player:Act', resource: player }
	},
	'/api/players/[player]/moderation': {
		GET: { action: 'player:Describe', resource: player },
		POST: { action: 'player:Moderate', resource: player }
	},
	'/api/players/[player]/permissions': {
		GET: { action: 'player:Describe', resource: player },
		POST: { action: 'player:ManagePermissions', resource: player }
	},
	'/api/moderation': { GET: { action: 'player:List' } },
	'/api/moderation/log': { GET: { action: 'player:List' } },
	'/api/moderation/network-ip-bans': { GET: { action: 'player:List' }, POST: { action: 'player:Moderate' } },
	'/api/luna/players': { GET: { action: 'player:List' } },
	'/api/luna/admin': { POST: { action: 'player:Act' } },
	'/api/luna/stream': { GET: { action: 'event:Read' } },
	'/api/luna/telemetry': { GET: { action: 'event:Read' } },
	'/api/permissions/groups': { GET: { action: 'permission-group:List' }, POST: { action: 'permission-group:Create' } },
	'/api/permissions/groups/[name]': {
		GET: { action: 'permission-group:Describe', resource: permissionGroup },
		POST: { action: 'permission-group:Update', resource: permissionGroup },
		DELETE: { action: 'permission-group:Delete', resource: permissionGroup }
	},

	'/api/cleanup': { GET: { action: 'cleanup:Describe' }, POST: { action: 'cleanup:Run' } },
	'/api/console/logs': { GET: { action: 'journal:Read' } },
	'/api/events': { GET: { action: 'event:Read' } },
	'/api/jobs': { GET: { action: 'job:Describe' } },
	'/api/jobs/[id]': { GET: { action: 'job:Describe' } },
	'/api/shell/exec': { GET: { action: 'shell:Execute' } },
	'/api/shell/complete': { POST: { action: 'shell:Execute' } },
	'/api/mc/assets': { GET: { action: 'catalog:Read' }, POST: { action: 'catalog:Read' } },
	'/api/mc/assets/gui': { GET: { action: 'catalog:Read' } },
	'/api/mc/assets/registry': { GET: { action: 'catalog:Read' } },
	'/api/mc/assets/font/[file]': { GET: { action: 'catalog:Read' } },
	'/api/mc/assets/texture/[...path]': { GET: { action: 'catalog:Read' } },

	'/api/mcp-tokens': { GET: { action: 'mcp:ListTokens' }, POST: { action: 'mcp:CreateToken' } },
	'/api/mcp-tokens/[id]': {
		GET: { action: 'mcp:DescribeToken' },
		PATCH: { action: 'mcp:UpdateToken' },
		DELETE: { action: 'mcp:DeleteToken' }
	},
	'/api/mcp-tokens/[id]/rotate': { POST: { action: 'mcp:RotateToken' } },
	'/api/mcp-calls': { GET: { action: 'mcp:ReadCalls' } },
	'/api/knowledge': { GET: { action: 'knowledge:List' }, POST: { action: 'knowledge:Create' } },
	'/api/knowledge/[id]': {
		GET: { action: 'knowledge:Describe', resource: knowledge },
		PATCH: { action: 'knowledge:Update', resource: knowledge },
		DELETE: { action: 'knowledge:Delete', resource: knowledge }
	},

	'/api/agent': { GET: { action: 'agent:Describe' }, PATCH: { action: 'agent:Configure' } },
	'/api/agent/credential': { PUT: { action: 'agent:Configure' }, DELETE: { action: 'agent:Configure' } },
	'/api/agent/test': { POST: { action: 'agent:Configure' } },
	'/api/agent/uploads': { POST: { action: 'agent:Chat' } },
	'/api/agent/uploads/[id]': { DELETE: { action: 'agent:Chat' } },
	'/api/agent/conversations': { GET: { action: 'agent:Chat' }, POST: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]': {
		GET: { action: 'agent:Chat' },
		PATCH: { action: 'agent:Chat' },
		DELETE: { action: 'agent:Chat' }
	},
	'/api/agent/conversations/[id]/approve': { POST: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/compact': { POST: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/messages': { POST: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/navigated': { POST: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/run': { PATCH: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/screenshot': { POST: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/stop': { POST: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/stream': { GET: { action: 'agent:Chat' } },
	'/api/agent/conversations/[id]/watch': { GET: { action: 'agent:Chat' } }
};

/**
 * Page routes whose resource has to be resolved asynchronously (an account is
 * addressed by id, and its resource id carries the username). Everything else
 * is in `$lib/authz/pages`, shared with the nav.
 */
export const PAGE_ASYNC_RULES: Record<string, RouteRule> = {
	'/console/accounts/[id]': { action: 'account:Describe', resource: account },
	'/console/accounts/[id]/edit': { action: 'account:Update', resource: account }
};

/** The action a rule resolves to, reading the body when the rule depends on it. */
export async function ruleAction(rule: RouteRule, ctx: RuleContext): Promise<string> {
	if (rule.actionOf) {
		return await rule.actionOf(ctx);
	}

	return rule.action;
}
