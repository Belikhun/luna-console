// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The daemon's API server: one fetch handler served over the local unix socket
 * (CLI + web console) and, on a primary, over TCP for followers and the
 * cluster WebSocket. Local requests are trusted; TCP requests must carry the
 * shared cluster token.
 */

import { join, normalize } from "node:path";
import { mkdir, rename, rm } from "node:fs/promises";
import { t } from "../shared/i18n";
import { existsSync, statSync } from "node:fs";

/**
 * Ceiling on one staged world zip.
 *
 * Generous, because a real adventure map runs to gigabytes, but finite: this is
 * the only thing standing between an authenticated upload and a full cluster
 * root, and a full cluster root takes `cluster.json` down with it.
 */
const MAX_STAGE_BYTES = 64 * 1024 * 1024 * 1024;

import { backupsDir, loadCluster, loadLock, managedInstances, instanceDir, poolDir, stagingDir } from "../core/config";
import { datapacksDir } from "../core/datapacks";
import { mapProvider, type MapProviderId } from "../core/maps";
import { mapWebrootFor } from "../core/publicsite";
import * as lunaApi from "../core/services/luna";

import type { DaemonConfig } from "./config";
import { consoleStamp } from "./console";
import { getEvents } from "./events";
import { ownsInstance } from "./identity";
import { getJob, startJob, watchJob, type JobView } from "./jobs";
import { runOp } from "./rpc";
import { tailFollow, type TailHandle } from "./tail";
import { localBinaryMeta, localBinaryPath } from "./upgrade";
import { BUILD_AT, COMMIT, VERSION, buildPlatform, buildVersion } from "../version";

import { PROTOCOL_VERSION } from "../shared/protocol";

export { PROTOCOL_VERSION };

/** How often the fleet health stream emits. Matches the heartbeat cadence. */
const DAEMON_STREAM_MS = 5_000;

/** Per-connection data attached at the cluster WebSocket upgrade. */
export interface WsData {
	kind: string;
	name?: string;
}

export const SSE_HEADERS = {
	"content-type": "text/event-stream",
	"cache-control": "no-cache",
	connection: "keep-alive",
} as const;

/** Closing a controller the client already tore down throws; nobody cares. */
function closeQuietly(controller: ReadableStreamDefaultController): void {
	try {
		controller.close();
	} catch {
		// already closed
	}
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function errorResponse(message: string, status: number): Response {
	return jsonResponse({ ok: false, error: message }, status);
}

/** How much backlog a freshly opened console shows. */
const CONSOLE_TAIL_LINES = 100;

/**
 * The hub's console tunnel to a follower, injected by installHub; the server
 * module cannot import the hub (the hub imports this module), and a follower
 * daemon has no tunnel to offer at all.
 */
export interface RemoteConsole {
	connected(daemon: string): boolean;
	open(
		daemon: string,
		instance: string,
		lines: number,
		onLine: (line: string) => void,
		onEnd: (error?: string) => void,
	): () => void;
}

let remoteConsole: RemoteConsole | undefined;

/** Install the hub's follower console tunnel (primary only). */
export function setRemoteConsole(tunnel: RemoteConsole): void {
	remoteConsole = tunnel;
}

/**
 * Where a follower's own HTTP API answers, as `host:port`.
 *
 * Installed by the hub, which is the only thing that knows: followers dial the
 * primary, so the reverse direction needs the address the follower advertised
 * at registration. Undefined for an unknown daemon, and for one whose build
 * predates advertising a port at all.
 */
let followerEndpoint: ((daemon: string) => string | undefined) | undefined;

/** The shared cluster token, kept so a proxied fetch can authenticate itself. */
let clusterToken: string | undefined;

/** Install the follower address lookup (primary only). */
export function setFollowerEndpoint(lookup: typeof followerEndpoint): void {
	followerEndpoint = lookup;
}

/** SSE stream of an instance's live console; a tail of its latest.log. */
function consoleStream(logPath: string): Response {
	let tail: TailHandle | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			tail = tailFollow(
				logPath,
				CONSOLE_TAIL_LINES,
				(line) => {
					try {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
					} catch {
						// client disconnected mid-write
						tail?.stop();
					}
				},
				() => closeQuietly(controller),
			);
		},

		cancel() {
			tail?.stop();
		},
	});

	return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * SSE stream of a follower-owned instance's console, piped through the hub's
 * cluster-link tunnel; the log lives on the follower's disk, so its daemon
 * tails it and the lines cross the WebSocket as stream frames.
 */
