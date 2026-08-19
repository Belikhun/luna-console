// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Reading one file out of an instance's map, from wherever it can be had.
 *
 * A rendered map is two things that are usually confused for one: a directory of
 * files, and a webserver the plugin runs in front of it. Only the second one
 * needs the Minecraft server to be up. So a map whose instance is stopped is
 * still a complete map on disk, and the console has no business showing an
 * unreachable frame for it.
 *
 * Both sources are therefore tried, in this order:
 *
 *  1. BlueMap's own webserver, which is authoritative while it answers because
 *     it is the only thing that knows who is online and where they are standing;
 *  2. the rendered webroot on the owning machine's disk, reached through the
 *     daemon (never read from here - the console is a client and clients do not
 *     touch the cluster), which serves everything except the live data.
 *
 * A refused connection is remembered for a few seconds. Without that, a stopped
 * instance pays one failed connection per tile, and a map pans through hundreds.
 */

import { gunzipSync } from 'node:zlib';

import { mapProvider, type MapProviderId } from '$core/maps';
import { mapAccess } from '$core/publicsite';
import { daemonFetch } from '$lib/server/luna';

/** How long a map server that refused a connection is left alone. */
const LIVE_DOWN_MS = 5000;

/**
 * How long to wait on the live map server.
 *
 * The map server is on the LAN; a slow answer means it is rendering, not that it
 * is gone, but a request must not hang the console's socket.
 */
const LIVE_TIMEOUT_MS = 20_000;

/**
 * Headers worth carrying back from the live server. The rest are dropped rather
 * than filtered, since an allowlist cannot leak a header nobody thought about.
 *
 * `content-encoding` and `content-length` are deliberately absent. BlueMap
 * serves its JSON with `Content-Encoding: gzip`, and `fetch` decompresses the
 * body before we ever see it; forwarding the header would tell the browser to
 * gunzip bytes that are already plain, which it reports as a bare "network
 * error" with nothing pointing at the cause. The length is wrong for the same
 * reason, so the response goes back chunked.
 */
const LIVE_PASS_THROUGH = ['content-type', 'etag', 'last-modified'];

/** One map file, normalised into what should go back to the browser. */
export interface MapFile {
	status: number;
	/** Ready to send: type, and an encoding only when the body really carries one */
	headers: Headers;
	body: ReadableStream<Uint8Array> | null;
	/** Whether the live map server answered, as opposed to the rendered files */
	live: boolean;
}

/** Instances whose map server refused a connection, and when it did. */
const liveDown = new Map<string, number>();

/**
 * Paths whose stored copy names players, per provider.
 *
 * A stopped server has nobody on it, and a map that still draws the last people
 * it saw is worse than one that draws none: the markers are a lie a visitor
 * cannot tell from the truth. So on the way out of the rendered files, the
 * player list is emptied.
 *
 * The two providers store it differently and neither can simply be skipped.
 * BlueMap keeps the list only in memory and leaves an empty object behind, which
 * its webapp reads as a broken payload rather than as nobody online, so the file
 * is replaced outright. Dynmap writes the same document its webapp polls, with
 * the players inside it *and* the tile-update log the map needs, so that one is
 * rewritten rather than replaced.
 */
const PLAYERS: Record<MapProviderId, { path: RegExp; empty: "replace" | "rewrite" }> = {
	bluemap: { path: /^maps\/[^/]+\/live\/players\.json$/, empty: "replace" },
	dynmap: { path: /^standalone\/dynmap_.+\.json$/, empty: "rewrite" }
};

/**
 * Fetch one file from an instance's map.
 *
 * Answers `null` when the instance has no map the public page may serve, which
 * covers all three refusals with one answer: the page is off, the instance did
 * not opt in, or it has no map. None of them is worth telling apart to somebody
 * who is guessing instance names.
 */
export async function fetchMapFile(
	instance: string,
	path: string,
	opts: { method?: 'GET' | 'HEAD'; range?: string | null; signal?: AbortSignal } = {}
): Promise<MapFile | null> {
	const access = await mapAccess(instance);

	if (!access) {
		return null;
	}

	const method = opts.method ?? 'GET';

	// a handful of paths are the files' to answer even while the plugin is up, and
	// they fall through to it only when nothing is on disk (see `preferFile`)
	if (mapProvider(access.provider).preferFile?.test(path)) {
		const stored = await fetchRendered(instance, access.provider, path, method, opts.signal);

		if (stored.status < 400) {
			return stored;
		}
	}

	// no origin at all is a map served purely from its files, which is Dynmap's own
	// arrangement for an external webserver; there is nothing to try first
	const live = access.origin
		? await fetchLive(instance, access.origin, path, method, opts.range)
		: undefined;

	if (live) {
		return live;
	}

	return await fetchRendered(instance, access.provider, path, method, opts.signal);
}

/**
 * The map's own webserver, or undefined when it is not answering.
 *
 * A 5xx counts as not answering: BlueMap returns one while its storage is still
 * being opened, and the files it would eventually serve are already on disk.
 */
