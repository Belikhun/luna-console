// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The IAM tools (`iam` / `iam-write`): policies, groups, attachments, inline
 * policies, the simulator, the IAM trail and resource tags, through the `$core`
 * bridge exactly as the `/api/iam` and `/api/resources` routes call it.
 *
 * Access management is one thing for the whole console, so every tool is
 * closed to instance-limited tokens. A call made for a console account (a Mèo
 * Béo run) is already bounded by that account's own `iam:*` verdicts; a token
 * acting for nobody (a bot) is not, so it may not grant the access-management,
 * account or shell powers by any route: attaching, putting inline, adding
 * members to a group that carries them, rewriting an attached policy into one,
 * or tagging an account (policies read an account's tags as principal tags).
 * Credentials never pass through here; the bridge has no call returning them.
 */

import {
	addGroupMembers,
	accountPermissions,
	attachPolicy,
	createGroup,
	createPolicy,
	deleteGroup,
	deleteInlinePolicy,
	deletePolicy,
	detachPolicy,
	getGroup,
	getPolicy,
	iamAudit,
	listGroups,
	listPolicies,
	putInlinePolicy,
	removeGroupMembers,
	simulatePrincipal,
	updateGroup,
	updatePolicy,
	validatePolicyYaml
} from '$core/iam';
import type { AttachTarget, GroupSummary, PolicySummary, SimulationResult } from '$core/iam';
import { describeResource, isResourceType, listResources, tagResource, untagResource } from '$core/resources';
import type { ResourceFilter, ResourceView } from '$core/resources';
import { IAM_ACTIONS } from '$shared/iam/actions';
import { actionMatches, type PolicyDocument, type PolicyStatement } from '$shared/iam/grammar';
import { parseResourceId } from '$shared/iam/resources';
import { optInt, optList, optStr, str } from './args';
import { ToolError } from './errors';
import type { ToolArgs, ToolContext, ToolHandler } from './errors';

/** The most actions one simulation may ask about; the console route's limit. */
const MAX_SIMULATED_ACTIONS = 200;

/** Resources a search returns unless asked for fewer. */
const DEFAULT_RESOURCE_LIMIT = 100;

/** The services whose non-read actions only an operator may hand out over MCP. */
const GUARDED_SERVICES = new Set(['iam', 'account', 'shell']);

/** Every action a token acting for nobody may not grant. */
const GUARDED_ACTIONS: string[] = IAM_ACTIONS
	.filter((spec) => GUARDED_SERVICES.has(spec.service) && spec.access !== 'read')
	.map((spec) => spec.name);

/**
 * Built-ins whose grant of those services is bounded by design: PowerUserAccess
 * excludes them, OwnerAccess reaches only what the account created, and
 * SelfServiceAccess only the account itself. AdministratorAccess is the one
 * built-in the document check refuses.
 */
const BOUNDED_BUILTINS = new Set(['poweruseraccess', 'readonlyaccess', 'owneraccess', 'selfserviceaccess', 'chatreadaccess', 'denychataccess']);

/**
 * Refuse a token limited to some instances, for reads too: policies and groups
 * speak for every resource at once, so neither reading nor changing them can be
 * narrowed to the instances such a token was given.
 */
function requireWholeConsole(ctx: ToolContext): void {
	if (ctx.principal.scope.instances !== null) {
		throw new ToolError('this token is limited to some instances, and access management covers the whole console, so the IAM tools are not available to it');
	}
}

function iso(time: number | null): string | null {
	return time === null
		? null
		: new Date(time).toISOString();
}

async function attempt<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (err) {
		if (err instanceof ToolError) {
			throw err;
		}

		throw new ToolError((err as Error).message);
	}
}

/** The one holder a call names; exactly one of `account` and `group`. */
function holder(args: ToolArgs): AttachTarget {
	const account = optStr(args, 'account')?.trim() || undefined;
	const group = optStr(args, 'group')?.trim() || undefined;

	if (account && group) {
		throw new ToolError('give either account or group, not both');
	}

	if (account) {
		return { account };
	}

	if (group) {
		return { group };
	}

	throw new ToolError('give an account or a group');
}

