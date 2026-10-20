// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What the signed-in account may do, as the browser can tell.
 *
 * The root layout hands the principal's context (its documents and tags) to
 * this store, and `can` evaluates the same grammar the server gate does. It is
 * for the chrome and the verbs: hiding a nav entry the account could not open,
 * disabling a button with its reason. It is **not** the decision: every API
 * call is decided by the daemon, which also knows the resource's record. A
 * check here about a resource takes the facts the page has (`facts`), or asks
 * the server for a batch through `/api/iam/can` when it has none.
 */

import { post } from '$lib/api';
import { evaluate, type AccessRequest, type PrincipalContext, type Verdict } from '$shared/iam/grammar';
import { parseResourceId } from '$shared/iam/resources';

export interface ResourceFacts {
	tags?: Record<string, string>;
	createdBy?: string | null;
}

let principal = $state<PrincipalContext | null>(null);

/** Server-decided answers for resource checks, keyed `action|resource`. */
let decided = $state<Record<string, boolean>>({});

export const Authz = {
	get principal(): PrincipalContext | null {
		return principal;
	},

	/** The root layout calls this with what `+layout.server.ts` loaded. */
	adopt(context: PrincipalContext | null): void {
		principal = context;
		decided = {};
	},

	/**
	 * Evaluate locally. With no resource, or with the resource's facts in hand,
	 * the answer is the gate's; with a resource and no facts, a condition about
	 * its tags or creator cannot match, so an owner-only grant reads as denied
	 * and `check` should be asked instead.
	 */
	verdict(action: string, resource: string | null = null, facts: ResourceFacts = {}): Verdict {
		if (!principal) {
			return { allowed: false, reason: 'implicit-deny' };
		}

		const request: AccessRequest = {
			action,
			resource,
			resourceType: resource ? (parseResourceId(resource)?.type ?? null) : null,
			resourceTags: facts.tags ?? {},
			resourceCreator: facts.createdBy ?? null
		};

		return evaluate(principal, request);
	},

	can(action: string, resource: string | null = null, facts: ResourceFacts = {}): boolean {
		return this.verdict(action, resource, facts).allowed;
	},

	/** A server-decided answer once `check` fetched it; undefined until then. */
	decided(action: string, resource: string): boolean | undefined {
		return decided[`${action}|${resource}`];
	},

	/** Ask the server to decide several resource checks at once, for a screen's verbs. */
	async check(checks: Array<{ action: string; resource: string }>): Promise<Record<string, boolean>> {
		const wanted = checks.filter((entry) => decided[`${entry.action}|${entry.resource}`] === undefined);

		if (wanted.length > 0) {
			const answers = await post<{ results: Record<string, boolean> }>('/iam/can', { checks: wanted });

			decided = { ...decided, ...answers.results };
		}

		const out: Record<string, boolean> = {};

		for (const entry of checks) {
			out[`${entry.action}|${entry.resource}`] = decided[`${entry.action}|${entry.resource}`] ?? false;
		}

		return out;
	}
};
