// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * A server's own `usercache.json`: the name-to-uuid table it keeps beside
 * `server.properties`, and the closest thing to "who the server believes a
 * player is". Read-only here; the server maintains it.
 *
 * Both directions are wanted: the access lists resolve a typed name to the id
 * the list files use, and the saved-player screens name an id the proxy handed
 * them. Neither caller should own the parsing, so it lives here.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

interface UsercacheEntry {
	name?: string;
	uuid?: string;
}

/** The raw entries, tolerating an absent or malformed file. */
export async function readUsercache(dir: string): Promise<UsercacheEntry[]> {
	const path = join(dir, "usercache.json");

	if (!existsSync(path)) {
		return [];
	}

	try {
		const parsed = (await Bun.file(path).json()) as unknown;

		return Array.isArray(parsed) ? (parsed as UsercacheEntry[]) : [];
	} catch {
		return [];
	}
}

/** Every cached id (lower-cased) to the name the server knows it by. */
export async function usercacheNames(dir: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();

	for (const entry of await readUsercache(dir)) {
		if (entry.uuid && entry.name) {
			out.set(entry.uuid.toLowerCase(), entry.name);
		}
	}

	return out;
}

/** The name the server knows a profile id by, for bare-UUID references. */
export async function usercacheNameOf(dir: string, uuid: string): Promise<string | undefined> {
	return (await usercacheNames(dir)).get(uuid.toLowerCase());
}

/** The id the server filed a name under, matched case-insensitively. */
export async function usercacheUuidOf(dir: string, name: string): Promise<string | undefined> {
	const lowered = name.toLowerCase();

	for (const entry of await readUsercache(dir)) {
		if (entry.name?.toLowerCase() === lowered && entry.uuid) {
			return entry.uuid;
		}
	}

	return undefined;
}
