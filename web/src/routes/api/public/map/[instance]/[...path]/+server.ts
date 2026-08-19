// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import { fetchMapFile } from '$lib/server/mapfile';

/**
 * GET → an instance's BlueMap, proxied.
 *
 * The map's own webserver binds a plain HTTP port on whichever machine runs the
 * instance. Handing a visitor that address directly fails three ways: the page
 * is served over HTTPS so the browser blocks the mixed content, the port is on
 * the LAN and not routable from outside, and an instance owned by a follower is
 * not even on this machine. Proxying solves all three at once, and means a new
 * mapped instance needs no nginx change.
 *
 * It also decouples the map from the server that renders it. `fetchMapFile`
 * falls back to the rendered files on the owner's disk, so a stopped instance
 * still has a map here: what a visitor loses is the player markers, not the
 * world. Which source answered is not something the browser is told, because
 * there is nothing it could do differently.
 *
 * BlueMap's webapp is mounted under this prefix rather than rewritten: its
 * `index.html` references `./assets/...` and its `settings.json` a relative
 * `mapDataRoot`, both of which resolve against the document's own directory.
 * That is why the embed points at `…/<instance>/index.html` rather than at the
 * bare directory: SvelteKit normalises a trailing slash away with a 308, and
 * `…/<instance>` as a document would resolve `./assets/…` one level too high.
 */

/** Read-only: the map has no endpoint that should be reachable with a body. */
const ALLOWED = new Set(['GET', 'HEAD']);

async function proxy(
	instance: string,
	path: string,
	request: Request,
	method: 'GET' | 'HEAD'
): Promise<Response> {
	const file = await fetchMapFile(instance, path, {
		method,
		range: request.headers.get('range'),
		signal: request.signal
	});

	// covers all three refusals with one answer: the page is off, the instance
	// did not opt in, or it has no map. None of them is worth telling apart to
	// somebody who is guessing instance names.
	if (!file) {
		throw error(404, 'not found');
	}

	if (file.status === 502) {
		throw error(502, 'map unreachable');
	}

	// tiles are immutable once rendered and there are thousands of them; letting
	// the browser keep them is the difference between a map that pans and one
	// that re-downloads itself. The live endpoints are exempt: a cached player
	// list is a map with ghosts on it.
	file.headers.set(
		'Cache-Control',
		file.status < 400 && !path.includes('/live/') ? 'public, max-age=300' : 'no-store'
	);

	return new Response(method === 'HEAD' ? null : file.body, {
		status: file.status,
		headers: file.headers
	});
}

export async function GET({ params, request }) {
	return await proxy(params.instance, params.path ?? '', request, 'GET');
}

export async function HEAD({ params, request }) {
	return await proxy(params.instance, params.path ?? '', request, 'HEAD');
}

/** Anything that could change state on the map server is refused outright. */
export async function fallback({ request }) {
	if (!ALLOWED.has(request.method)) {
		throw error(405, 'method not allowed');
	}

	throw error(404, 'not found');
}
