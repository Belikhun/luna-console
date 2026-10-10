// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import { daemonFetch } from '$lib/server/luna';

/** Headers worth carrying from the daemon; the rest are ours to set. */
const PASS_THROUGH = ['content-length', 'content-range', 'accept-ranges', 'content-type'];

/**
 * GET ?path=<p>[&format=raw|zip|tar][&name=…][&inline=1] → the bytes.
 *
 * A file downloads as itself (`raw`, the default for one), a directory or a
 * selection (`name` repeated, `path` their directory) as a zip the daemon
 * packs as it streams. Nothing is held in this process: the daemon serves its
 * own instances from disk and passes a follower's through, so a download works
 * wherever the instance lives. `Range` is honoured end to end for raw files,
 * which is what lets a video preview seek and a dropped download resume.
 * `inline` is for the console's own previews; everything else is an attachment.
 */
export async function GET({ params, request, url, setHeaders }) {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	const path = (url.searchParams.get('path') ?? '').replace(/^\/+/, '');
	const names = url.searchParams.getAll('name');
	const requested = url.searchParams.get('format');
	const format = requested === 'zip' || requested === 'tar' || requested === 'raw'
		? requested
		: names.length > 0
			? 'zip'
			: 'raw';
	const query = new URLSearchParams({ format });

	for (const name of names) {
		query.append('name', name);
	}

	const range = request.headers.get('range');
	const encoded = path.split('/').filter((part) => part !== '').map(encodeURIComponent).join('/');
	const upstream = await daemonFetch(
		`/files/instance/${encodeURIComponent(params.name)}/${encoded}?${query.toString()}`,
		{ headers: range ? { range } : {} }
	);

	if (!upstream.ok && upstream.status !== 206) {
		throw error(upstream.status === 404 ? 404 : upstream.status === 400 ? 400 : 502, await upstreamMessage(upstream));
	}

	const headers = new Headers();

	for (const name of PASS_THROUGH) {
		const value = upstream.headers.get(name);

		if (value) {
			headers.set(name, value);
		}
	}

	const entryName = decodeURIComponent(upstream.headers.get('x-luna-name') ?? '') || params.name;
	const fileName = format === 'raw'
		? entryName
		: `${names.length > 1 ? `${params.name}-${entryName || 'files'}` : entryName}.${format}`;
	const disposition = url.searchParams.get('inline') ? 'inline' : 'attachment';

	headers.set('content-disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`);

	if (format === 'raw' && !upstream.headers.get('content-type')) {
		headers.set('content-type', 'application/octet-stream');
	}

	// a server file is private to this console and changes under it; nothing
	// between here and the browser may keep a copy
	setHeaders({ 'cache-control': 'private, no-store' });

	return new Response(upstream.body, { status: upstream.status, headers });
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
