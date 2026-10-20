// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What a page needs: the action an account must be allowed before the screen
 * opens, keyed by SvelteKit route id. The server gate reads it to refuse a
 * navigation (`hooks.server.ts`), and the side nav reads it to hide an entry the
 * account could not open, so the two never disagree about a screen.
 *
 * A screen about one resource names it from its params, and the gate evaluates
 * the resource's own record (tags, creator) against the account's policies. A
 * route absent from this table only needs a session: the API behind it is gated
 * on its own, so an unlisted page can show nothing it should not.
 */

import { resourceId } from '$shared/iam/resources';

export interface PageRule {
	action: string;
	/** The resource the screen is about, from its params; absent for a cluster-wide screen */
	resource?: (params: Record<string, string>) => string;
}

const instance = (params: Record<string, string>): string => resourceId('instance', params.name ?? '');

export const PAGE_RULES: Record<string, PageRule> = {
	'/instances': { action: 'instance:List' },
	'/instances/launch': { action: 'instance:Create' },
	'/instances/selector': { action: 'network:Describe' },
	'/instances/[name]/[[tab]]': { action: 'instance:Describe', resource: instance },
	'/instances/[name]/console': { action: 'instance:ReadConsole', resource: instance },
	'/instances/[name]/files': { action: 'instance:ReadFiles', resource: instance },
	'/instances/[name]/players/[player]': { action: 'instance:Describe', resource: instance },
	'/instances/[name]/plugins/[plugin]': { action: 'instance:Describe', resource: instance },

	'/players': { action: 'player:List' },
	'/players/online': { action: 'player:List' },
	'/players/moderation': { action: 'player:List' },
	'/players/[player]': {
		action: 'player:Describe',
		resource: (params) => resourceId('player', params.player ?? '')
	},
	'/permissions': { action: 'permission-group:List' },
	'/permissions/[name]': {
		action: 'permission-group:Describe',
		resource: (params) => resourceId('permission-group', params.name ?? '')
	},
	'/permissions/[name]/edit': {
		action: 'permission-group:Update',
		resource: (params) => resourceId('permission-group', params.name ?? '')
	},

	'/plugins': { action: 'plugin:List' },
	// resolved server-side to every family the identity spans: see PAGE_ASYNC_RULES
	'/plugins/[name]': { action: 'plugin:Describe' },
	'/mods': { action: 'plugin:List' },
	'/packs': { action: 'pack:List' },
	'/packs/[key]': { action: 'pack:Describe', resource: (params) => resourceId('pack', params.key ?? '') },
	'/packs/[key]/configure': {
		action: 'pack:Configure',
		resource: (params) => resourceId('pack', params.key ?? '')
	},
	'/datapacks': { action: 'datapack:List' },
	'/addons/groups': { action: 'addon-group:List' },
	'/addons/groups/new': { action: 'addon-group:Create' },
	'/addons/groups/[name]': {
		action: 'addon-group:Describe',
		resource: (params) => resourceId('addon-group', params.name ?? '')
	},

	'/runtime/java': { action: 'runtime:List' },
	'/runtime/profiles': { action: 'profile:List' },
	'/runtime/profiles/new': { action: 'profile:Create' },

	'/network': { action: 'network:Describe' },
	'/network/domains': { action: 'domain:List' },
	'/network/pools': { action: 'port-pool:List' },
	'/proxy': { action: 'network:Describe' },

	'/schedules': { action: 'schedule:List' },
	'/schedules/new': { action: 'schedule:Create' },
	'/environment': { action: 'env:List' },
	'/environment/new': { action: 'env:Set' },
	'/environment/[name]': { action: 'env:Describe', resource: (params) => resourceId('env', params.name ?? '') },

	'/cleanup': { action: 'cleanup:Describe' },
	'/machines': { action: 'machine:List' },
	'/machines/[name]': { action: 'machine:Describe', resource: (params) => resourceId('machine', params.name ?? '') },

	'/console/accounts': { action: 'account:List' },
	'/console/accounts/new': { action: 'account:Create' },
	'/console/iam': { action: 'iam:ListPolicies' },
	'/console/iam/policies': { action: 'iam:ListPolicies' },
	'/console/iam/policies/new': { action: 'iam:CreatePolicy' },
	'/console/iam/policies/[name]': { action: 'iam:DescribePolicy' },
	'/console/iam/policies/[name]/edit': { action: 'iam:UpdatePolicy' },
	'/console/iam/groups': { action: 'iam:ListGroups' },
	'/console/iam/groups/new': { action: 'iam:CreateGroup' },
	'/console/iam/groups/[name]': { action: 'iam:DescribeGroup' },
	'/console/iam/simulator': { action: 'iam:Simulate' },
	'/console/iam/activity': { action: 'iam:ReadAudit' },
	'/console/resources': { action: 'tag:List' },
	'/console/agent': { action: 'agent:Configure' },
	'/console/mcp': { action: 'mcp:ListTokens' },
	'/console/mcp/new': { action: 'mcp:CreateToken' },
	'/console/mcp/[id]': { action: 'mcp:DescribeToken' },
	'/console/knowledge': { action: 'knowledge:List' },
	'/console/knowledge/new': { action: 'knowledge:Create' },
	'/console/knowledge/[id]': {
		action: 'knowledge:Describe',
		resource: (params) => resourceId('knowledge', params.id ?? '')
	},
	'/console/logs': { action: 'journal:Read' },

	'/agent': { action: 'agent:Chat' },
	'/agent/window': { action: 'agent:Chat' }
};

/**
 * The rule for a nav entry, looked up by the path it links to. Nav hrefs are
 * static paths, so they match a route id exactly.
 */
export function pageRuleFor(href: string): PageRule | undefined {
	return PAGE_RULES[href];
}