function remoteConsoleStream(daemon: string, instance: string): Response {
	let close: (() => void) | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const push = (line: string): void => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
				} catch {
					// client disconnected mid-write
					close?.();
				}
			};

			close = remoteConsole!.open(daemon, instance, CONSOLE_TAIL_LINES, push, (error) => {
				if (error) {
					push(`[luna] console stream ended: ${error}`);
				}

				closeQuietly(controller);
			});
		},

		cancel() {
			close?.();
		},
	});

	return new Response(stream, { headers: SSE_HEADERS });
}

/** SSE stream of one job: full view on every flush, closed once it settles. */
function jobStream(id: string): Response {
	let unwatch: (() => void) | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			unwatch = watchJob(id, (view: JobView) => {
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(view)}\n\n`));
				} catch {
					// client went away between the flush and the write
					return;
				}

				// nothing more will happen to a settled job, so the stream is done
				if (view.state !== "running") {
					unwatch?.();
					closeQuietly(controller);
				}
			});
		},

		cancel() {
			unwatch?.();
		},
	});

	return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * SSE stream of the whole fleet's health: every daemon's row, including the
 * heartbeat-sourced samples the hub collects from followers. Everything it
 * serves is already in memory, so the stream is a timer over a snapshot rather
 * than a fan-out of change events.
 */
function daemonsStream(): Response {
	let timer: ReturnType<typeof setInterval> | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const push = async (): Promise<void> => {
				let payload: unknown;

				try {
					payload = (await runOp("daemon.listDaemons", [])).result;
				} catch (err) {
					payload = { error: err instanceof Error ? err.message : String(err) };
				}

				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ daemons: payload })}\n\n`));
				} catch {
					// the client went away between ticks
					clearInterval(timer);
				}
			};

			void push();

			timer = setInterval(() => void push(), DAEMON_STREAM_MS);
		},

		cancel() {
			clearInterval(timer);
		},
	});

	return new Response(stream, { headers: SSE_HEADERS });
}

async function handleRpc(op: string, request: Request): Promise<Response> {
	let args: unknown[];

	try {
		const body = (await request.json()) as { args?: unknown[] };

		args = body.args ?? [];
	} catch {
		return errorResponse("invalid JSON body", 400);
	}

	try {
		const outcome = await runOp(op, args);

		return jsonResponse({ ok: true, ...outcome });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const status = message.startsWith("unknown operation") ? 404 : 500;

		return errorResponse(message, status);
	}
}

async function handleJobStart(request: Request): Promise<Response> {
	let body: { op?: string; args?: unknown[]; kind?: string; target?: string; label?: string };

	try {
		body = (await request.json()) as typeof body;
	} catch {
		return errorResponse("invalid JSON body", 400);
	}

	const { op, args } = body;

	if (!op) {
		return errorResponse("op required", 400);
	}

	const job = startJob(
		body.kind ?? op,
		body.target ?? "",
		body.label ?? op,
		(reporter) => runOp(op, args ?? [], reporter),
	);

	return jsonResponse({ ok: true, job });
}

/**
 * GET /files/binary[/meta]; the binary this daemon is running, for follower
 * self-upgrade. Deliberately gated on the token alone and never on the protocol
 * version: a follower whose protocol no longer matches is exactly the one that
 * needs a new build (DESIGN.md §4.7).
 */
async function handleBinary(metaOnly: boolean): Promise<Response> {
	let meta;

	try {
		meta = await localBinaryMeta();
	} catch (err) {
		return errorResponse(err instanceof Error ? err.message : String(err), 409);
	}

	if (metaOnly) {
		return jsonResponse({ ok: true, ...meta });
	}

	return new Response(Bun.file(localBinaryPath()), {
		headers: {
			"content-type": "application/octet-stream",
			"x-luna-version": meta.version,
			"x-luna-sha256": meta.sha256,
		},
	});
}

/** GET /files/pool/<file>; jar streaming for follower pool mirroring. */
async function handlePoolFile(subpath: string): Promise<Response> {
	// the pool has one flat level plus versions/; refuse anything that escapes
	const clean = normalize(subpath);

	if (clean.startsWith("..") || clean.startsWith("/") || !clean.endsWith(".jar")) {
		return errorResponse("invalid pool path", 400);
	}

	const path = join(poolDir(), clean);

	if (!existsSync(path)) {
		return errorResponse("no such pool file", 404);
	}

	return new Response(Bun.file(path));
}

