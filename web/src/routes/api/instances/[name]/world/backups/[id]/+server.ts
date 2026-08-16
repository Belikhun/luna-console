// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, managedInstances } from '$core/config';
import { deleteBackup, updateBackup, verifyBackup } from '$core/backups';
import { startJob } from '$lib/server/jobs';
import { errorMessage } from '$lib/server/http';

/** PATCH { label?, note?, pinned? } → rename a backup, annotate it, or pin it. */
export async function PATCH({ params, request }) {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	const body = await request.json();

	try {
		const entry = await updateBackup(cfg, params.name, params.id, {
			label: body.label === undefined ? undefined : String(body.label),
			note: body.note === undefined ? undefined : String(body.note),
			pinned: body.pinned === undefined ? undefined : Boolean(body.pinned)
		});

		return json({ ok: true, backup: entry });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/** DELETE → drop one backup and its archive. */
export async function DELETE({ params, locals }) {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	try {
		const entry = await deleteBackup(cfg, params.name, params.id, locals.account?.username);

		return json({ ok: true, backup: entry ?? null });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}

/**
 * POST { action: 'verify' } → re-read the archive and record its checksum.
 *
 * A job rather than a request: hashing tens of gigabytes is not something a
 * browser waits on, and the progress belongs on a card like every other long
 * operation here.
 */
export async function POST({ params, request }) {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	const body = await request.json();

	if (String(body.action ?? '') !== 'verify') {
		throw error(400, 'unknown action');
	}

	// the bridge is a jobCall whose reporter rides in the fourth argument, and it
	// is injected on the daemon side; this job only mirrors what comes back
	const job = startJob('world-verify', params.name, `Verify ${params.id}`, async () => {
		return await verifyBackup(cfg, params.name, params.id);
	});

	return json({ ok: true, job });
}