function holderLabel(target: AttachTarget): string {
	return 'account' in target
		? `account ${target.account}`
		: `group ${target.group}`;
}

/** The guarded actions one statement allows, regardless of its resources and conditions. */
function guardedGrants(statement: PolicyStatement): string[] {
	if (statement.Effect !== 'Allow') {
		return [];
	}

	if (statement.Action) {
		const patterns = statement.Action;

		return GUARDED_ACTIONS.filter((action) => patterns.some((pattern) => actionMatches(pattern, action)));
	}

	if (statement.NotAction) {
		const excluded = statement.NotAction;

		return GUARDED_ACTIONS.filter((action) => !excluded.some((pattern) => actionMatches(pattern, action)));
	}

	return [];
}

/** The first guarded action a document allows, or null when it allows none. */
function guardedGrant(document: PolicyDocument): string | null {
	for (const statement of document.Statement) {
		const granted = guardedGrants(statement);

		if (granted.length > 0) {
			return granted[0]!;
		}
	}

	return null;
}

/** The first guarded action a policy grants, built-ins answered by name. */
function policyGrant(policy: PolicySummary): string | null {
	if (policy.builtin && BOUNDED_BUILTINS.has(policy.name.toLowerCase())) {
		return null;
	}

	return guardedGrant(policy.document);
}

function refuseGrant(what: string, action: string): never {
	throw new ToolError(
		`${what} would grant ${action}, and this token acts for no console account, so it may not hand out access-management, account or shell permissions; an operator can do this from the console or the CLI`
	);
}

/** Refuse, for a token acting for nobody, attaching a policy that grants a guarded action. */
async function guardPolicyGrant(ctx: ToolContext, name: string, what: string): Promise<void> {
	if (ctx.account) {
		return;
	}

	const policy = await attempt(() => getPolicy(name));

	if (!policy) {
		throw new ToolError(`no policy named "${name}"`);
	}

	const action = policyGrant(policy);

	if (action) {
		refuseGrant(what, action);
	}
}

/** Refuse, for a token acting for nobody, joining accounts to a group that grants a guarded action. */
async function guardGroupGrant(ctx: ToolContext, group: GroupSummary): Promise<void> {
	if (ctx.account) {
		return;
	}

	for (const name of group.policies) {
		await guardPolicyGrant(ctx, name, `adding members to group ${group.name} (policy ${name})`);
	}

	for (const inline of group.inline) {
		const action = guardedGrant(inline.document);

		if (action) {
			refuseGrant(`adding members to group ${group.name} (inline policy ${inline.name})`, action);
		}
	}
}

/** The YAML's normalized document, or a refusal listing what is wrong with it. */
async function documentOf(yaml: string): Promise<PolicyDocument> {
	const result = await attempt(() => validatePolicyYaml(yaml));

	if (!result.ok || !result.document) {
		const issues = result.issues.map((issue) => `${issue.path || '/'}: ${issue.message}`).join('; ');

		throw new ToolError(`the policy document is not valid: ${issues}`);
	}

	return result.document;
}

function policyRow(policy: PolicySummary): Record<string, unknown> {
	return {
		name: policy.name,
		builtin: policy.builtin,
		description: policy.description,
		statements: policy.document.Statement.length,
		attachedTo: policy.attachedTo
	};
}

function policyDetail(policy: PolicySummary): Record<string, unknown> {
	return {
		name: policy.name,
		builtin: policy.builtin,
		description: policy.description,
		yaml: policy.yaml,
		attachedTo: policy.attachedTo,
		createdAt: iso(policy.createdAt),
		createdBy: policy.createdBy,
		updatedAt: iso(policy.updatedAt),
		updatedBy: policy.updatedBy
	};
}

function groupRow(group: GroupSummary): Record<string, unknown> {
	return {
		name: group.name,
		description: group.description,
		members: group.members.map((member) => member.username),
		policies: group.policies,
		inline: group.inline.map((inline) => inline.name)
	};
}

function groupDetail(group: GroupSummary): Record<string, unknown> {
	return {
		name: group.name,
		description: group.description,
		members: group.members.map((member) => member.username),
		policies: group.policies,
		inline: group.inline.map((inline) => ({
			name: inline.name,
			yaml: inline.yaml,
			updatedAt: iso(inline.updatedAt),
			updatedBy: inline.updatedBy
		})),
		createdAt: iso(group.createdAt),
		createdBy: group.createdBy,
		updatedAt: iso(group.updatedAt),
		updatedBy: group.updatedBy
	};
}