/** GET /files/datapacks/<file>; zip streaming for follower datapack mirroring. */
async function handleDatapackFile(subpath: string): Promise<Response> {
	// the pool is one flat level of zips; refuse anything that escapes
	const clean = normalize(subpath);

	if (clean.startsWith("..") || clean.includes("/") || !clean.endsWith(".zip")) {
		return errorResponse("invalid datapack path", 400);
	}

	const path = join(datapacksDir(), clean);

	if (!existsSync(path)) {
		return errorResponse("no such datapack file", 404);
	}

	return new Response(Bun.file(path));
}

/**
 * PUT /files/stage/<token>; accept an uploaded world zip, streaming it to disk.
 *
 * The body is written chunk by chunk rather than buffered: a world zip is
 * routinely gigabytes, and `await request.arrayBuffer()` on one would put the
 * whole thing in the daemon's heap. This is also why a world never travels as
 * an RPC argument - those are JSON over the socket - and why the ops take a
 * staging token instead.
 */
async function handleStageUpload(request: Request, token: string): Promise<Response> {
	const clean = stageToken(token);

	if (!clean) {
		return errorResponse("invalid stage token", 400);
	}

	if (!request.body) {
		return errorResponse("empty body", 400);
	}

	await mkdir(stagingDir(), { recursive: true });

	const path = join(stagingDir(), `${clean}.zip`);
	const partial = `${path}.part`;
	const sink = Bun.file(partial).writer();

	// an explicit reader rather than `for await`: a request body is not reliably
	// async-iterable across Bun's listeners, and when it is not the failure is a
	// bare "undefined is not a function" thrown a long way from its cause
	const reader = request.body.getReader();
	let bytes = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();

			if (done) {
				break;
			}

			bytes += value.byteLength;

			// the console's own body limit is global and generous by necessity, so
			// the ceiling that actually protects this disk is counted here
			if (bytes > MAX_STAGE_BYTES) {
				throw new Error(t("daemon.stageTooLarge"));
			}

			sink.write(value);
		}

		await sink.end();
	} catch (err) {
		await reader.cancel().catch(() => undefined);

		try {
			await sink.end();
		} catch {
			// the write side is already broken; the partial file goes either way
		}

		await rm(partial, { force: true });

		console.error("STAGE FAIL", (err as Error)?.stack ?? err);

		return errorResponse(err instanceof Error ? err.message : String(err), 413);
	}

	// renamed only once it is whole, so a half-uploaded zip can never be picked
	// up as a complete one by an op that runs while the transfer is still going
	await rename(partial, path);

	return jsonResponse({ ok: true, token: clean, bytes });
}

/** GET /files/stage/<token>; hand a staged zip to the follower that needs it. */
async function handleStageFile(token: string): Promise<Response> {
	const clean = stageToken(token);

	if (!clean) {
		return errorResponse("invalid stage token", 400);
	}

	const path = join(stagingDir(), `${clean}.zip`);

	if (!existsSync(path)) {
		return errorResponse("no such staged world", 404);
	}

	return new Response(Bun.file(path));
}

/**
 * GET /files/backups/<instance>/<file>; stream one archive to the primary.
 *
 * A follower's backups stay on the follower, so this is how the console offers
 * a download of one. Range requests are honoured because these are commonly
 * tens of gigabytes and a download that cannot resume is a download that never
 * finishes.
 */
async function handleBackupFile(
	subpath: string,
	request: Request,
	dcfg: DaemonConfig,
): Promise<Response> {
	const parts = normalize(subpath).split("/");

	if (parts.length !== 2 || parts.some((part) => part === "" || part === "..")) {
		return errorResponse("invalid backup path", 400);
	}

	const [instance, file] = parts as [string, string];

	if (!/^[a-z0-9_-]+$/i.test(instance) || !file.endsWith(".zip") || file.includes("/")) {
		return errorResponse("invalid backup path", 400);
	}

	// An archive lives on the machine that owns the instance, and the console
	// only ever talks to the primary. So when the instance is somebody else's,
	// this streams it through rather than answering 404: the alternative is a
	// download button that works for seven instances and not the eighth.
	const cfg = await loadCluster().catch(() => undefined);
	const inst = cfg ? managedInstances(cfg)[instance] : undefined;

	if (inst && !ownsInstance(inst)) {
		return await proxyFollowerBackup(inst.daemon ?? "", instance, file, request);
	}

	const path = join(backupsDir(), instance, file);

	if (!existsSync(path)) {
		return errorResponse("no such backup", 404);
	}

	return rangedFile(path, request);
}

