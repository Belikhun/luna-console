// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import { placeUpload, statInstancePath } from '$core/instancefiles';
import { discardStage } from '$core/world';
import { daemonFetch, pushEvent } from '$lib/server/luna';
import { journal } from '$lib/server/session';
import { errorMessage } from '$lib/server/http';

/**
 * Bytes the console sends in one chunk; the daemon appends each to the staged
 * file. Large enough that a fast link is not request-bound, small enough that a
 * retry after a dropped connection costs seconds rather than minutes.
 */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * The upload handshake around the chunks (`./[token]` carries those).
 *
 * POST { action: 'begin',  path, size }                → { token, exists, chunkSize }
 * POST { action: 'finish', token, path, size, overwrite } → the placed entry
 * POST { action: 'cancel', token }
 *
 * The bytes are staged on the primary under the token, and `finish` asks the
 * daemon owning the instance to place them: a follower pulls the staged copy
 * over the link first. The primary's own copy is discarded once that returns,
 * since a remote placement leaves it behind.
 */
export async function POST({ params, request, locals }) {
	const cfg = await loadCluster();
	const name = params.name;

	if (!managedInstances(cfg)[name]) {
		throw error(404, 'unknown instance');
	}

	const body = await request.json();
	const action = String(body.action ?? '');
	const actor = locals.account?.username ?? 'console';

	try {
		if (action === 'begin') {
			const path = requirePath(body.path);
			const existing = await statInstancePath(cfg, name, path);

			if (existing?.kind === 'dir') {
				throw error(409, `${path} is a directory`);
			}

			const token = crypto.randomUUID().replace(/-/g, '');

			return json({ ok: true, token, exists: !!existing, chunkSize: UPLOAD_CHUNK_BYTES });
		}

		if (action === 'finish') {
			const path = requirePath(body.path);
			const token = requireToken(body.token);
			const size = Number(body.size);

			try {
				const entry = await placeUpload(cfg, name, token, path, {
					overwrite: body.overwrite === true,
					...(Number.isFinite(size) ? { expectedSize: size } : {})
				});

				pushEvent(name, 'action', `uploaded by ${actor}: ${entry.path}`);
				journal(`${name}: ${entry.path} uploaded (${entry.size} bytes)`, { actor });

				return json({ ok: true, entry });
			} finally {
				await discardStage(token).catch(() => undefined);
			}
		}

		if (action === 'cancel') {
			await discardStage(requireToken(body.token)).catch(() => undefined);

			return json({ ok: true });
		}
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) {
			throw err;
		}

		throw error(400, errorMessage(err));
	}

	throw error(400, `unknown action: ${action}`);
}

/** GET ?token=<token> → how much of that upload the daemon holds, for a resume. */
export async function GET({ url }) {
	const token = requireToken(url.searchParams.get('token'));
	const upstream = await daemonFetch(`/files/stage/${encodeURIComponent(token)}/status`);
	const status = (await upstream.json()) as { ok?: boolean; bytes?: number; complete?: boolean; error?: string };

	if (!upstream.ok || !status.ok) {
		throw error(400, status.error ?? 'could not read the upload status');
	}

	return json({ ok: true, bytes: status.bytes ?? 0, complete: !!status.complete });
}

function requirePath(value: unknown): string {
	const path = String(value ?? '').trim();

	if (!path) {
		throw error(400, 'path is required');
	}

	return path;
}

function requireToken(value: unknown): string {
	const token = String(value ?? '').trim();

	if (!/^[a-z0-9]{8,64}$/.test(token)) {
		throw error(400, 'a valid upload token is required');
	}

	return token;
}
