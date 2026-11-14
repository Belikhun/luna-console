// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The lock every writer of a DNS zone takes around its read-modify-write.
 *
 * Namecheap's `setHosts` replaces a whole zone, so two writers racing would each
 * read the zone, add their record and write, and the second would drop the
 * first one's record. Three programs write `belikhun.dev`: luna, harbor (copied
 * from `~/harbor/src/core/zonelock.ts`) and harbor's certbot hook, run as root.
 * They agree on one lock file, `/run/lock/namecheap-<zone>.lock`, and an
 * exclusive `flock` on it, which the kernel drops when the holder exits, so a
 * crashed writer never leaves the zone locked.
 *
 * Bun has no `flock`, so it is called from libc. It is polled with `LOCK_NB`
 * rather than blocking, which would stall the daemon's event loop.
 *
 * The file is opened read-only and created only when missing: `/run/lock` is
 * sticky and world-writable, and with `fs.protected_regular` an `O_CREAT` open
 * of a file someone else owns there is refused, even to root.
 */

import { closeSync, constants, openSync } from "node:fs";
import { dlopen, FFIType } from "bun:ffi";

import { t } from "../../shared/i18n";

const LOCK_EX = 2;
const LOCK_NB = 4;

/** How often a held lock is tried again. */
const POLL_MS = 250;

/** The lock file every writer of `zone` takes. */
export function zoneLockPath(zone: string): string {
	return `/run/lock/namecheap-${zone}.lock`;
}

/** How long a writer waits before giving up; a zone write takes seconds, a certbot challenge a few minutes. */
export const ZONE_LOCK_TIMEOUT_MS = 6 * 60_000;

let libc: { symbols: { flock: (fd: number, operation: number) => number } } | undefined;

function flock(fd: number, operation: number): number {
	libc ??= dlopen("libc.so.6", {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	});

	return libc.symbols.flock(fd, operation);
}

function openLock(path: string): number {
	try {
		return openSync(path, constants.O_RDONLY);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw err;
		}
	}

	try {
		return openSync(path, constants.O_RDONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
	} catch (err) {
		// another writer created it between the two opens
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			return openSync(path, constants.O_RDONLY);
		}

		throw err;
	}
}

/**
 * Run `work` holding the zone's lock. `onWait` is called once if another writer
 * holds it, so a job can say why it is not moving.
 */
export async function withZoneLock<T>(path: string, work: () => Promise<T>, onWait?: () => void): Promise<T> {
	const fd = openLock(path);
	const deadline = Date.now() + ZONE_LOCK_TIMEOUT_MS;
	let waited = false;

	try {
		while (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
			if (Date.now() > deadline) {
				throw new Error(t("core.domains.lockTimeout", { path }));
			}

			if (!waited) {
				waited = true;
				onWait?.();
			}

			await Bun.sleep(POLL_MS);
		}

		return await work();
	} finally {
		// closing the descriptor releases the lock
		closeSync(fd);
	}
}