/** Stream a follower-held archive back through the primary. */
async function proxyFollowerBackup(
	daemon: string,
	instance: string,
	file: string,
	request: Request,
): Promise<Response> {
	const endpoint = followerEndpoint?.(daemon);

	if (!endpoint) {
		return errorResponse(t("daemon.backupUnreachable", { daemon: daemon || "?" }), 503);
	}

	const url = `http://${endpoint}/files/backups/${encodeURIComponent(instance)}/${encodeURIComponent(file)}`;
	const range = request.headers.get("range");

	const upstream = await fetch(url, {
		headers: {
			"x-luna-token": clusterToken ?? "",
			...(range ? { range } : {}),
		},
	}).catch(() => undefined);

	if (!upstream) {
		return errorResponse(t("daemon.backupUnreachable", { daemon }), 502);
	}

	const headers = new Headers();

	for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
		const value = upstream.headers.get(name);

		if (value) {
			headers.set(name, value);
		}
	}

	return new Response(request.method === "HEAD" ? null : upstream.body, {
		status: upstream.status,
		headers,
	});
}

/**
 * Content types for what a rendered webroot actually holds.
 *
 * An allowlist, and everything unlisted is served as bytes: a webroot is a
 * directory of somebody else's build, and guessing a type for a file nobody
 * expected is how a `.php` in there ends up being offered as script.
 */
const MAP_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".txt": "text/plain; charset=utf-8",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
};

/**
 * GET /files/map/<instance>/<path>; one file out of the instance's rendered map.
 *
 * A map plugin's own webserver only answers while the server is running, but the
 * map it serves is a directory of files that outlives it. This is the door to
 * those files, so the console can keep showing the last rendered map for an
 * instance that is stopped rather than an unreachable frame. Which provider is
 * behind the webroot only matters for what a missing file means; the bytes are
 * served the same way either way.
 *
 * Compression is the plugin's, not ours: with BlueMap's default `compression:
 * gzip` a tile is on disk as `<name>.prbm.gz` and the webapp still asks for
 * `<name>.prbm`, exactly as it does against BlueMap itself. The `.gz` sibling is
 * therefore tried second and handed back untouched, marked with
 * `x-luna-encoding` rather than `content-encoding`: the console reaches this over
 * `fetch`, which would silently decompress a body it sees an encoding on, and the
 * browser is the one that should be doing that.
 */
async function handleMapFile(
	subpath: string,
	request: Request,
	method: "GET" | "HEAD",
): Promise<Response> {
	const slash = subpath.indexOf("/");
	const instance = slash === -1 ? subpath : subpath.slice(0, slash);
	const wanted = slash === -1 ? "" : subpath.slice(slash + 1);

	if (!/^[a-z0-9_-]+$/i.test(instance)) {
		return errorResponse("invalid map path", 400);
	}

	const clean = normalize(wanted || "index.html");

	if (clean.startsWith("..") || clean.startsWith("/") || clean.includes("\0")) {
		return errorResponse("invalid map path", 400);
	}

	const cfg = await loadCluster().catch(() => undefined);
	const inst = cfg ? managedInstances(cfg)[instance] : undefined;

	if (!cfg || !inst) {
		return errorResponse("unknown instance", 404);
	}

	// the webroot is on the owner's disk, and the console only ever talks to the
	// primary; a follower's map streams through rather than answering 404, for the
	// same reason a follower's backup does
	if (!ownsInstance(inst)) {
		return await proxyFollowerMap(inst.daemon ?? "", instance, clean, request, method);
	}

	const lock = await loadLock().catch(() => undefined);
	const webroot = lock ? await mapWebrootFor(cfg, lock, instance) : undefined;

	if (!webroot) {
		return errorResponse("no rendered map for this instance", 404);
	}

	const target = join(webroot.dir, clean);

	// normalize above already refused an escaping path, but the webroot itself is
	// read out of somebody else's config file, so the containment is asserted here
	// rather than assumed
	if (!target.startsWith(`${webroot.dir}/`)) {
		return errorResponse("invalid map path", 400);
	}

	// a file, specifically: `Bun.file` on a directory fails deep inside the response
	// and what reaches the client is a Bun error page with a 500 on it
	const plain = isFile(target);
	const packed = !plain && isFile(`${target}.gz`);

	if (!plain && !packed) {
		return missingMapFile(clean, webroot.provider);
	}

	const dot = clean.lastIndexOf(".");
	const suffix = dot === -1 ? "" : clean.slice(dot).toLowerCase();

	const headers = new Headers({
		"content-type": MAP_TYPES[suffix] ?? "application/octet-stream",
	});

	if (packed) {
		headers.set("x-luna-encoding", "gzip");
	}

	const file = Bun.file(plain ? target : `${target}.gz`);

	headers.set("content-length", String(file.size));

	return new Response(method === "HEAD" ? null : file, { headers });
}

