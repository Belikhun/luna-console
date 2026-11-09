// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { agentStatus } from '$core/agent';
import { MIN_UPLOAD_BYTES, UploadTooLarge, stageUpload, type StagedUpload } from '$lib/server/agent/uploads';

/**
 * POST ?name=<file name> with the file as the raw body → { id, name, size }.
 *
 * A file attached in Mèo Béo's panel, staged until a tool installs it. The body
 * is the bytes themselves (`application/octet-stream`), not base64 inside JSON:
 * a jar is megabytes, and that content type is not one a cross-site form can
 * send, which is the CSRF property the JSON uploads elsewhere rely on. The cap
 * follows the attachment copy limit, since a file the agent may open has to
 * get here first.
 */
export async function POST({ request, url, locals }) {
	if (!locals.account) {
		throw error(401, 'sign in first');
	}

	if (!request.headers.get('content-type')?.startsWith('application/octet-stream')) {
		throw error(415, 'send the file as application/octet-stream');
	}

	const status = await agentStatus();
	const maxBytes = Math.max(MIN_UPLOAD_BYTES, status.settings.scratchAttachmentMb * 1024 * 1024);
	const tooLarge = `attachments are limited to ${Math.round(maxBytes / 1024 / 1024)} MB`;
	const declared = Number(request.headers.get('content-length') ?? 0);

	if (declared > maxBytes) {
		throw error(413, tooLarge);
	}

	if (!request.body) {
		throw error(400, 'the file is empty');
	}

	let upload: StagedUpload | null;

	try {
		upload = await stageUpload(locals.account.username, url.searchParams.get('name') ?? 'file', request.body, maxBytes);
	} catch (err) {
		if (err instanceof UploadTooLarge) {
			throw error(413, tooLarge);
		}

		throw err;
	}

	if (!upload) {
		throw error(400, 'the file is empty');
	}

	return json({ id: upload.id, name: upload.name, size: upload.size });
}
