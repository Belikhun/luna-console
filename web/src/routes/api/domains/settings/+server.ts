// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { updateDomainSettings } from '$core/domains';
import type { SettingsPatch } from '$core/domains';
import { errorMessage, jsonBody } from '$lib/server/http';
import { journal } from '$lib/server/session';

/**
 * PATCH { provider?, baseDomain?, publicAddress?, ttl? } → the settings view.
 * A provider patch with an empty apiKey keeps the stored key, so the form never
 * needs the key back to save the other fields.
 */
export async function PATCH({ request, locals }) {
	const body = await jsonBody(request);
	const actor = locals.account?.username ?? 'console';
	const patch: SettingsPatch = {};

	if (body.provider === null) {
		patch.provider = null;
	} else if (body.provider && typeof body.provider === 'object') {
		patch.provider = {
			apiUser: String(body.provider.apiUser ?? ''),
			userName: String(body.provider.userName ?? ''),
			clientIp: String(body.provider.clientIp ?? ''),
			apiKey: String(body.provider.apiKey ?? ''),
			sandbox: body.provider.sandbox === true
		};
	}

	if (typeof body.baseDomain === 'string') {
		patch.baseDomain = body.baseDomain;
	}

	if (body.publicAddress === null || typeof body.publicAddress === 'string') {
		patch.publicAddress = body.publicAddress || null;
	}

	if (typeof body.dropUnsupported === 'boolean') {
		patch.dropUnsupported = body.dropUnsupported;
	}

	if (typeof body.ttl === 'number') {
		patch.ttl = body.ttl;
	}

	try {
		const settings = await updateDomainSettings(patch, actor);

		journal('domain settings changed', { actor, detail: Object.keys(patch).join(', ') });

		return json(settings);
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
