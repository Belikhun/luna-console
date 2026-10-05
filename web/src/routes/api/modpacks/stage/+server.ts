// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { newStageToken } from '$core/world';

/** Largest .mrpack accepted; a pack carries its overrides, never its mods, so a gigabyte is generous. */
const MAX_MRPACK_BYTES = 1024 * 1024 * 1024;

/**
 * POST { fileName, sizeBytes } → mint a staging token for an uploaded .mrpack.
 *
 * The bytes travel the way a world zip does (PUT to the world stage route,
 * streamed to the daemon's staging area), because that path already reaches a
 * follower: the daemon installing the pack pulls the file by token. Only the
 * checks differ, so they live here.
 */
export async function POST({ request }) {
	const body = await request.json();
	const fileName = String(body.fileName ?? '').trim();
	const sizeBytes = Number(body.sizeBytes ?? 0);

	if (!fileName.toLowerCase().endsWith('.mrpack')) {
		throw error(400, 'a Modrinth modpack is a .mrpack file');
	}

	if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
		throw error(400, 'sizeBytes is required');
	}

	if (sizeBytes > MAX_MRPACK_BYTES) {
		throw error(413, 'a .mrpack over 1 GB is not a modpack index; it is a world in disguise');
	}

	const token = newStageToken();

	return json({ ok: true, stage: { token, fileName, sizeBytes, uploadUrl: `/worlds/stage/${token}` } });
}
