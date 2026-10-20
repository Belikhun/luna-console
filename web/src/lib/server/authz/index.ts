// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The console gate's decision, and the helpers a handler uses for the checks
 * the catalog cannot express: filtering a listing to the rows an account may
 * see, or refusing one branch of a many-verb route.
 *
 * Every decision is the daemon's (`iam.authorize`), which reads the resource's
 * record for the condition keys; nothing here evaluates a policy on its own.
 */

import { error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';

import { ROOT_ACTOR } from '$core/accounts';
import { authorize, authorizeMany } from '$core/iam';
import type { Verdict } from '$shared/iam/grammar';

import { API_RULES, PAGE_ASYNC_RULES, ruleAction, type Method, type RuleContext } from './routes';
import { PAGE_RULES } from '$lib/authz/pages';

export interface Refusal {
	action: string;
	resource: string | null;
	verdict: Verdict;
}

export type GateOutcome =
	| { kind: 'allowed' }
	| { kind: 'refused'; refusal: Refusal }
	| { kind: 'unlisted' };

/**
 * Decide a request from the catalogs. An API route with no rule is `unlisted`,
 * which the hook refuses; a page with no rule needs only a session.
 */
export async function gate(event: RequestEvent): Promise<GateOutcome> {
	const routeId = event.route.id;
	const username = event.locals.account?.username;

	if (!routeId || !username) {
		return { kind: 'allowed' };
	}

	const ctx: RuleContext = {
		params: event.params as Record<string, string>,
		url: event.url,
		request: event.request
	};

	if (routeId.startsWith('/api/')) {
		const rules = API_RULES[routeId];
		const rule = rules?.[event.request.method as Method];

		if (!rule) {
			return { kind: 'unlisted' };
		}

		if (rule === 'session') {
			return { kind: 'allowed' };
		}

		const action = await ruleAction(rule, ctx);
		const resource = rule.resource ? await rule.resource(ctx) : null;

		return await decide(username, action, resource);
	}

	const asyncRule = PAGE_ASYNC_RULES[routeId];

	if (asyncRule) {
		const resource = asyncRule.resource ? await asyncRule.resource(ctx) : null;

		return await decide(username, asyncRule.action, resource);
	}

	const pageRule = PAGE_RULES[routeId];

	if (!pageRule) {
		return { kind: 'allowed' };
	}

	const resource = pageRule.resource ? pageRule.resource(ctx.params) : null;

	return await decide(username, pageRule.action, resource);
}

async function decide(username: string, action: string, resource: string | null): Promise<GateOutcome> {
	const result = await authorize(username, action, resource);

	if (result.verdict.allowed) {
		return { kind: 'allowed' };
	}

	return { kind: 'refused', refusal: { action, resource, verdict: result.verdict } };
}

/** The body a refused API call answers with; `$lib/api` surfaces `message` verbatim. */
export function refusalBody(refusal: Refusal): Record<string, unknown> {
	const where = refusal.resource ? ` on ${refusal.resource}` : '';
	const why = refusal.verdict.reason === 'explicit-deny' ? 'denied by policy' : 'not allowed by any policy';

	return {
		message: `${refusal.action}${where}: ${why}`,
		action: refusal.action,
		resource: refusal.resource,
		reason: refusal.verdict.reason,
		matched: refusal.verdict.matched ?? null
	};
}

/** Whether the signed-in account may perform one action; `root` (no session) always may. */
export async function can(locals: App.Locals, action: string, resource: string | null = null): Promise<boolean> {
	const username = locals.account?.username ?? ROOT_ACTOR;
	const result = await authorize(username, action, resource);

	return result.verdict.allowed;
}

/** Refuse with 403 unless the account may perform the action; for the branches a catalog rule cannot name. */
export async function requireAllowed(locals: App.Locals, action: string, resource: string | null = null): Promise<void> {
	const username = locals.account?.username ?? ROOT_ACTOR;
	const result = await authorize(username, action, resource);

	if (!result.verdict.allowed) {
		throw error(403, refusalBody({ action, resource, verdict: result.verdict }) as never);
	}
}

/**
 * Keep the rows the account may see: `idOf` names each row's resource, and one
 * daemon read decides them all. What a list route does after `*:List` let it
 * in, so an account that owns two instances sees two.
 */
export async function filterAllowed<T>(
	locals: App.Locals,
	action: string,
	rows: T[],
	idOf: (row: T) => string
): Promise<T[]> {
	if (rows.length === 0) {
		return rows;
	}

	const username = locals.account?.username ?? ROOT_ACTOR;
	const ids = [...new Set(rows.map(idOf))];
	const allowed = await authorizeMany(username, action, ids);

	return rows.filter((row) => allowed[idOf(row)]);
}
