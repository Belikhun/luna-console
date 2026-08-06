// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Pack state: `packs.lock.json` in the cluster root is the source of truth for
 * where every resource pack and data pack came from (Modrinth provenance,
 * installed version, update channel); the files on disk are derived, exactly
 * like the plugin lockfile. Resource pack *behaviour* (priority, required,
 * server rules) is NOT here: those live in the per-pack `.yml` definitions
 * under `<root>/packs`, which the luna-pack proxy plugin owns and reads.
 *
 * The lock is synced to followers like the other state files, but its single
 * writer is the primary; pack operations run there (the web console is
 * primary-only), and a data pack deploy forwarded to a follower carries the
 * lock as an argument rather than reading the mirror.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { statePath } from "./config";
import type { ProviderId, RemoteRef } from "./types";
import { t } from "../shared/i18n";

export type PackSource = ProviderId | "manual";

export type PackChannel = "release" | "beta" | "alpha";

/** The installed build of a pack, for identity and the downgrade guard. */
export interface PackInstall {
	versionId?: string;
	versionNumber?: string;
	sha512: string;
	/** MC versions the build supports, as the provider declares them */
	gameVersions?: string[];
	/** Publish date of the installed version; updates must be newer than this */
	publishedAt?: string;
}

/** Provenance of one pack file (resource pack zip or data pack zip). */
export interface PackEntry {
	/** File name in the pack's directory (packs/ or datapacks/) */
	file: string;
	source: PackSource;
	/** Provider the pack installs/updates from; absent for manual packs */
	remote?: RemoteRef;
	installed?: PackInstall;
	autoUpdate: boolean;
	/** Most unstable release channel to accept for updates (default "release") */
	channel?: PackChannel;
	/**
	 * Resource packs only, and only once the pack joins an addon group: the
	 * operator's own server rules. The `.yml` the proxy reads is then generated
	 * as these plus the instances the groups grant, so leaving a group takes
	 * exactly the granted names away and never a hand-written rule.
	 */
	servers?: string[];
	/**
	 * Resource packs only: this pack's definition was written by luna over a
	 * *runtime* registration; a plugin registers the same pack through
	 * luna-pack's dynamic API, and luna-pack prefers the file.
	 *
	 * It has to be recorded rather than observed. luna-pack's HTTP catalog
	 * publishes a definition's name but not where it came from, so once a `.yml`
	 * exists the plugin's registration behind it is invisible from outside. This
	 * flag is what makes the takeover reversible: without it, "give it back to
	 * the plugin" would be indistinguishable from "unregister the pack".
	 */
	takenOverFrom?: "plugin";
}

/** A data pack additionally knows which instances it deploys to. */
export interface DataPackEntry extends PackEntry {
	/** Instance names, or wildcards ("*", "*paper", …), the pack deploys to */
	targets: string[];
}

export interface PacksLock {
	version?: number;
	/** Keyed by pack key: the definition file's basename under packs/ */
	resourcepacks: Record<string, PackEntry>;
	/** Keyed by pack name: the pool zip's basename under datapacks/ */
	datapacks: Record<string, DataPackEntry>;
}

/** Path of the pack lockfile; the source of truth for pack provenance. */
export function packsLockPath(): string {
	return statePath("packs.lock.json");
}

/** Read the pack lockfile, treating a missing file as an empty lock. */
export async function loadPacksLock(): Promise<PacksLock> {
	if (!existsSync(packsLockPath())) {
		return { version: 1, resourcepacks: {}, datapacks: {} };
	}

	const lock: PacksLock = await Bun.file(packsLockPath()).json();

	lock.resourcepacks ??= {};
	lock.datapacks ??= {};

	return lock;
}

/** Write the pack lockfile with both sections key-sorted, to keep diffs small. */
export async function savePacksLock(lock: PacksLock): Promise<void> {
	const sorted: PacksLock = { version: lock.version ?? 1, resourcepacks: {}, datapacks: {} };

	for (const key of Object.keys(lock.resourcepacks).sort()) {
		sorted.resourcepacks[key] = lock.resourcepacks[key]!;
	}

	for (const key of Object.keys(lock.datapacks).sort()) {
		sorted.datapacks[key] = lock.datapacks[key]!;
	}

	await Bun.write(packsLockPath(), JSON.stringify(sorted, null, "\t") + "\n");
}

/** Pack keys are file-system-safe slugs, same alphabet luna-pack accepts. */
export const PACK_KEY_PATTERN = /^[a-z0-9_-]{1,64}$/;

/**
 * Derive a valid pack key from a free-form name (a Modrinth slug, an uploaded
 * file's basename). Throws when nothing usable remains.
 */
export function packKeyFrom(name: string): string {
	const key = name
		.toLowerCase()
		.replace(/\.zip$/, "")
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);

	if (!PACK_KEY_PATTERN.test(key)) {
		throw new Error(t("core.packslock.badName", { name }));
	}

	return key;
}

/**
 * Decode an uploaded pack payload and verify it is a zip (both pack kinds are
 * zips; a stray text file would otherwise break clients on download).
 */
export function decodePackZip(dataBase64: string): Uint8Array {
	const buf = Uint8Array.from(atob(dataBase64), (char) => char.charCodeAt(0));

	// zip local-file-header magic: PK\x03\x04 (empty archives use PK\x05\x06)
	const isZip =
		buf.length >= 4 &&
		buf[0] === 0x50 &&
		buf[1] === 0x4b &&
		(buf[2] === 0x03 || buf[2] === 0x05);

	if (!isZip) {
		throw new Error(t("core.packslock.notAZip"));
	}

	return buf;
}
