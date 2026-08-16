// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { newStageToken } from '$core/world';

/**
 * POST → mint a staging token and say where to send the bytes.
 *
 * Two steps on purpose. The upload itself can run for many minutes, so
 * everything cheap that could refuse it - a bad instance, a file that is not a
 * zip, an implausible size - happens here, before the first byte moves rather
 * than after the last one. It also means a retried upload reuses one token
 * instead of leaving a trail of abandoned half-files.
 */
export async function POST({ request }) {
	const body = await request.json();
	const fileName = String(body.fileName ?? '').trim();
	const sizeBytes = Number(body.sizeBytes ?? 0);

	if (!fileName.toLowerCase().endsWith('.zip')) {
		throw error(400, 'a world must be a .zip');
	}

	if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
		throw error(400, 'sizeBytes is required');
	}

	const token = newStageToken();

	return json({
		ok: true,
		stage: {
			token,
			fileName,
			sizeBytes,
			uploadUrl: `/api/worlds/stage/${token}`
		}
	});
}
