// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, managedInstances } from '$core/config';
import { discardStage, scanArchiveFor, scanStagedWorld, stageInfo } from '$core/world';
import { daemonFetch } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * PUT → the world zip's bytes, streamed through to the daemon.
 *
 * `application/octet-stream` rather than multipart or base64. SvelteKit's CSRF
 * check refuses form-encoded and multipart posts, which is why every small
 * upload in this console goes base64-inside-JSON; base64 costs a third again in
 * size and has to be buffered whole, which is fine for a plugin jar and
 * impossible for a world. A raw body is not a form content type, so it passes
 * the check and can be piped straight through without ever being held here.
 */
export async function PUT({ params, request }) {
	if (!request.body) {
		throw error(400, 'empty body');
	}

	const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim();

	// an explicit refusal, so no cross-origin form can ever reach this route by
	// arriving with a content type the CSRF check would have let through anyway
	if (type !== 'application/octet-stream') {
		throw error(415, 'expected application/octet-stream');
	}

	const upstream = await daemonFetch(`/files/stage/${encodeURIComponent(params.token)}`, {
		method: 'PUT',
		body: request.body,
		headers: { 'content-type': 'application/octet-stream' },
		// Bun needs telling that the body is a stream it should send as it reads
		duplex: 'half'
	} as RequestInit);

	const body = (await upstream.json()) as { ok?: boolean; error?: string; bytes?: number };

	if (!upstream.ok || !body.ok) {
		throw error(upstream.status === 413 ? 413 : 400, body.error ?? 'upload failed');
	}

	return json({ ok: true, token: params.token, bytes: body.bytes ?? 0 });
}

/**
 * GET ?instance=<name> → what the staged archive holds, and where each part of
 * it would land on that instance.
 *
 * The instance matters: the same archive resolves differently onto a Paper
 * server and a Fabric one, because they lay their dimensions out differently.
 */
export async function GET({ params, url }) {
	const instance = url.searchParams.get('instance');
	const software = url.searchParams.get('software');

	// the launch wizard has no instance yet, so it names the target it is about
	// to create instead; the same archive resolves differently onto Paper and
	// onto Fabric, so a scan without a target would be answering a question
	// nobody asked
	if (software) {
		try {
			const scan = await scanArchiveFor(
				params.token,
				software,
				url.searchParams.get('mcVersion') ?? undefined,
				url.searchParams.get('level') ?? ''
			);

			return json({ ok: true, scan });
		} catch (err) {
			throw error(400, errorMessage(err));
		}
	}

	if (!instance) {
		const info = await stageInfo(params.token);

		if (!info) {
			throw error(404, 'that upload is no longer staged');
		}

		return json({ ok: true, stage: info });
	}

	const cfg = await loadCluster();

	if (!managedInstances(cfg)[instance]) {
		throw error(404, 'unknown instance');
	}

	try {
		const scan = await scanStagedWorld(cfg, instance, params.token);

		return json({ ok: true, scan });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE → throw the upload away, on cancel or on a re-pick. */
export async function DELETE({ params }) {
	await discardStage(params.token).catch(() => undefined);

	return json({ ok: true });
}