function resourceRow(resource: ResourceView): Record<string, unknown> {
	return {
		id: resource.id,
		type: resource.type,
		name: resource.name,
		createdBy: resource.createdBy,
		createdAt: iso(resource.createdAt),
		updatedBy: resource.updatedBy,
		updatedAt: iso(resource.updatedAt),
		tags: resource.tags,
		recorded: !resource.unknown
	};
}

function verdictRow(action: string, result: SimulationResult): Record<string, unknown> {
	const matched = result.verdict.matched;

	return {
		action,
		allowed: result.verdict.allowed,
		reason: result.verdict.reason,
		matched: matched
			? {
				policy: matched.source.name,
				kind: matched.source.kind,
				via: matched.source.group ?? null,
				sid: matched.sid
			}
			: null
	};
}

/** `key=value` filters into the store's tag filter; a bare key matches any value. */
function tagFilters(entries: string[]): Record<string, string> {
	const out: Record<string, string> = {};

	for (const entry of entries) {
		const equals = entry.indexOf('=');

		if (equals === 0) {
			throw new ToolError(`tag filter "${entry}" has no key`);
		}

		if (equals < 0) {
			out[entry.trim()] = '';

			continue;
		}

		out[entry.slice(0, equals).trim()] = entry.slice(equals + 1);
	}

	return out;
}

/** A resource id argument, refused when it is not `luna:<type>/<name>`. */
function resourceArg(args: ToolArgs): string {
	const id = str(args, 'id').trim();

	if (!parseResourceId(id)) {
		throw new ToolError(`"${id}" is not a resource id; use "luna:<type>/<name>", e.g. "luna:instance/survival"`);
	}

	return id;
}

/** Refuse, for a token acting for nobody, changing an account's tags: policies read them as principal tags. */
function guardTagging(ctx: ToolContext, id: string): void {
	if (ctx.account) {
		return;
	}

	if (parseResourceId(id)?.type === 'account') {
		throw new ToolError(
			'an account\'s tags are what policies read as luna:PrincipalTag, and this token acts for no console account, so it may not change them; an operator can do this from the console or the CLI'
		);
	}
}

