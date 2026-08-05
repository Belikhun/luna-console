// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** Minimal Minecraft Server List Ping (status) client. */

import type { Socket } from "bun";

/** Encode an unsigned value as a protocol varint. */
function varint(value: number): number[] {
	const out: number[] = [];
	let rest = value;

	while (true) {
		if ((rest & ~0x7f) === 0) {
			out.push(rest);

			return out;
		}

		out.push((rest & 0x7f) | 0x80);
		rest >>>= 7;
	}
}

/** Frame a packet as `length · id · payload`, all varint-prefixed. */
function packet(id: number, payload: number[]): Uint8Array {
	const body = [...varint(id), ...payload];

	return new Uint8Array([...varint(body.length), ...body]);
}

/** Encode a length-prefixed UTF-8 protocol string. */
function str(text: string): number[] {
	const bytes = [...new TextEncoder().encode(text)];

	return [...varint(bytes.length), ...bytes];
}

export interface PingResult {
	online: number;
	max: number;
	version: string;
	latencyMs: number;
}

/**
 * Query a server's status handshake. Resolves undefined on any failure -
 * refused connection, timeout, or a response that never completes; so callers
 * can treat "not reachable" and "not a Minecraft server" the same way.
 */
export async function ping(
	host: string,
	port: number,
	timeoutMs = 2500,
): Promise<PingResult | undefined> {
	return await new Promise((resolvePing) => {
		const started = Date.now();

		let buf = new Uint8Array(0);
		let done = false;
		let sock: Socket<undefined> | undefined;

		const finish = (result: PingResult | undefined): void => {
			if (done) {
				return;
			}

			done = true;
			clearTimeout(timer);

			try {
				sock?.end();
			} catch {
				// already closed by the peer
			}

			resolvePing(result);
		};

		const timer = setTimeout(() => finish(undefined), timeoutMs);

		Bun.connect({
			hostname: host,
			port,

			socket: {
				open(s) {
					sock = s;

					// handshake: proto -1 (unspecified), next state 1
					s.write(
						packet(0x00, [
							...varint(0xffffff),
							...str(host),
							(port >> 8) & 0xff,
							port & 0xff,
							...varint(1),
						]),
					);

					s.write(packet(0x00, []));
				},

				data(_s, chunk) {
					const merged = new Uint8Array(buf.length + chunk.length);

					merged.set(buf);
					merged.set(chunk, buf.length);
					buf = merged;

					// The status response is `len · id · strlen · json`, and TCP hands it
					// over in arbitrary chunks; a read that runs off the end of the buffer
					// throws "incomplete" and we wait for the next one.
					let offset = 0;

					const readVarint = (): number => {
						let value = 0;
						let shift = 0;

						while (true) {
							if (offset >= buf.length) {
								throw new Error("incomplete");
							}

							const byte = buf[offset++]!;

							value |= (byte & 0x7f) << shift;

							if ((byte & 0x80) === 0) {
								return value;
							}

							shift += 7;
						}
					};

					try {
						readVarint(); // packet length
						readVarint(); // packet id

						const jsonLength = readVarint();

						if (buf.length < offset + jsonLength) {
							return;
						}

						const json = JSON.parse(
							new TextDecoder().decode(buf.slice(offset, offset + jsonLength)),
						);

						finish({
							online: json.players?.online ?? 0,
							max: json.players?.max ?? 0,
							version: json.version?.name ?? "?",
							latencyMs: Date.now() - started,
						});
					} catch (err) {
						if ((err as Error)?.message !== "incomplete") {
							finish(undefined);
						}
					}
				},

				error() {
					finish(undefined);
				},

				close() {
					finish(undefined);
				},
			},
		}).catch(() => finish(undefined));
	});
}

/** Plain TCP connect probe. */
export async function portOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
	return await new Promise((resolveProbe) => {
		let done = false;

		const finish = (open: boolean, sock?: Socket<undefined>): void => {
			if (done) {
				return;
			}

			done = true;
			clearTimeout(timer);

			try {
				sock?.end();
			} catch {
				// already closed by the peer
			}

			resolveProbe(open);
		};

		const timer = setTimeout(() => finish(false), timeoutMs);

		Bun.connect({
			hostname: host,
			port,

			socket: {
				open(sock) {
					finish(true, sock);
				},

				error() {
					finish(false);
				},

				close() {
					finish(false);
				},

				data() {
					// a connect probe never reads
				},
			},
		}).catch(() => finish(false));
	});
}
