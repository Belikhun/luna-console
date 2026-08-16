// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The holding area an uploaded world sits in between the browser and the world.
 *
 * A world zip cannot travel the way every other upload in luna does. Plugin
 * jars and pack zips go base64 inside a JSON body and cross the daemon socket
 * as an RPC argument, which is fine at a few megabytes and impossible at a few
 * gigabytes: base64 costs a third again in size, and an RPC argument is
 * serialised into memory whole.
 *
 * So the bytes go to disk first, over their own streaming endpoint, and what
 * crosses the RPC boundary afterwards is a token naming the file. That has a
 * second payoff on a follower topology: provisioning an instance the primary
 * does not own means the world has to reach that machine, and a token in the
 * options object is something a follower can act on by pulling the file itself.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { stagingDir } from "./config";
import { t } from "../shared/i18n";

/**
 * How long an unclaimed upload survives.
 *
 * Long enough that an operator can upload a world, wander off, and still submit
 * the launch form when they come back; short enough that an abandoned 20 GB
 * upload does not sit on the disk this feature is already competing for.
 */
export const STAGE_TTL_MS = 12 * 60 * 60_000;

/** Shape of a staging token; the daemon endpoint enforces the same one. */
const TOKEN_PATTERN = /^[a-z0-9]{8,64}$/;

/** A staged upload, as the console describes it back to the user. */
export interface StagedFile {
	token: string;
	bytes: number;
	/** When it was uploaded */
	createdAt: number;
	/** When the sweeper will remove it if nothing has claimed it */
	expiresAt: number;
}

/** Mint a token for a new upload. Opaque, and not derived from anything. */
export function newStageToken(): string {
	return crypto.randomUUID().replace(/-/g, "");
}

/** Absolute path of a staged upload; throws on a token that is not ours. */
export function stagePath(token: string): string {
	if (!TOKEN_PATTERN.test(token)) {
		throw new Error(t("core.staging.badToken"));
	}

	return join(stagingDir(), `${token}.zip`);
}

/** Whether a token names a staged file that is actually here. */
export function stageExists(token: string): boolean {
	try {
		return existsSync(stagePath(token));
	} catch {
		return false;
	}
}

/** What is known about one staged upload; undefined when it is not here. */
export async function stageInfo(token: string): Promise<StagedFile | undefined> {
	const path = stagePath(token);
	const info = await stat(path).catch(() => undefined);

	if (!info) {
		return undefined;
	}

	return {
		token,
		bytes: info.size,
		createdAt: info.mtimeMs,
		expiresAt: info.mtimeMs + STAGE_TTL_MS,
	};
}

/** Make sure the staging directory is there before anything writes into it. */
export async function ensureStagingDir(): Promise<void> {
	await mkdir(stagingDir(), { recursive: true });
}

/** Remove a staged upload. Idempotent; used both on success and on cancel. */
export async function discardStage(token: string): Promise<void> {
	await rm(stagePath(token), { force: true });
}

/**
 * Delete staged uploads nobody claimed.
 *
 * Runs on daemon start and on a timer. Partial `.part` files are swept on the
 * same rule: a transfer interrupted by a daemon restart has no way to resume,
 * so leaving it costs disk and buys nothing.
 */
export async function sweepStages(now = Date.now()): Promise<number> {
	const dir = stagingDir();

	if (!existsSync(dir)) {
		return 0;
	}

	let removed = 0;

	for (const file of await readdir(dir)) {
		if (!file.endsWith(".zip") && !file.endsWith(".zip.part")) {
			continue;
		}

		const path = join(dir, file);
		const info = await stat(path).catch(() => undefined);

		if (!info || now - info.mtimeMs < STAGE_TTL_MS) {
			continue;
		}

		await rm(path, { force: true });

		removed++;
	}

	return removed;
}
