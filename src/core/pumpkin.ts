// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Pre-approving a Pumpkin component's capabilities.
 *
 * A Pumpkin plugin declares the capabilities it wants (sockets, its data
 * folder), and on first load the server **asks the operator on the console**
 * whether to grant them, caching the answer in `plugins/permission_cache.json`.
 * A luna instance runs inside a screen session with nobody attached, so that
 * prompt is never answered and the plugin is skipped: a backend would come up
 * with no luna in it and no obvious reason why.
 *
 * Deploying a component is therefore also consenting to it. The consent is
 * recorded exactly the way the server records its own, because the server
 * checks it strictly: the entry is keyed by the **sha256 of the .wasm**, so it
 * lapses on every rebuild, and its permission list must equal what the plugin
 * declares, element for element. That list comes from the `.permissions.json`
 * the build stages beside the artefact; a component arriving without one is
 * left to the prompt rather than guessed at.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { instanceDir, poolDir } from "./config";
import { traitsOf } from "./software";
import type { InstanceConfig } from "./types";

/** Suffix of the file a build stages beside a component. */
const MANIFEST_SUFFIX = ".permissions.json";

/** What the server reads on startup, and what this writes. */
const CACHE_FILE = "permission_cache.json";

interface CacheEntry {
	permissions_requested: string[];
	approved: boolean;
}

interface PermissionCache {
	entries: Record<string, CacheEntry>;
}

/** One component's outcome, so the caller can report what it did. */
export interface ConsentResult {
	file: string;
	/** granted = written now · already = unchanged · unknown = no manifest shipped */
	outcome: "granted" | "already" | "unknown";
}

/**
 * Record consent for every component deployed into `inst`.
 *
 * Idempotent: an entry whose hash and permission list already match is left
 * alone, so a redeploy that changed nothing rewrites nothing. Returns one
 * result per component found, empty for software that is not Pumpkin.
 */
export async function syncConsent(inst: InstanceConfig): Promise<ConsentResult[]> {
	if (traitsOf(inst.software, inst.mcVersion).kind !== "native") {
		return [];
	}

	const addonDir = join(instanceDir(inst), "plugins");

	if (!existsSync(addonDir)) {
		return [];
	}

	const components = (await readdir(addonDir)).filter((name) => name.endsWith(".wasm"));

	if (components.length === 0) {
		return [];
	}

	const cache = await readCache(join(addonDir, CACHE_FILE));
	const results: ConsentResult[] = [];
	let changed = false;

	for (const file of components) {
		const permissions = await declaredPermissions(file);

		if (!permissions) {
			results.push({ file, outcome: "unknown" });

			continue;
		}

		const hash = await sha256File(join(addonDir, file));
		const existing = cache.entries[hash];

		if (existing?.approved && sameList(existing.permissions_requested, permissions)) {
			results.push({ file, outcome: "already" });

			continue;
		}

		cache.entries[hash] = { permissions_requested: permissions, approved: true };
		changed = true;

		results.push({ file, outcome: "granted" });
	}

	if (changed) {
		await writeFile(join(addonDir, CACHE_FILE), `${JSON.stringify(cache, null, 2)}\n`);
	}

	return results;
}

/**
 * The permission list a component declares, from the manifest staged with it.
 *
 * Read from the pool rather than from the instance: the pool is what luna
 * deployed from, so the manifest there is the one describing the copy that
 * landed.
 */
async function declaredPermissions(file: string): Promise<string[] | undefined> {
	const manifest = join(poolDir(), `${file}${MANIFEST_SUFFIX}`);

	if (!existsSync(manifest)) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(await readFile(manifest, "utf8")) as { permissions?: unknown };

		if (!Array.isArray(parsed.permissions)) {
			return undefined;
		}

		return parsed.permissions.filter((entry): entry is string => typeof entry === "string");
	} catch {
		// a manifest we cannot read is the same as one that is not there: the
		// operator gets the prompt rather than a wrong grant
		return undefined;
	}
}

/** The existing cache, or an empty one when it is absent or unreadable. */
async function readCache(path: string): Promise<PermissionCache> {
	if (!existsSync(path)) {
		return { entries: {} };
	}

	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PermissionCache>;

		return { entries: parsed.entries ?? {} };
	} catch {
		return { entries: {} };
	}
}

/** Order matters: the server compares the two lists element by element. */
function sameList(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

async function sha256File(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(await Bun.file(path).arrayBuffer());

	return hasher.digest("hex");
}
