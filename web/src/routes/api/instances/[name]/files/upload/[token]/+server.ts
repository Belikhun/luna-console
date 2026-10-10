// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { daemonFetch } from '$lib/server/luna';

/**
 * PUT ?offset=N&total=M with one chunk as the raw body → { bytes, complete }.
 *
 * Streamed straight through to the daemon's staging endpoint, which appends it
 * at `offset`; this process never holds a chunk. A 409 carries the size the
 * daemon actually has, and the client resumes from it. `application/octet-stream`
 * rather than multipart for the CSRF reason every raw upload here shares: it is
 * not a content type a cross-origin form can send.
 */
export async function PUT({ params, request, url }) {
	const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim();

	if (type !== 'application/octet-stream') {
		throw error(415, 'expected application/octet-stream');
	}

	const offset = url.searchParams.get('offset');
	const total = url.searchParams.get('total');

	if (offset === null || total === null) {
		throw error(400, 'offset and total are required');
	}

	// an empty file is one empty chunk, and an empty request has no body stream
	if (!request.body && total !== '0') {
		throw error(400, 'empty body');
	}

	const query = new URLSearchParams({ offset, total });
	const upstream = await daemonFetch(`/files/stage/${encodeURIComponent(params.token)}?${query.toString()}`, {
		method: 'PUT',
		body: request.body ?? new Uint8Array(0),
		headers: { 'content-type': 'application/octet-stream' },
		// Bun needs telling that the body is a stream it should send as it reads
		duplex: 'half'
	} as RequestInit);

	const body = (await upstream.json().catch(() => ({}))) as {
		ok?: boolean;
		error?: string;
		bytes?: number;
		complete?: boolean;
	};

	if (!upstream.ok || !body.ok) {
		// a 409 is a resume instruction, not a failure: the daemon says how far it got
		return json(
			{ ok: false, error: body.error ?? 'chunk refused', bytes: body.bytes ?? 0, complete: !!body.complete },
			{ status: upstream.status === 409 ? 409 : upstream.status === 413 ? 413 : 400 }
		);
	}

	return json({ ok: true, bytes: body.bytes ?? 0, complete: !!body.complete });
}
