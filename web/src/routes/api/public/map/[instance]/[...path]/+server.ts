// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error } from '@sveltejs/kit';

import { mapEndpoint } from '$core/publicsite';

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
 * BlueMap's webapp is mounted under this prefix rather than rewritten: its
 * `index.html` references `./assets/...` and its `settings.json` a relative
 * `mapDataRoot`, both of which resolve against the document's own directory.
 * That is why the embed points at `…/<instance>/index.html` rather than at the
 * bare directory: SvelteKit normalises a trailing slash away with a 308, and
 * `…/<instance>` as a document would resolve `./assets/…` one level too high.
 */

/** Read-only: the map has no endpoint that should be reachable with a body. */
const ALLOWED = new Set(['GET', 'HEAD']);

/**
 * Headers worth carrying back. The rest are dropped rather than filtered, since
 * an allowlist cannot leak a header nobody thought about.
 *
 * `content-encoding` and `content-length` are deliberately absent. BlueMap
 * serves its JSON with `Content-Encoding: gzip`, and `fetch` decompresses the
 * body before we ever see it; forwarding the header would tell the browser to
 * gunzip bytes that are already plain, which it reports as a bare "network
 * error" with nothing pointing at the cause. The length is wrong for the same
 * reason, so the response goes back chunked.
 */
const PASS_THROUGH = ['content-type', 'etag', 'last-modified'];

async function proxy(
	instance: string,
	path: string,
	request: Request,
	method: 'GET' | 'HEAD'
): Promise<Response> {
	const endpoint = await mapEndpoint(instance);

	// covers all three refusals with one answer: the page is off, the instance
	// did not opt in, or it has no map. None of them is worth telling apart to
	// somebody who is guessing instance names.
	if (!endpoint) {
		throw error(404, 'not found');
	}

	const query = new URL(request.url).search;
	const target = `http://${endpoint.origin}/${path}${query}`;

	let upstream: Response;

	try {
		upstream = await fetch(target, {
			method,
			// the map server is on the LAN; a slow answer means it is rendering, not
			// that it is gone, but a request must not hang the console's socket
			signal: AbortSignal.timeout(20_000),
			headers: passRange(request)
		});
	} catch (err) {
		throw error(502, `map server unreachable: ${(err as Error).message}`);
	}

	const headers = new Headers();

	for (const name of PASS_THROUGH) {
		const value = upstream.headers.get(name);

		if (value) {
			headers.set(name, value);
		}
	}

	// tiles are immutable once rendered and there are thousands of them; letting
	// the browser keep them is the difference between a map that pans and one
	// that re-downloads itself
	headers.set('Cache-Control', upstream.ok ? 'public, max-age=300' : 'no-store');

	return new Response(method === 'HEAD' ? null : upstream.body, {
		status: upstream.status,
		headers
	});
}

/** Forward a range request, which is how the webapp fetches parts of a tile. */
function passRange(request: Request): HeadersInit {
	const range = request.headers.get('range');

	return range ? { range } : {};
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
