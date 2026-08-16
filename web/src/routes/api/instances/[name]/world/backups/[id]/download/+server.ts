// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';
import { loadCluster, managedInstances } from '$core/config';
import { listBackups } from '$core/backups';
import { daemonFetch } from '$lib/server/luna';

/** Headers worth carrying from the daemon; the rest are ours to set. */
const PASS_THROUGH = ['content-length', 'content-range', 'accept-ranges'];

/**
 * GET → the backup archive itself, as a download.
 *
 * Streamed rather than read: these are routinely tens of gigabytes, and this
 * process must never hold one. The daemon does the same on its side, and
 * proxies through to the owning follower when the instance is not the
 * primary's, so a download works wherever the instance happens to live.
 *
 * `Range` is honoured end to end. A 29 GB download over a domestic connection
 * will be interrupted, and without ranges an interruption means starting over.
 */
export async function GET({ params, request, setHeaders }) {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	const entry = (await listBackups(cfg, params.name)).find((row) => row.id === params.id);

	if (!entry) {
		throw error(404, 'unknown backup');
	}

	const range = request.headers.get('range');
	const upstream = await daemonFetch(
		`/files/backups/${encodeURIComponent(params.name)}/${encodeURIComponent(entry.file)}`,
		{ headers: range ? { range } : {} }
	);

	if (!upstream.ok && upstream.status !== 206) {
		throw error(upstream.status === 404 ? 404 : 502, await upstreamMessage(upstream));
	}

	const headers = new Headers();

	for (const name of PASS_THROUGH) {
		const value = upstream.headers.get(name);

		if (value) {
			headers.set(name, value);
		}
	}

	headers.set('content-type', 'application/zip');
	headers.set('content-disposition', `attachment; filename="${downloadName(params.name, entry.label)}"`);

	// an archive is immutable once written, but it is also private to this
	// console; caching it in a shared proxy would be the wrong trade
	setHeaders({ 'cache-control': 'private, no-store' });

	return new Response(upstream.body, { status: upstream.status, headers });
}

/** A file name a human can find again, with anything awkward flattened out. */
function downloadName(instance: string, label: string): string {
	const safe = label.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

	return `${instance}-${safe || 'backup'}.zip`;
}

/** The daemon's own error text, when it sent one. */
async function upstreamMessage(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: string };

		return body.error ?? `daemon answered ${response.status}`;
	} catch {
		return `daemon answered ${response.status}`;
	}
}
