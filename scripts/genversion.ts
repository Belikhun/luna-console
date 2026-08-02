/**
 * Bake the build identity into `src/version.ts` before compiling, so the binary
 * knows what it is (DESIGN.md §4.7). Run by `bun run build`; running it by hand
 * is harmless — it only rewrites the three constants.
 */

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Short SHA of the tree being built, or "dev" outside a git checkout. */
async function gitCommit(): Promise<string> {
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
const version = pkg.version ?? "0.0.0";
const commit = await gitCommit();
const buildAt = new Date().toISOString();

const path = join(ROOT, "src", "version.ts");
const source = await Bun.file(path).text();

const updated = source
	.replace(/export const VERSION = "[^"]*";/, `export const VERSION = "${version}";`)
	.replace(/export const COMMIT = "[^"]*";/, `export const COMMIT = "${commit}";`)
	.replace(/export const BUILD_AT = "[^"]*";/, `export const BUILD_AT = "${buildAt}";`);

// the repo is CRLF everywhere; a generator must not be the one file that isn't
await Bun.write(path, updated.replace(/(?<!\r)\n/g, "\r\n"));

console.log(`version.ts → ${version}+${commit} (${buildAt})`);
