// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error, json } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import { stageInstanceArchive } from '$core/instancefiles';
import { discardStage } from '$core/world';
import { daemonFetch } from '$lib/server/luna';
import { startJob } from '$lib/server/jobs';

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

	const stage = url.searchParams.get('stage');

	if (stage) {
		setHeaders({ 'cache-control': 'private, no-store' });

		return await stagedZip(stage, url.searchParams.get('file') ?? `${params.name}.zip`);
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

/**
 * POST { path, names? } → a job packing a directory or a selection into a zip.
 *
 * A folder can take minutes to pack, so it is a job the page follows, not a
 * request the browser waits on with nothing to show. When it finishes, the
 * result's token is fetched through `GET ?stage=<token>`.
 */
export async function POST({ params, request }) {
	const cfg = await loadCluster();
	const name = params.name;

	if (!managedInstances(cfg)[name]) {
		throw error(404, 'unknown instance');
	}

	const body = await request.json();
	const path = String(body.path ?? '').replace(/^\/+/, '');
	const names: string[] = Array.isArray(body.names)
		? body.names.map((entry: unknown) => String(entry))
		: [];
	const label = names.length > 1
		? `zip ${names.length} entries of ${name}`
		: `zip ${names[0] ?? (path || name)}`;

	const job = startJob('file-archive', name, label, async (reporter) => {
		return await stageInstanceArchive(cfg, name, path, {
			...(names.length > 0 ? { names } : {}),
			reporter
		});
	});

	return json({ ok: true, job });
}

/**
 * One staged zip, served once: the primary's copy is discarded when the body
 * has been read through, and the stage sweep takes one a dropped download left.
 */
async function stagedZip(token: string, fileName: string): Promise<Response> {
	if (!/^[a-z0-9]{8,64}$/.test(token)) {
		throw error(400, 'invalid stage token');
	}

	const upstream = await daemonFetch(`/files/stage/${encodeURIComponent(token)}`);

	if (!upstream.ok || !upstream.body) {
		throw error(upstream.status === 404 ? 404 : 502, await upstreamMessage(upstream));
	}

	const headers = new Headers({
		'content-type': 'application/zip',
		'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
	});
	const length = upstream.headers.get('content-length');

	if (length) {
		headers.set('content-length', length);
	}

	const body = upstream.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			flush() {
				void discardStage(token).catch(() => undefined);
			}
		})
	);

	return new Response(body, { headers });
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
