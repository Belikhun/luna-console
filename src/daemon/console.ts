// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Installing the web console beside the binary.
 *
 * The console is a separate artifact from the daemon - a SvelteKit bundle run by
 * `bun`, not code inside the compiled binary - and for a long time nothing kept
 * the two together: `luna daemon upgrade` swapped the binary, `luna web` served
 * whatever `web/build` happened to be in a checkout on that machine, and the
 * only thing tying them together was somebody remembering to run
 * `cd web && bun run build`. A console can sit months behind the daemon that way
 * and give no sign of it beyond a missing feature.
 *
 * So the release publishes the bundle (`luna-console.tar.gz`) beside the
 * binaries, and an upgrade installs both from the *same* release. What is
 * installed is stamped, so "which console is this" has an answer that does not
 * involve reading file dates.
 *
 * **Primary only.** The console talks to its daemon over the local socket and
 * only ever runs beside a primary, so a follower installing 8 MB of javascript
 * it can never serve would be pure cost.
 */

import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { consoleDir, isConsoleDir, root } from "../core/config";
import type { ProgressReporter } from "../core/progress";
import { t } from "../shared/i18n";

import { log } from "./index";

/** What the installed console records about itself. */
export interface ConsoleStamp {
	/** Build version of the release this bundle came from, e.g. "1.3.2" */
	version: string;
	installedAt: string;
	/** Where it was fetched from, for a human reading the file */
	origin: string;
}

/** The stamp file, inside the console directory so it travels with the swap. */
const STAMP_FILE = ".luna-console.json";

/** Read the installed console's stamp, or undefined when nothing is installed. */
export async function consoleStamp(): Promise<ConsoleStamp | undefined> {
	const path = join(consoleDir(), STAMP_FILE);

	if (!existsSync(path)) {
		return undefined;
	}

	try {
		return (await Bun.file(path).json()) as ConsoleStamp;
	} catch {
		// a truncated stamp means the console is still there and still runnable;
		// only its provenance is lost, which is not worth failing a status call
		return undefined;
	}
}

/** Whether a console is installed in the cluster root at all. */
export function consoleInstalled(): boolean {
	return isConsoleDir(consoleDir());
}

/**
 * Unpack a console tarball over the installed one.
 *
 * The swap is a directory rename, for the same reason the binary's is a file
 * rename: the console is being served by a *live* process while this runs, and
 * extracting over the directory in place would hand that process a half-written
 * bundle - a chunk file that exists but is truncated is worse than one that is
 * missing, because the browser caches it.
 *
 * `tar` rather than a library: the archive comes from GNU tar in the release
 * workflow, this only ever runs on Linux, and shelling out to the tool that
 * wrote it is fewer moving parts than a decompressor that has to agree with it.
 */
export async function installConsole(
	bytes: Uint8Array,
	version: string,
	origin: string,
	reporter?: ProgressReporter,
): Promise<void> {
	const target = consoleDir();
	const staging = `${target}.new`;
	const previous = `${target}.old`;
	const archive = join(root(), ".luna-console.tar.gz");

	// a staging directory left by an interrupted upgrade would otherwise have the
	// new bundle extracted *into* it, mixing two releases in one directory
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });

	try {
		await Bun.write(archive, bytes);

		const proc = Bun.spawn(["tar", "-xzf", archive, "-C", staging], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const stderr = await new Response(proc.stderr).text();

		if ((await proc.exited) !== 0) {
			throw new Error(t("daemon.console.extractFailed", { error: stderr.trim() || "tar failed" }));
		}

		if (!isConsoleDir(staging)) {
			throw new Error(t("daemon.console.noBuild", { asset: origin }));
		}

		const stamp: ConsoleStamp = {
			version,
			installedAt: new Date().toISOString(),
			origin,
		};

		await writeFile(join(staging, STAMP_FILE), JSON.stringify(stamp, null, "\t"));

		// rename the old one aside rather than deleting it first: between a delete
		// and a rename there is a window with no console at all, and the console
		// service restarts on its own schedule
		await rm(previous, { recursive: true, force: true });

		if (existsSync(target)) {
			await rename(target, previous);
		}

		await rename(staging, target);
		await rm(previous, { recursive: true, force: true });

		log(`console: installed ${version} from ${origin}`);
		reporter?.complete(t("daemon.console.installed", { version }));
	} finally {
		await rm(archive, { force: true });
		await rm(staging, { recursive: true, force: true });
	}
}
