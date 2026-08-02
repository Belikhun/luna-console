/**
 * The daemon's API server: one fetch handler served over the local unix socket
 * (CLI + web console) and, on a primary, over TCP for followers and the
 * cluster WebSocket. Local requests are trusted; TCP requests must carry the
 * shared cluster token.
 */

import { join, normalize } from "node:path";
import { existsSync } from "node:fs";

import { loadCluster, managedInstances, instanceDir, poolDir } from "../core/config";
import * as lunaApi from "../core/services/luna";

import type { DaemonConfig } from "./config";
import { getEvents } from "./events";
import { ownsInstance } from "./identity";
import { getJob, startJob, watchJob, type JobView } from "./jobs";
import { runOp } from "./rpc";
import { localBinaryMeta, localBinaryPath } from "./upgrade";
import { BUILD_AT, COMMIT, VERSION, buildPlatform, buildVersion } from "../version";

/** Local API protocol revision — clients refuse to talk across a mismatch. */
export const PROTOCOL_VERSION = 2;

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
 * SSE stream of an instance's live console — `tail -F` on its latest.log. -F
 * rather than -f: the server rotates latest.log, and tail has to follow the new
 * file by name instead of holding the old descriptor open.
 */
function consoleStream(logPath: string): Response {
	let proc: ReturnType<typeof Bun.spawn> | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			proc = Bun.spawn(["tail", "-n", String(CONSOLE_TAIL_LINES), "-F", logPath], {
				stdout: "pipe",
				stderr: "ignore",
			});

			const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();

			void (async () => {
				try {
					while (true) {
						const { done, value } = await reader.read();

						if (done) {
							break;
						}

						const text = new TextDecoder().decode(value);

						for (const line of text.split("\n")) {
							if (line.length === 0) {
								continue;
							}

							controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
						}
					}
				} catch {
					// client disconnected mid-read
				}

				closeQuietly(controller);
			})();
		},

		cancel() {
			proc?.kill();
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
 * GET /files/binary[/meta] — the binary this daemon is running, for follower
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

/** GET /files/pool/<file> — jar streaming for follower pool mirroring. */
async function handlePoolFile(subpath: string): Promise<Response> {
	// the pool has one flat level plus versions/ — refuse anything that escapes
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

/**
 * Build the daemon's fetch handler. `trusted` marks the unix socket listener;
 * TCP requests must present the shared token instead.
 */
export function buildHandler(
	dcfg: DaemonConfig,
	trusted: boolean,
	startedAt: number,
): (request: Request, server: Bun.Server<WsData>) => Promise<Response | undefined> {
	return async (request: Request, server: Bun.Server<WsData>): Promise<Response | undefined> => {
		const url = new URL(request.url);
		const path = url.pathname;

		if (!trusted) {
			const token = request.headers.get("x-luna-token") ?? url.searchParams.get("token");

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

			// tailing needs the log on this disk — a follower instance's console
			// must fail loudly rather than stream silence from a missing file
			if (!ownsInstance(inst)) {
				return errorResponse(
					`console streaming for instances on daemon "${inst.daemon}" is not available yet`,
					501,
				);
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

		return errorResponse("not found", 404);
	};
}
