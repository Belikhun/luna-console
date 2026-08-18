// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bake the build identity into `src/version.ts` before compiling, so the binary
 * knows what it is (DESIGN.md §4.7). Run by `bun run build`; running it by hand
 * is harmless — it only rewrites the three constants.
 *
 * `--restore` writes the canonical from-source state back instead (COMMIT
 * "dev", BUILD_AT empty). The build script runs it after compiling, so a build
 * never leaves its own stamp in the working tree — a committed stamp is what
 * made release commits carry a two-day-old COMMIT (v1.5.8 said f496fd9).
 */

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const restore = process.argv.includes("--restore");

/**
 * Short SHA of the tree being built, or "dev" outside a git checkout — which is
 * what a container build is, since the image context excludes .git. CI passes
 * `LUNA_COMMIT` there so the image still reports what it was built from.
 */
async function gitCommit(): Promise<string> {
	if (process.env.LUNA_COMMIT) {
		return process.env.LUNA_COMMIT.slice(0, 7);
	}

	try {
		const proc = Bun.spawn(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"], {
			stdout: "pipe",
			stderr: "ignore",
		});

		const text = (await new Response(proc.stdout).text()).trim();

		await proc.exited;

		return text || "dev";
	} catch {
		return "dev";
	}
}

const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as { version?: string };

// the release workflow builds from a tag, which is the authority on the version
// there — package.json is what a local build uses
const version = process.env.LUNA_VERSION?.replace(/^v/, "") || (pkg.version ?? "0.0.0");
const commit = restore ? "dev" : await gitCommit();
const buildAt = restore ? "" : new Date().toISOString();

const path = join(ROOT, "src", "version.ts");
const source = await Bun.file(path).text();

const updated = source
	.replace(/export const VERSION = "[^"]*";/, `export const VERSION = "${version}";`)
	.replace(/export const COMMIT = "[^"]*";/, `export const COMMIT = "${commit}";`)
	.replace(/export const BUILD_AT = "[^"]*";/, `export const BUILD_AT = "${buildAt}";`);

// the repo is CRLF everywhere; a generator must not be the one file that isn't
await Bun.write(path, updated.replace(/(?<!\r)\n/g, "\r\n"));

if (restore) {
	console.log(`version.ts → ${version} (restored to from-source state)`);
} else {
	console.log(`version.ts → ${version}+${commit} (${buildAt})`);
}
