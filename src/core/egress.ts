// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The open-web browser's only way out: an HTTP proxy on loopback, one per
 * session, that every connection the browser makes goes through.
 *
 * DevTools can pause a page's requests but not its WebSockets, and a name
 * checked before the browser resolves it can resolve differently a moment
 * later. So the browser resolves nothing itself (`--host-resolver-rules` maps
 * every name to nothing) and asks this proxy for each connection: a CONNECT
 * for TLS and WebSockets, an absolute-form request for plain HTTP. The proxy
 * resolves the name once with `resolveEgress`, refuses private, reserved and
 * host-local destinations, and dials the address it checked. Redirects,
 * subresources, workers and frames in other processes all come through here.
 *
 * A plain HTTP request is sent with `Connection: close`, so one client
 * connection never carries a second request to another host. A session's
 * traffic is capped; past the cap new connections are refused.
 */

import { createConnection, createServer } from "node:net";
import type { Server, Socket } from "node:net";

import { t } from "../shared/i18n";
import { resolveEgress } from "./netguard";
import type { EgressRules } from "./netguard";

/** The longest request head the proxy reads before giving up. */
const MAX_HEAD = 64 * 1024;

/** How long a connection may sit without traffic. */
const IDLE_MS = 5 * 60 * 1000;

/** Request headers that belong to the hop to the proxy, never forwarded. */
const HOP_HEADERS = new Set(["proxy-connection", "proxy-authorization", "connection", "keep-alive"]);

export interface EgressOptions extends EgressRules {
	/** Bytes the session may move in both directions before new connections are refused */
	maxBytes: number;
	/** Told about every refused destination, with the reason */
	onRefuse?: (target: string, reason: string, method: string) => void;
}

export interface EgressProxy {
	port: number;
	/** Bytes moved so far, both directions */
	readonly bytes: number;
	close(): void;
}

/** Start a session's proxy on a free loopback port. */
export async function startEgress(options: EgressOptions): Promise<EgressProxy> {
	const sockets = new Set<Socket>();
	let bytes = 0;

	const count = (chunk: Buffer): void => {
		bytes += chunk.length;
	};

	const refuse = (client: Socket, target: string, reason: string, method = "CONNECT"): void => {
		options.onRefuse?.(target, reason, method);
		client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${reason}\n`);
	};

	const track = (socket: Socket): void => {
		sockets.add(socket);
		socket.setTimeout(IDLE_MS, () => socket.destroy());
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());
	};

	/** Join two sockets, counting what passes; whichever ends ends the other. */
	const join = (client: Socket, upstream: Socket): void => {
		client.on("data", count);
		upstream.on("data", count);
		client.pipe(upstream);
		upstream.pipe(client);
		client.on("close", () => upstream.destroy());
		upstream.on("close", () => client.destroy());
	};

	const dial = async (client: Socket, host: string, port: number, method: string, shown: string): Promise<Socket | null> => {
		if (bytes >= options.maxBytes) {
			refuse(client, shown, t("core.egress.allowance"), method);

			return null;
		}

		let address: string;

		try {
			address = await resolveEgress(host, port, options);
		} catch (err) {
			refuse(client, shown, (err as Error).message, method);

			return null;
		}

		return await new Promise<Socket | null>((resolve) => {
			const upstream = createConnection({ host: address, port });

			track(upstream);
			upstream.once("connect", () => resolve(upstream));
			upstream.once("error", () => {
				client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
				resolve(null);
			});
		});
	};

	const handle = (client: Socket): void => {
		track(client);

		let head = Buffer.alloc(0);

		const onData = (chunk: Buffer): void => {
			head = Buffer.concat([head, chunk]);

			const end = head.indexOf("\r\n\r\n");

			if (end < 0) {
				if (head.length > MAX_HEAD) {
					client.destroy();
				}

				return;
			}

			client.off("data", onData);
			client.pause();
			void route(client, head.subarray(0, end).toString("latin1"), head.subarray(end + 4));
		};

		client.on("data", onData);
	};

	const route = async (client: Socket, headText: string, rest: Buffer): Promise<void> => {
		const [requestLine = "", ...headerLines] = headText.split("\r\n");
		const [method = "", target = "", version = "HTTP/1.1"] = requestLine.split(" ");

		if (method === "CONNECT") {
			const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target);

			if (!match) {
				refuse(client, target, t("core.egress.notHostPort"));

				return;
			}

			const upstream = await dial(client, match[1]!, Number(match[2]), method, target);

			if (!upstream) {
				return;
			}

			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");

			if (rest.length) {
				count(rest);
				upstream.write(rest);
			}

			join(client, upstream);
			client.resume();

			return;
		}

		let url: URL;

		try {
			url = new URL(target);
		} catch {
			refuse(client, target, t("core.egress.fullAddress"), method);

			return;
		}

		if (url.protocol !== "http:") {
			refuse(client, target, t("core.egress.httpOnly"), method);

			return;
		}

		const port = url.port
			? Number(url.port)
			: 80;
		const upstream = await dial(client, url.hostname, port, method, url.href);

		if (!upstream) {
			return;
		}

		const headers = headerLines.filter((line) => !HOP_HEADERS.has(line.slice(0, line.indexOf(":")).trim().toLowerCase()));
		const forward = [`${method} ${url.pathname}${url.search} ${version}`, ...headers, "Connection: close", "", ""].join("\r\n");

		count(Buffer.from(forward, "latin1"));
		upstream.write(forward, "latin1");

		if (rest.length) {
			count(rest);
			upstream.write(rest);
		}

		join(client, upstream);
		client.resume();
	};

	const server: Server = createServer(handle);

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});

	const address = server.address();
	const port = typeof address === "object" && address
		? address.port
		: 0;

	return {
		port,
		get bytes() {
			return bytes;
		},
		close() {
			server.close();

			for (const socket of sockets) {
				socket.destroy();
			}

			sockets.clear();
		},
	};
}
