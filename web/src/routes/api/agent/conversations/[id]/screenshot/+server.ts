// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { deliverPanelAnswer, MAX_SCREENSHOT_BYTES } from '$lib/server/agent/runner';

/** The formats a panel's render may arrive in. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * POST ?request=<id>&page=&w=&h= with the image as the raw body → { ok }. The
 * panel's answer to a `screenshot` event: the console as this browser shows it.
 * Only the conversation's owner can answer, and only a request still waiting.
 */
export async function POST({ params, request, url, locals }) {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	const mime = (request.headers.get('content-type') ?? '').split(';')[0]!.trim();

	if (!IMAGE_TYPES.has(mime)) {
		throw error(415, 'a screenshot is a JPEG, PNG or WebP image');
	}

	const bytes = new Uint8Array(await request.arrayBuffer());

	if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCREENSHOT_BYTES) {
		throw error(413, 'the screenshot is empty or too large');
	}

	const delivered = deliverPanelAnswer(params.id, locals.account.username, url.searchParams.get('request') ?? '', {
		bytes,
		mime,
		page: (url.searchParams.get('page') ?? '').slice(0, 500),
		width: Number(url.searchParams.get('w') ?? 0),
		height: Number(url.searchParams.get('h') ?? 0)
	});

	if (!delivered) {
		throw error(404, 'nothing is waiting for that screenshot');
	}

	return json({ ok: true });
}
