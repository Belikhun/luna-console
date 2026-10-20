// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { simulatePrincipal, type SimulationOptions } from '$core/iam';
import { errorMessage, jsonBody } from '$lib/server/http';

/** The most actions one simulation request may ask about. */
const MAX_ACTIONS = 200;

/** A string → string map from the body, or undefined when the field is absent or not one. */
function tagMap(value: unknown): Record<string, string> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}

	const out: Record<string, string> = {};

	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		out[key] = String(entry ?? '');
	}

	return out;
}

/**
 * POST { account, action | actions[], resource?, policies?, resourceTags?, resourceCreator?, requestTags? }
 * → the verdict and the statement that decided it, or `{ results }` for a list of actions.
 *
 * `policies` names the attachments to evaluate (source keys or policy names);
 * the overrides stand in for the resource's recorded facts. Nothing is stored.
 */
export async function POST({ request }) {
	const body = await jsonBody(request);
	const account = String(body.account ?? '');
	const batch = Array.isArray(body.actions);

	const actions: string[] = batch
		? (body.actions as unknown[]).map(String).filter(Boolean).slice(0, MAX_ACTIONS)
		: [String(body.action ?? '')].filter(Boolean);

	if (!account || actions.length === 0) {
		throw error(400, 'an account and an action are required');
	}

	const resource = typeof body.resource === 'string' && body.resource ? body.resource : null;

	const options: SimulationOptions = {
		policies: Array.isArray(body.policies) ? body.policies.map(String) : undefined,
		resourceTags: tagMap(body.resourceTags),
		resourceCreator: typeof body.resourceCreator === 'string' ? body.resourceCreator || null : undefined,
		requestTags: tagMap(body.requestTags)
	};

	try {
		if (!batch) {
			return json(await simulatePrincipal(account, actions[0]!, resource, options));
		}

		const results = [];

		for (const action of actions) {
			results.push(await simulatePrincipal(account, action, resource, options));
		}

		return json({ results });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
