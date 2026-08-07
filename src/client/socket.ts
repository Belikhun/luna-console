// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { existsSync } from "node:fs";
import { t } from "../shared/i18n";

import { PROTOCOL_VERSION } from "../shared/protocol";
import { socketCandidates } from "../shared/sockpath";

/**
 * Daemon discovery and transport for every client (CLI and web console). The
 * daemon is found by probing the well-known socket paths; the handshake caches
 * its /info answer; most importantly the cluster root, which is what keeps the
 * bridge's path helpers synchronous.
 */

export interface DaemonInfo {
	name: string;
	mode: "primary" | "follower";
	root: string;
	/** local API revision; a mismatch is refused */
	protocol: number;
	/** build identity, e.g. "1.0.0+6ee20ac" */
	version: string;
	commit: string;
	release: string;
	buildAt: string;
	platform: string;
	pid: number;
	startedAt: number;
	listen: { host: string; port: number } | null;
}

/** Local API protocol revision this client speaks. */
export const CLIENT_PROTOCOL = PROTOCOL_VERSION;

let connection: { socket: string; info: DaemonInfo } | undefined;

/** The friendly bail-out every command shows when no daemon answers. */
export class DaemonUnavailable extends Error {
	constructor() {
		super(t("daemon.clientUnavailable"));
	}
}

/**
 * Find the daemon and cache its handshake. Probes every well-known socket path
 * and keeps the first that answers /info. Throws DaemonUnavailable when none do.
 */
export async function ensureConnected(): Promise<DaemonInfo> {
	if (connection) {
		return connection.info;
	}

	for (const socket of socketCandidates()) {
		if (!existsSync(socket)) {
			continue;
		}

		try {
			const response = await fetch("http://luna/info", {
				unix: socket,
				signal: AbortSignal.timeout(1500),
			});

			if (!response.ok) {
				continue;
			}

			const info = (await response.json()) as DaemonInfo & { ok: boolean };

			if (info.protocol !== CLIENT_PROTOCOL) {
				throw new Error(
					t("daemon.protocolSkew", { daemon: info.protocol, client: CLIENT_PROTOCOL }),
				);
			}

			connection = { socket, info };

			return info;
		} catch (err) {
			if (err instanceof Error && err.message.includes("daemon protocol")) {
				throw err;
			}

			continue;
		}
	}

	throw new DaemonUnavailable();
}

/** The cached handshake. Only valid after ensureConnected resolved once. */
export function daemonInfo(): DaemonInfo {
	if (!connection) {
		throw new Error("not connected to the luna daemon yet");
	}

	return connection.info;
}

/** Whether the handshake already happened. */
export function isConnected(): boolean {
	return connection !== undefined;
}

/** Cluster root as reported by the daemon. */
export function clientRoot(): string {
	return daemonInfo().root;
}

/** Fetch against the daemon's unix socket. */
export async function dfetch(path: string, init?: RequestInit): Promise<Response> {
	await ensureConnected();

	return await fetch(`http://luna${path}`, { ...init, unix: connection!.socket });
}

/**
 * Follow an SSE stream from the daemon, invoking `onFrame` with each parsed
 * `data:` payload. Resolves when the daemon closes the stream.
 */
export async function followSse(
	path: string,
	onFrame: (data: unknown) => void,
	signal?: AbortSignal,
): Promise<void> {
	const response = await dfetch(path, { signal });

	if (!response.ok || !response.body) {
		throw new Error(`stream ${path} failed: HTTP ${response.status}`);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();

		if (done) {
			break;
		}

		buffer += decoder.decode(value, { stream: true });

		let boundary = buffer.indexOf("\n\n");

		while (boundary !== -1) {
			const chunk = buffer.slice(0, boundary);

			buffer = buffer.slice(boundary + 2);
			boundary = buffer.indexOf("\n\n");

			for (const line of chunk.split("\n")) {
				if (!line.startsWith("data: ")) {
					continue;
				}

				try {
					onFrame(JSON.parse(line.slice(6)));
				} catch {
					// a malformed frame is dropped, not fatal
				}
			}
		}
	}
}
