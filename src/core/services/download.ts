// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { unlink } from "node:fs/promises";

import { t } from "../../shared/i18n";

/**
 * Shared file helpers for the provider clients: verified downloads and
 * hashing. Every provider publishes a different hash (Modrinth sha512, Hangar
 * sha256, CurseForge sha1, Smithed none), so a download verifies whatever the
 * provider knew and always returns the sha512 luna's lockfiles key identity on.
 */

/** User-Agent every outbound provider request carries. */
export const USER_AGENT = "belikhun/luna-console";

/** The hashes a provider published for a file, by algorithm. */
export interface KnownHashes {
	sha512?: string;
	sha256?: string;
	sha1?: string;
}

const HASH_ALGOS = ["sha512", "sha256", "sha1"] as const;

/**
 * Download a file to `dest`, verifying every hash the provider published.
 * Returns the sha512 of what was written; computed locally, so callers can
 * record it even when the provider never published one.
 */
export async function download(
	url: string,
	dest: string,
	expected: KnownHashes = {},
): Promise<string> {
	const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

	if (!res.ok) {
		throw new Error(t("core.services.downloadFailed", { status: res.status, url }));
	}

	const buf = new Uint8Array(await res.arrayBuffer());

	for (const algo of HASH_ALGOS) {
		const want = expected[algo];

		if (!want) {
			continue;
		}

		const hasher = new Bun.CryptoHasher(algo);

		hasher.update(buf);

		if (hasher.digest("hex") !== want.toLowerCase()) {
			throw new Error(t("core.services.hashMismatch", { algo, url }));
		}
	}

	await Bun.write(dest, buf);

	const hasher = new Bun.CryptoHasher("sha512");

	hasher.update(buf);

	return hasher.digest("hex");
}

/** Bytes written so far, and the total when the server sent a content-length. */
export type WriteProgress = (received: number, total?: number) => void;

/**
 * Stream a file to `dest`, hashing as it goes. Unlike `download`, nothing is
 * held in memory: a JDK archive is a few hundred megabytes, and buffering one
 * per concurrent install is how a daemon runs a machine out of RAM.
 *
 * A hash the caller expected but did not get leaves nothing behind - the
 * partial file is removed before the error propagates, so a retry cannot
 * mistake it for a finished download.
 */
export async function downloadToFile(
	url: string,
	dest: string,
	opts: {
		expected?: KnownHashes;
		headers?: Record<string, string>;
		onProgress?: WriteProgress;
	} = {},
): Promise<string> {
	const expected = opts.expected ?? {};
	const res = await fetch(url, {
		headers: { "User-Agent": USER_AGENT, ...(opts.headers ?? {}) },
	});

	if (!res.ok || !res.body) {
		throw new Error(t("core.services.downloadFailed", { status: res.status, url }));
	}

	const length = Number(res.headers.get("content-length") ?? 0);
	const total = length > 0 ? length : undefined;

	// sha512 is always computed: it is the identity luna records, whether or not
	// the vendor published one to check against
	const hashers = new Map<(typeof HASH_ALGOS)[number], Bun.CryptoHasher>();

	hashers.set("sha512", new Bun.CryptoHasher("sha512"));

	for (const algo of HASH_ALGOS) {
		if (expected[algo] && !hashers.has(algo)) {
			hashers.set(algo, new Bun.CryptoHasher(algo));
		}
	}

	const sink = Bun.file(dest).writer();
	let received = 0;

	try {
		for await (const chunk of res.body as ReadableStream<Uint8Array>) {
			for (const hasher of hashers.values()) {
				hasher.update(chunk);
			}

			sink.write(chunk);
			received += chunk.byteLength;
			opts.onProgress?.(received, total);
		}

		await sink.end();
	} catch (err) {
		await Promise.resolve(sink.end()).catch(() => undefined);
		await unlink(dest).catch(() => undefined);

		throw err;
	}

	for (const algo of HASH_ALGOS) {
		const want = expected[algo];

		if (!want) {
			continue;
		}

		if (hashers.get(algo)!.digest("hex") !== want.toLowerCase()) {
			await unlink(dest).catch(() => undefined);

			throw new Error(t("core.services.hashMismatch", { algo, url }));
		}
	}

	return hashers.get("sha512")!.digest("hex");
}

/** sha512 of a file on disk, in the hex form the lockfiles store. */
export async function sha512File(path: string): Promise<string> {
	const buf = new Uint8Array(await Bun.file(path).arrayBuffer());
	const hasher = new Bun.CryptoHasher("sha512");

	hasher.update(buf);

	return hasher.digest("hex");
}

/**
 * Every hash a provider might have published for this file, computed in one
 * read. Identifying a local file against a project means comparing against
 * whichever algorithm its provider happens to publish, and the file is on disk
 * either way; so all three are cheaper than guessing which one is needed.
 */
export async function hashesOfFile(path: string): Promise<Required<KnownHashes>> {
	const buf = new Uint8Array(await Bun.file(path).arrayBuffer());
	const out = {} as Record<(typeof HASH_ALGOS)[number], string>;

	for (const algo of HASH_ALGOS) {
		const hasher = new Bun.CryptoHasher(algo);

		hasher.update(buf);
		out[algo] = hasher.digest("hex");
	}

	return out as Required<KnownHashes>;
}
