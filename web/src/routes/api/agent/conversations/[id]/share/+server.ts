// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { AGENT_SHARE_ROLES, shareAgentConversation } from '$core/agent';
import type { AgentShareRole } from '$core/agent';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { requireRole } from '$lib/server/agent/sharing';

/**
 * POST { account, role } → the conversation: share it with a console account
 * as a `viewer` or a `collaborator`, change that account's role, or take the
 * share back (`role: null`). Only the owner may.
 */
export async function POST({ params, request, locals }) {
	const { account } = await requireRole(locals, params.id, ['owner']);
	const body = await jsonBody(request);
	const target = String(body.account ?? '').trim().slice(0, 64);
	const role = body.role === null
		? null
		: (AGENT_SHARE_ROLES as readonly string[]).includes(String(body.role))
			? (body.role as AgentShareRole)
			: undefined;

	if (!target || role === undefined) {
		throw error(400, 'give an account and a role (viewer, collaborator, or null to stop sharing)');
	}

	try {
		const conversation = await shareAgentConversation(params.id, account, target, role);

		journal(role ? `shared a Mèo Béo conversation with ${target} (${role})` : `stopped sharing a Mèo Béo conversation with ${target}`, {
			actor: account,
			detail: params.id
		});

		return json({ conversation });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
