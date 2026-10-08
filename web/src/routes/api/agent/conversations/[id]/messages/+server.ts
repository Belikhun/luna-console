// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { MAX_AGENT_MESSAGE } from '$core/agent';
import { ensureConnected } from '$client/socket';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';
import { loopbackOrigin } from '$lib/server/agent/origin';
import { AgentRunError, startRun } from '$lib/server/agent/runner';
import { DEFAULT_AGENT_MODE, isAgentMode } from '$shared/agent';

/**
 * POST { text, locale?, mode?, model?, effort?, page? } → { ok, joined } once the
 * run is under way, or once the message joined the run already going (`joined`,
 * in which case the stream echoes it); the answer arrives on the stream. `model` and `effort` override the
 * settings for this message, and `page` is the console path the operator chose
 * to share.
 */
export async function POST({ params, request, url, locals }) {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	const body = await jsonBody(request);
	const text = String(body.text ?? '').trim();

	if (!text && !(Array.isArray(body.attachments) && body.attachments.length)) {
		throw error(400, 'empty message');
	}

	if (text.length > MAX_AGENT_MESSAGE) {
		throw error(400, `messages are limited to ${MAX_AGENT_MESSAGE} characters`);
	}

	const info = await ensureConnected();
	const actor = locals.account.username;
	const mode = isAgentMode(body.mode)
		? body.mode
		: DEFAULT_AGENT_MODE;
	const page = typeof body.page === 'string' && body.page.startsWith('/')
		? body.page.slice(0, 300)
		: undefined;
	const attachments = Array.isArray(body.attachments)
		? body.attachments
			.filter((file: unknown): file is { id: string; name: string; size: number } =>
				typeof file === 'object' &&
				file !== null &&
				/^att_[0-9a-f]{16}$/.test(String((file as { id?: unknown }).id)))
			.slice(0, 10)
			.map((file: { id: string; name: string; size: number }) => ({
				id: file.id,
				name: String(file.name ?? 'file').slice(0, 200),
				size: Number(file.size) || 0
			}))
		: [];

	let joined = false;

	try {
		joined = await startRun({
			conversationId: params.id,
			owner: actor,
			text,
			locale: body.locale === 'vi' ? 'Vietnamese' : 'English',
			origin: loopbackOrigin(url),
			machine: info.name,
			mode,
			model: typeof body.model === 'string' ? body.model.trim() : undefined,
			effort: typeof body.effort === 'string' ? body.effort : undefined,
			page,
			attachments
		});
	} catch (err) {
		const code = err instanceof AgentRunError
			? err.code
			: undefined;

		return json({ ok: false, code, error: errorMessage(err) }, { status: 409 });
	}

	// a bypass run acts without anyone approving each step, so it is worth a line
	// in the journal; the other modes are only noise there
	if (mode === 'bypass') {
		journal(`Mèo Béo running in bypass mode in ${params.id}`, { actor, level: 'warn', detail: text.slice(0, 300) });
	}

	return json({ ok: true, joined });
}
