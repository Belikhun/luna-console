// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { AGENT_EFFORTS, AGENT_MODELS, agentStatus, updateAgentSettings } from '$core/agent';
import type { AgentSettingsPatch } from '$core/agent';
import { errorMessage, jsonBody } from '$lib/server/http';
import { findClaudeExecutable } from '$lib/server/agent/executable';
import { knowledgeFor } from '$core/mcp';
import { can } from '$lib/server/authz';
import { knowledgeVisible } from '$lib/server/mcp/iam';

/**
 * Mèo Béo's state for the panel and its settings: whether it can answer, the
 * credential described (never shown), the settings, the MCP token it acts
 * through, the executable a run would use, and the models to offer.
 */

/** `claude-sonnet-5-5` → `Sonnet 5.5`, for the list offered before a connection test has run. */
function modelName(id: string): string {
	const match = /^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{8})?$/.exec(id);

	if (!match) {
		return id;
	}

	const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
	const version = match[3] ? `${match[2]}.${match[3]}` : match[2];

	return `${family} ${version}`;
}

/**
 * GET → status, executable and model choices. An account that may chat but not
 * configure gets what the panel needs: the credential, the token, the
 * executable and the operators' instructions stay with the settings screen.
 */
export async function GET({ locals }) {
	const status = await agentStatus();
	const configures = await can(locals, 'agent:Configure');
	const reported = status.models;
	const tokenSkills = status.token
		? await knowledgeFor(status.token.id, 'skill').catch(() => [])
		: [];
	const skills = await knowledgeVisible(locals.account?.username, tokenSkills);

	const view = configures
		? { ...status, executable: findClaudeExecutable(status.settings.executable) }
		: {
				...status,
				credential: null,
				token: null,
				settings: { ...status.settings, instructions: '', executable: '' },
				executable: { source: '' }
			};

	return json({
		...view,
		models: reported ?? AGENT_MODELS.map((value) => ({ value, label: modelName(value), description: '' })),
		modelsReported: reported !== null,
		efforts: AGENT_EFFORTS,
		skills: skills
			.filter((skill) => skill.enabled)
			.map((skill) => ({ name: skill.title, description: skill.description }))
	});
}

/** PATCH { enabled?, model?, effort?, instructions?, maxTurns?, executable?, bypassAllowed? } → status. */
export async function PATCH({ request, locals }) {
	const body = await jsonBody(request);
	const patch: AgentSettingsPatch = {};

	for (const key of ['enabled', 'model', 'effort', 'instructions', 'maxTurns', 'executable', 'bypassAllowed'] as const) {
		if (body[key] !== undefined) {
			(patch as Record<string, unknown>)[key] = body[key];
		}
	}

	try {
		return json(await updateAgentSettings(patch, locals.account?.username));
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