/** Whether a path is a readable file; a directory is not one. */
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * What a missing file answers.
 *
 * 204 for a tile, matching what the map's own webserver does: a world is mostly
 * empty and the webapp asks for tiles it cannot know exist, so "nothing rendered
 * here" is a normal answer rather than an error, and a 404 per unrendered tile
 * would fill a visitor's console with thousands of them. Anything else is a real
 * 404. Which paths are tiles is the provider's own business, so it is the
 * provider that says.
 */
function missingMapFile(clean: string, provider: MapProviderId): Response {
	if (mapProvider(provider).emptyPath.test(clean)) {
		return new Response(null, { status: 204 });
	}

	return errorResponse("no such map file", 404);
}

/** Stream a follower-held map file back through the primary. */
async function proxyFollowerMap(
	daemon: string,
	instance: string,
	clean: string,
	request: Request,
	method: "GET" | "HEAD",
): Promise<Response> {
	const endpoint = followerEndpoint?.(daemon);

	if (!endpoint) {
		return errorResponse(t("daemon.mapUnreachable", { daemon: daemon || "?" }), 503);
	}

	const path = clean.split("/").map(encodeURIComponent).join("/");
	const url = `http://${endpoint}/files/map/${encodeURIComponent(instance)}/${path}`;

	const upstream = await fetch(url, {
		method,
		headers: { "x-luna-token": clusterToken ?? "" },
		signal: request.signal,
	}).catch(() => undefined);

	if (!upstream) {
		return errorResponse(t("daemon.mapUnreachable", { daemon }), 502);
	}

	const headers = new Headers();

	// x-luna-encoding travels the whole way: the follower's copy of a tile is the
	// same gzip the browser will be handed, and decompressing it here to compress
	// it again would be work nobody asked for
	for (const name of ["content-type", "content-length", "x-luna-encoding"]) {
		const value = upstream.headers.get(name);

		if (value) {
			headers.set(name, value);
		}
	}

	return new Response(method === "HEAD" ? null : upstream.body, {
		status: upstream.status,
		headers,
	});
}

/** A file response honouring a `Range` header, so a huge download can resume. */
export async function rangedFile(path: string, request: Request): Promise<Response> {
	const file = Bun.file(path);
	const size = file.size;
	const range = request.headers.get("range");
	const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;

	if (!match) {
		return new Response(file, {
			headers: {
				"content-type": "application/zip",
				"accept-ranges": "bytes",
				"content-length": String(size),
			},
		});
	}

	const startText = match[1] ?? "";
	const endText = match[2] ?? "";

	// "bytes=-500" is the last 500 bytes, not a range starting at zero
	const start = startText === "" ? Math.max(0, size - Number(endText || 0)) : Number(startText);
	const end = startText === "" || endText === "" ? size - 1 : Math.min(Number(endText), size - 1);

	if (!Number.isFinite(start) || start < 0 || start > end || start >= size) {
		return new Response(null, {
			status: 416,
			headers: { "content-range": `bytes */${size}` },
		});
	}

	return new Response(file.slice(start, end + 1), {
		status: 206,
		headers: {
			"content-type": "application/zip",
			"accept-ranges": "bytes",
			"content-range": `bytes ${start}-${end}/${size}`,
			"content-length": String(end - start + 1),
		},
	});
}

/** A staging token is opaque and ours; anything else is refused outright. */
function stageToken(raw: string): string | undefined {
	const clean = raw.trim();

	return /^[a-z0-9]{8,64}$/.test(clean) ? clean : undefined;
}

/**
 * Build the daemon's fetch handler. `trusted` marks the unix socket listener;
 * TCP requests must present the shared token instead.
 */