async function fetchLive(
	instance: string,
	origin: string,
	path: string,
	method: 'GET' | 'HEAD',
	range: string | null | undefined
): Promise<MapFile | undefined> {
	const since = liveDown.get(instance);

	if (since !== undefined && Date.now() - since < LIVE_DOWN_MS) {
		return undefined;
	}

	let upstream: Response;

	try {
		upstream = await fetch(`http://${origin}/${path}`, {
			method,
			signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
			headers: range ? { range } : {}
		});
	} catch {
		liveDown.set(instance, Date.now());

		return undefined;
	}

	liveDown.delete(instance);

	if (upstream.status >= 500) {
		void upstream.body?.cancel();

		return undefined;
	}

	const headers = new Headers();

	for (const name of LIVE_PASS_THROUGH) {
		const value = upstream.headers.get(name);

		if (value) {
			headers.set(name, value);
		}
	}

	return { status: upstream.status, headers, body: upstream.body, live: true };
}

/** The rendered files, through the daemon that owns the instance. */
async function fetchRendered(
	instance: string,
	provider: MapProviderId,
	path: string,
	method: 'GET' | 'HEAD',
	signal: AbortSignal | undefined
): Promise<MapFile> {
	const players = PLAYERS[provider];

	if (players.empty === 'replace' && players.path.test(path)) {
		return jsonFile('{"players":[]}', method);
	}

	// nothing on disk can answer these: they are the plugin talking out of memory,
	// and reaching the daemon for a 404 per poll is work with no answer at the end
	if (mapProvider(provider).livePath.test(path)) {
		return { status: 503, headers: new Headers(), body: null, live: false };
	}

	const encoded = path.split('/').map(encodeURIComponent).join('/');

	let upstream: Response;

	try {
		upstream = await daemonFetch(`/files/map/${encodeURIComponent(instance)}/${encoded}`, {
			method,
			signal
		});
	} catch {
		return { status: 502, headers: new Headers(), body: null, live: false };
	}

	const headers = new Headers();

	for (const name of ['content-type', 'content-length']) {
		const value = upstream.headers.get(name);

		if (value) {
			headers.set(name, value);
		}
	}

	// the daemon marks a gzip body without declaring it, so that `fetch` above
	// hands the bytes over untouched; the browser is the one that should gunzip
	if (upstream.headers.get('x-luna-encoding') === 'gzip') {
		headers.set('content-encoding', 'gzip');
	}

	if (!upstream.ok && upstream.status !== 204) {
		void upstream.body?.cancel();

		return { status: upstream.status, headers: new Headers(), body: null, live: false };
	}

	if (players.empty === 'rewrite' && players.path.test(path) && upstream.body) {
		return await withoutPlayers(upstream, headers, method);
	}

	return { status: upstream.status, headers, body: upstream.body, live: false };
}

/**
 * One of Dynmap's world documents with its player list emptied.
 *
 * Buffered rather than streamed, because the edit is inside the JSON. That is
 * affordable: this file is the poll payload, so it is kilobytes and the plugin
 * rewrites it every second or two. A body that will not parse is passed through
 * untouched - a map with stale markers still beats no map, and guessing at a
 * document this did not understand is how a working map gets broken.
 */
async function withoutPlayers(
	upstream: Response,
	headers: Headers,
	method: 'GET' | 'HEAD'
): Promise<MapFile> {
	const text = await upstream.text();

	try {
		const document = JSON.parse(text) as Record<string, unknown>;

		document.players = [];
		document.currentcount = 0;

		return jsonFile(JSON.stringify(document), method);
	} catch {
		return jsonFile(text, method);
	}
}

/** A JSON body this process made up, in the shape the caller expects. */
function jsonFile(body: string, method: 'GET' | 'HEAD'): MapFile {
	const bytes = new TextEncoder().encode(body);

	return {
		status: 200,
		headers: new Headers({
			'content-type': 'application/json',
			'content-length': String(bytes.byteLength)
		}),
		body: method === 'HEAD' ? null : new Response(bytes).body,
		live: false
	};
}

/**
 * One of the map's JSON documents, parsed, or null when it cannot be had.
 *
 * Used by the parts of the console that read the map's own settings rather than
 * proxying it, so those keep working for a stopped instance too. The gzip case
 * is handled here because `fetchMapFile` deliberately leaves a packed body
 * packed for the browser's benefit, and this caller is not a browser.
 */
export async function readMapJson(instance: string, path: string): Promise<unknown | null> {
	const file = await fetchMapFile(instance, path);

	if (!file || file.status !== 200 || !file.body) {
		void file?.body?.cancel();

		return null;
	}

	try {
		const raw = new Uint8Array(await new Response(file.body).arrayBuffer());
		const text =
			file.headers.get('content-encoding') === 'gzip'
				? gunzipSync(raw).toString('utf8')
				: new TextDecoder().decode(raw);

		return JSON.parse(text);
	} catch {
		return null;
	}
}
