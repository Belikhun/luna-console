// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { MAX_UPLOAD_BYTES, stageUpload } from '$lib/server/agent/uploads';

/**
 * POST ?name=<file name> with the file as the raw body → { id, name, size }.
 *
 * A file attached in Mèo Béo's panel, staged until a tool installs it. The body
 * is the bytes themselves (`application/octet-stream`), not base64 inside JSON:
 * a jar is megabytes, and that content type is not one a cross-site form can
 * send, which is the CSRF property the JSON uploads elsewhere rely on.
 */
export async function POST({ request, url, locals }) {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	if (!request.headers.get('content-type')?.startsWith('application/octet-stream')) {
		throw error(415, 'send the file as application/octet-stream');
	}

	const declared = Number(request.headers.get('content-length') ?? 0);

	if (declared > MAX_UPLOAD_BYTES) {
		throw error(413, `attachments are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
	}

	const bytes = new Uint8Array(await request.arrayBuffer());

	if (bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) {
		throw error(413, `attachments are limited to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
	}

	const upload = await stageUpload(locals.account.username, url.searchParams.get('name') ?? 'file', bytes);

	return json({ id: upload.id, name: upload.name, size: upload.size });
}