export const IAM_HANDLERS: Record<string, ToolHandler> = {
	// -- iam -------------------------------------------------------------------
	async iam_policies_list(_args, ctx) {
		requireWholeConsole(ctx);

		const policies = await attempt(() => listPolicies());

		return { policies: policies.map(policyRow) };
	},

	async iam_policy_get(args, ctx) {
		requireWholeConsole(ctx);

		const name = str(args, 'name').trim();
		const policy = await attempt(() => getPolicy(name));

		if (!policy) {
			throw new ToolError(`no policy named "${name}"; iam_policies_list shows them`);
		}

		return policyDetail(policy);
	},

	async iam_policy_validate(args, ctx) {
		requireWholeConsole(ctx);

		const result = await attempt(() => validatePolicyYaml(str(args, 'yaml')));

		return {
			ok: result.ok,
			statements: result.statements,
			issues: result.issues.map((issue) => ({ path: issue.path, message: issue.message }))
		};
	},

	async iam_groups_list(_args, ctx) {
		requireWholeConsole(ctx);

		const groups = await attempt(() => listGroups());

		return { groups: groups.map(groupRow) };
	},

	async iam_group_get(args, ctx) {
		requireWholeConsole(ctx);

		const name = str(args, 'name').trim();
		const group = await attempt(() => getGroup(name));

		if (!group) {
			throw new ToolError(`no group named "${name}"; iam_groups_list shows them`);
		}

		return groupDetail(group);
	},

	async iam_account_permissions(args, ctx) {
		requireWholeConsole(ctx);

		const permissions = await attempt(() => accountPermissions(str(args, 'username').trim()));

		return {
			username: permissions.username,
			administrator: permissions.administrator,
			groups: permissions.groups.map((group) => ({
				name: group.name,
				policies: group.policies,
				inline: group.inline
			})),
			policies: permissions.policies,
			inline: permissions.inline.map((inline) => inline.name),
			tags: permissions.tags
		};
	},

	async iam_simulate(args, ctx) {
		requireWholeConsole(ctx);

		const account = str(args, 'account').trim();
		const actions = (optList(args, 'actions') ?? [])
			.map((action) => action.trim())
			.filter((action) => action !== '');

		if (actions.length === 0) {
			throw new ToolError('give at least one action, e.g. "instance:Start"');
		}

		if (actions.length > MAX_SIMULATED_ACTIONS) {
			throw new ToolError(`at most ${MAX_SIMULATED_ACTIONS} actions per simulation`);
		}

		const resource = optStr(args, 'resource')?.trim() || null;
		const results = [];

		for (const action of actions) {
			const result = await attempt(() => simulatePrincipal(account, action, resource));

			results.push(verdictRow(action, result));
		}

		return { account, resource, results };
	},

	async iam_audit(args, ctx) {
		requireWholeConsole(ctx);

		const entries = await attempt(() => iamAudit({
			target: optStr(args, 'target')?.trim() || undefined,
			limit: optInt(args, 'limit') ?? 50
		}));

		return {
			entries: entries.map((entry) => ({
				time: new Date(entry.t).toISOString(),
				action: entry.action,
				actor: entry.actor ?? null,
				target: entry.target ?? null,
				detail: entry.detail ?? null
			}))
		};
	},

	async resources_find(args, ctx) {
		requireWholeConsole(ctx);

		const filter: ResourceFilter = {};
		const type = optStr(args, 'type')?.trim();

		if (type) {
			if (!isResourceType(type)) {
				throw new ToolError(`"${type}" is not a resource type`);
			}

			filter.type = type;
		}

		const tags = optList(args, 'tags');

		if (tags && tags.length > 0) {
			filter.tags = tagFilters(tags);
		}

		const createdBy = optStr(args, 'createdBy')?.trim();

		if (createdBy) {
			filter.createdBy = createdBy;
		}

		const limit = optInt(args, 'limit') ?? DEFAULT_RESOURCE_LIMIT;
		const resources = await attempt(() => listResources(filter));

		return {
			total: resources.length,
			truncated: resources.length > limit,
			resources: resources.slice(0, limit).map(resourceRow)
		};
	},

	async resource_get(args, ctx) {
		requireWholeConsole(ctx);

		const id = resourceArg(args);

		return resourceRow(await attempt(() => describeResource(id)));
	},

	// -- iam-write -------------------------------------------------------------
	async iam_policy_create(args, ctx) {
		requireWholeConsole(ctx);

		const policy = await attempt(() => createPolicy({
			name: str(args, 'name'),
			description: optStr(args, 'description'),
			yaml: str(args, 'yaml')
		}, ctx.actor));

		return { ...policyDetail(policy), note: 'a new policy grants nothing until it is attached' };
	},

	async iam_policy_update(args, ctx) {
		requireWholeConsole(ctx);

		const name = str(args, 'name').trim();
		const yaml = optStr(args, 'yaml');

		if (yaml !== undefined && !ctx.account) {
			const current = await attempt(() => getPolicy(name));
			const attached = current
				? current.attachedTo.accounts.length + current.attachedTo.groups.length > 0
				: false;

			if (attached) {
				const action = guardedGrant(await documentOf(yaml));

				if (action) {
					refuseGrant(`rewriting attached policy ${name}`, action);
				}
			}
		}

		const policy = await attempt(() => updatePolicy(name, {
			name: optStr(args, 'newName'),
			description: optStr(args, 'description'),
			yaml
		}, ctx.actor));

		return policyDetail(policy);
	},

	async iam_policy_delete(args, ctx) {
		requireWholeConsole(ctx);

		const name = str(args, 'name').trim();

		await attempt(() => deletePolicy(name, ctx.actor));

		return { deleted: name };
	},

	async iam_group_create(args, ctx) {
		requireWholeConsole(ctx);

		const name = str(args, 'name').trim();
		const policies = optList(args, 'policies') ?? [];

		for (const policy of policies) {
			await guardPolicyGrant(ctx, policy, `attaching ${policy} to group ${name}`);
		}

		const group = await attempt(() => createGroup({
			name,
			description: optStr(args, 'description'),
			policies,
			members: optList(args, 'members') ?? []
		}, ctx.actor));

		return groupDetail(group);
	},

	async iam_group_update(args, ctx) {
		requireWholeConsole(ctx);

		const group = await attempt(() => updateGroup(str(args, 'name').trim(), {
			name: optStr(args, 'newName'),
			description: optStr(args, 'description')
		}, ctx.actor));

		return groupDetail(group);
	},

	async iam_group_delete(args, ctx) {
		requireWholeConsole(ctx);

		const name = str(args, 'name').trim();

		await attempt(() => deleteGroup(name, ctx.actor));

		return { deleted: name };
	},

	async iam_group_members(args, ctx) {
		requireWholeConsole(ctx);

		const name = str(args, 'group').trim();
		const add = optList(args, 'add') ?? [];
		const remove = optList(args, 'remove') ?? [];

		if (add.length === 0 && remove.length === 0) {
			throw new ToolError('give accounts to add or to remove');
		}

		let group = await attempt(() => getGroup(name));

		if (!group) {
			throw new ToolError(`no group named "${name}"; iam_groups_list shows them`);
		}

		if (add.length > 0) {
			await guardGroupGrant(ctx, group);

			group = await attempt(() => addGroupMembers(name, add, ctx.actor));
		}

		if (remove.length > 0) {
			group = await attempt(() => removeGroupMembers(name, remove, ctx.actor));
		}

		return groupDetail(group);
	},

	async iam_attach(args, ctx) {
		requireWholeConsole(ctx);

		const policy = str(args, 'policy').trim();
		const target = holder(args);

		await guardPolicyGrant(ctx, policy, `attaching ${policy} to ${holderLabel(target)}`);
		await attempt(() => attachPolicy(target, policy, ctx.actor));

		return { attached: policy, to: target };
	},

	async iam_detach(args, ctx) {
		requireWholeConsole(ctx);

		const policy = str(args, 'policy').trim();
		const target = holder(args);

		await attempt(() => detachPolicy(target, policy, ctx.actor));

		return { detached: policy, from: target };
	},

	async iam_inline_put(args, ctx) {
		requireWholeConsole(ctx);

		const name = str(args, 'name').trim();
		const yaml = str(args, 'yaml');
		const target = holder(args);

		if (!ctx.account) {
			const action = guardedGrant(await documentOf(yaml));

			if (action) {
				refuseGrant(`inline policy ${name} on ${holderLabel(target)}`, action);
			}
		}

		const inline = await attempt(() => putInlinePolicy(target, name, yaml, ctx.actor));

		return {
			name: inline.name,
			on: target,
			statements: inline.document.Statement.length,
			updatedAt: iso(inline.updatedAt),
			updatedBy: inline.updatedBy
		};
	},

	async iam_inline_delete(args, ctx) {
		requireWholeConsole(ctx);

		const name = str(args, 'name').trim();
		const target = holder(args);

		await attempt(() => deleteInlinePolicy(target, name, ctx.actor));

		return { deleted: name, from: target };
	},

	async resource_tag(args, ctx) {
		requireWholeConsole(ctx);

		const id = resourceArg(args);
		const raw = args.tags;

		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
			throw new ToolError('tags must be an object of key to value');
		}

		const tags: Record<string, string> = {};

		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof value !== 'string') {
				throw new ToolError(`tag "${key}" must have a string value`);
			}

			tags[key] = value;
		}

		if (Object.keys(tags).length === 0) {
			throw new ToolError('give at least one tag');
		}

		guardTagging(ctx, id);

		return resourceRow(await attempt(() => tagResource(id, tags, ctx.actor)));
	},

	async resource_untag(args, ctx) {
		requireWholeConsole(ctx);

		const id = resourceArg(args);
		const keys = optList(args, 'keys') ?? [];

		if (keys.length === 0) {
			throw new ToolError('give at least one tag key');
		}

		guardTagging(ctx, id);

		return resourceRow(await attempt(() => untagResource(id, keys, ctx.actor)));
	}
};