export function buildHandler(
	dcfg: DaemonConfig,
	trusted: boolean,
	startedAt: number,
): (request: Request, server: Bun.Server<WsData>) => Promise<Response | undefined> {
	clusterToken = dcfg.token;

	return async (request: Request, server: Bun.Server<WsData>): Promise<Response | undefined> => {
		const url = new URL(request.url);
		const path = url.pathname;

		if (!trusted) {
			const token =
				request.headers.get("x-luna-token") ??
				request.headers.get("x-mrds-token") ??
				url.searchParams.get("token");

			if (!dcfg.token || token !== dcfg.token) {
				return errorResponse("unauthorized", 401);
			}
		}

		if (path === "/cluster" && !trusted) {
			// hub attaches WebSocket data in phase two of the handshake
			const upgraded = server.upgrade(request, { data: { kind: "follower" } });

			if (upgraded) {
				return undefined;
			}

			return errorResponse("expected a WebSocket upgrade", 400);
		}

		if (path === "/info") {
			return jsonResponse({
				ok: true,
				name: dcfg.name,
				mode: dcfg.mode,
				root: dcfg.root,
				protocol: PROTOCOL_VERSION,
				// the build version is what an upgrade changes; the protocol above
				// is what refuses a mismatched client
				version: buildVersion(),
				commit: COMMIT,
				release: VERSION,
				buildAt: BUILD_AT,
				platform: buildPlatform(),
				pid: process.pid,
				startedAt,
				listen: dcfg.listen ?? null,
				// the console is a separate artifact run by a separate process, so
				// a stale one is invisible unless something says which it is; this
				// is that something
				console: dcfg.mode === "primary" ? await consoleStamp() ?? null : null,
			});
		}

		if (path === "/files/binary" || path === "/files/binary/meta") {
			return await handleBinary(path.endsWith("/meta"));
		}

		if (path.startsWith("/rpc/") && request.method === "POST") {
			return await handleRpc(decodeURIComponent(path.slice("/rpc/".length)), request);
		}

		if (path === "/jobs" && request.method === "POST") {
			return await handleJobStart(request);
		}

		if (path.startsWith("/jobs/")) {
			const id = path.slice("/jobs/".length);
			const job = getJob(id);

			if (!job) {
				return errorResponse("unknown or expired job", 404);
			}

			if (url.searchParams.has("stream")) {
				return jobStream(id);
			}

			return jsonResponse({ ok: true, job });
		}

		if (path === "/daemons/stream") {
			return daemonsStream();
		}

		if (path === "/events") {
			return jsonResponse({
				ok: true,
				events: getEvents(url.searchParams.get("instance") ?? undefined),
			});
		}

		const consoleMatch = /^\/instances\/([a-z0-9_-]+)\/console$/.exec(path);

		if (consoleMatch) {
			const cfg = await loadCluster();
			const inst = managedInstances(cfg)[consoleMatch[1]!];

			if (!inst) {
				return errorResponse("unknown instance", 404);
			}

			// the log lives on the owner's disk; a follower instance streams
			// through the hub's cluster-link tunnel instead of a local tail
			if (!ownsInstance(inst)) {
				const owner = inst.daemon ?? "?";

				if (!remoteConsole || !remoteConsole.connected(owner)) {
					return errorResponse(
						t("daemon.consoleUnreachable", { name: owner }),
						502,
					);
				}

				return remoteConsoleStream(owner, consoleMatch[1]!);
			}

			return consoleStream(join(instanceDir(inst), "logs", "latest.log"));
		}

		if (path.startsWith("/luna/stream/")) {
			const target = path.slice("/luna/stream".length) + url.search;

			try {
				return await lunaApi.openStream(target, request.signal);
			} catch (err) {
				return errorResponse(err instanceof Error ? err.message : String(err), 502);
			}
		}

		if (path.startsWith("/files/pool/")) {
			return await handlePoolFile(decodeURIComponent(path.slice("/files/pool/".length)));
		}

		if (path.startsWith("/files/stage/")) {
			const token = decodeURIComponent(path.slice("/files/stage/".length));

			if (request.method === "PUT" || request.method === "POST") {
				return await handleStageUpload(request, token);
			}

			return await handleStageFile(token);
		}

		if (path.startsWith("/files/backups/")) {
			return await handleBackupFile(decodeURIComponent(path.slice("/files/backups/".length)), request, dcfg);
		}

		if (path.startsWith("/files/datapacks/")) {
			return await handleDatapackFile(decodeURIComponent(path.slice("/files/datapacks/".length)));
		}

		if (path.startsWith("/files/map/") && (request.method === "GET" || request.method === "HEAD")) {
			return await handleMapFile(
				decodeURIComponent(path.slice("/files/map/".length)),
				request,
				request.method,
			);
		}

		return errorResponse("not found", 404);
	};
}
