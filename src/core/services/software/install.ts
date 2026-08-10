// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Materializing a resolved build into an instance directory.
 *
 * Three shapes, one entry point. A `jar` or `native` build is a single verified
 * download; an `installer` build is a jar luna runs once, which then fetches the
 * loader's libraries itself and writes the argument file the server launches
 * from. The installer is the slow one by a wide margin, which is why it reports
 * its own output as progress rather than sitting silent for a minute.
 */

import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { downloadToFile, reportBytes } from "../download";
import type { ProgressReporter } from "../../progress";
import { t } from "../../../shared/i18n";
import type { SoftwareBuild } from "./types";

export interface InstallBuildOptions {
	/** Java binary the installer runs under; required for an installer build */
	java?: string;
	/** Argument file the installer is expected to produce, relative to `dir` */
	expectArgsFile?: string;
	/**
	 * Jar the installer is expected to produce, matched in `dir` and renamed to
	 * `target`.
	 *
	 * The pre-1.17 loaders install a runnable universal jar and no argument file,
	 * and its name carries the version (`forge-1.12.2-14.23.5.2859-universal.jar`),
	 * which a static `binaryName` trait cannot spell. Renaming it here is what lets
	 * the launch stay a plain `-jar server.jar` for every jar-kind software.
	 */
	expectJar?: RegExp;
	reporter?: ProgressReporter;
}

/**
 * Find the jar an installer left behind and rename it to what the launch expects.
 *
 * The installer is still in the directory at this point and matches nothing here,
 * but it is excluded anyway: a pattern loose enough to catch a future naming change
 * should not be able to rename luna's own download over the server it just installed.
 */
async function adoptInstalledJar(dir: string, pattern: RegExp, target: string, installer: string): Promise<void> {
	const installerName = installer.slice(dir.length + 1);
	const produced = (await readdir(dir)).filter(
		(file) => file !== installerName && file !== target && pattern.test(file),
	);

	if (produced.length === 0) {
		throw new Error(t("core.services.software.installerNoJar", { pattern: String(pattern) }));
	}

	// newest first, so a directory that already held an older install takes the jar
	// this run produced rather than whichever the filesystem happened to list first
	const stats = await Promise.all(
		produced.map(async (file) => ({ file, mtimeMs: (await stat(join(dir, file))).mtimeMs })),
	);

	stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

	await rename(join(dir, stats[0]!.file), join(dir, target));
}

/**
 * Run a loader installer against an instance directory.
 *
 * The installer writes into the directory it is pointed at and downloads the
 * loader's libraries itself, so it needs a working JVM and several tens of
 * seconds. Its own stdout is the only progress there is; the last line is
 * mirrored into the reporter so the operator can see it moving.
 */
async function runInstaller(
	dir: string,
	installer: string,
	java: string,
	reporter?: ProgressReporter,
): Promise<void> {
	reporter?.info(0.05, t("core.services.software.runningInstaller"));

	const proc = Bun.spawn([java, "-jar", installer, "--installServer", dir], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});

	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let tail = "";

	while (true) {
		const { done, value } = await reader.read();

		if (done) {
			break;
		}

		tail += decoder.decode(value, { stream: true });

		const lines = tail.split("\n");

		tail = lines.pop() ?? "";

		for (const line of lines) {
			const trimmed = line.trim();

			if (trimmed) {
				// the installer gives no percentage of its own, so the bar creeps
				// while its lines carry what is actually happening
				reporter?.info(0.5, trimmed);
			}
		}
	}

	const code = await proc.exited;

	if (code !== 0) {
		const stderr = await new Response(proc.stderr).text();

		throw new Error(t("core.services.software.installerFailed", { code, detail: stderr.trim().slice(-500) }));
	}
}

/**
 * Download and materialize a build into an instance directory. The file name
 * inside the instance is the caller's, not the provider's: luna's own layout
 * calls it `server.jar` whatever upstream named it.
 */
export async function installBuild(
	dir: string,
	target: string,
	build: SoftwareBuild,
	opts: InstallBuildOptions = {},
): Promise<void> {
	const reporter = opts.reporter;

	// creating an instance makes the directory first, but changing the version of
	// one that was registered and never provisioned does not - and that landed as
	// a bare ENOENT from the download's writer
	await mkdir(dir, { recursive: true });

	if (build.kind === "installer") {
		if (!opts.java) {
			throw new Error(t("core.services.software.installerNeedsJava", { software: build.software }));
		}

		const installer = join(dir, build.fileName);
		const download = reporter?.child(t("core.services.software.phaseDownload"), 2);

		await downloadToFile(build.url, installer, {
			expected: build.hashes,
			...(download ? { onProgress: reportBytes(download) } : {}),
		});

		download?.complete(t("core.services.software.downloaded"));

		const install = reporter?.child(t("core.services.software.phaseInstall"), 6);

		try {
			await runInstaller(dir, installer, opts.java, install);

			if (opts.expectArgsFile && !existsSync(join(dir, opts.expectArgsFile))) {
				throw new Error(t("core.services.software.installerNoArgsFile", { file: opts.expectArgsFile }));
			}

			if (opts.expectJar) {
				await adoptInstalledJar(dir, opts.expectJar, target, installer);
			}

			install?.complete(t("core.services.software.installed"));
		} finally {
			// the installer and its log are the installer's business, not the
			// server's; leaving them behind makes every instance directory noisier
			await rm(installer, { force: true });
			await rm(`${installer}.log`, { force: true });
			await rm(join(dir, "installer.log"), { force: true });
		}

		return;
	}

	await downloadToFile(build.url, join(dir, target), {
		expected: build.hashes,
		...(reporter ? { onProgress: reportBytes(reporter) } : {}),
	});

	if (build.kind === "native") {
		await chmod(join(dir, target), 0o755);
	}
}
