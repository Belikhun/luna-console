// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Cut a release: check the tree, bump the version, commit it, tag it.
 *
 * The tag is the thing that matters. `.github/workflows/release.yml` fires on
 * `v*` and builds one binary per platform plus the container image from it, and
 * `luna daemon upgrade` is what every follower uses to pull that down. So this
 * exists to make the tag trustworthy: it refuses to run on a dirty tree, on a
 * version that already has a tag, or on one that would move the fleet backwards.
 *
 * **It does not push.** Pushing the tag is what starts the public release, and
 * that is a decision, not a step - so the last thing this prints is the command
 * that does it. Pass `--push` when you mean it.
 *
 * Usage:
 *   bun run release 1.3.1
 *   bun run release 1.4.0-rc.1 --dry-run
 *   bun run release 1.3.1 --push
 */

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const PACKAGE_PATH = join(ROOT, "package.json");
const VERSION_PATH = join(ROOT, "src", "version.ts");

/** The branch a release is cut from; anything else needs --any-branch. */
const RELEASE_BRANCH = "main";

interface Options {
	version: string;
	dryRun: boolean;
	push: boolean;
	anyBranch: boolean;
	skipChecks: boolean;
}

/** Semver, with an optional prerelease tail. Build metadata is not accepted. */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function usage(): never {
	console.error("usage: bun run release <version> [--dry-run] [--push] [--any-branch] [--skip-checks]");
	console.error("       version is a bare semver, e.g. 1.3.1 or 1.4.0-rc.1");

	process.exit(1);
}

function parseOptions(argv: string[]): Options {
	const positional = argv.filter((arg) => !arg.startsWith("--"));
	const flags = new Set(argv.filter((arg) => arg.startsWith("--")));

	if (positional.length !== 1) {
		usage();
	}

	for (const flag of flags) {
		if (!["--dry-run", "--push", "--any-branch", "--skip-checks"].includes(flag)) {
			console.error(`unknown flag: ${flag}`);

			usage();
		}
	}

	// a `v` prefix is what the tag carries, not what the version is; accepting it
	// here means `release v1.3.1` does not silently produce `vv1.3.1`
	const version = positional[0]!.replace(/^v/, "");

	if (!SEMVER.test(version)) {
		console.error(`not a semver version: ${version}`);

		usage();
	}

	return {
		version,
		dryRun: flags.has("--dry-run"),
		push: flags.has("--push"),
		anyBranch: flags.has("--any-branch"),
		skipChecks: flags.has("--skip-checks"),
	};
}

/**
 * Run a command and return its stdout, or exit reporting what failed.
 *
 * Every git call here is load-bearing, so a failure is fatal rather than
 * something to carry on past with a half-made release.
 */
async function run(command: string[], allowFailure = false): Promise<string> {
	const proc = Bun.spawn(command, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
	const stdout = (await new Response(proc.stdout).text()).trim();
	const stderr = (await new Response(proc.stderr).text()).trim();
	const code = await proc.exited;

	if (code !== 0 && !allowFailure) {
		console.error(`failed: ${command.join(" ")}`);

		if (stderr) {
			console.error(stderr);
		}

		process.exit(1);
	}

	return code === 0 ? stdout : "";
}

/** Whether a command succeeded, for the checks that only care about that. */
async function succeeds(command: string[]): Promise<boolean> {
	const proc = Bun.spawn(command, { cwd: ROOT, stdout: "ignore", stderr: "ignore" });

	return (await proc.exited) === 0;
}

function fail(message: string, hint?: string): never {
	console.error(`✗ ${message}`);

	if (hint) {
		console.error(`  ${hint}`);
	}

	process.exit(1);
}

/**
 * Compare two semver versions, following the precedence rules in the spec.
 *
 * The prerelease half is the part worth getting right: `1.3.0-rc.1` is *older*
 * than `1.3.0`, and comparing those as strings says the opposite, which would
 * let a release candidate look like a downgrade of the release it precedes.
 *
 * @return negative when `left` is older, positive when newer, zero when equal
 */
function compareVersions(left: string, right: string): number {
	const a = SEMVER.exec(left)!;
	const b = SEMVER.exec(right)!;

	for (let index = 1; index <= 3; index += 1) {
		const difference = Number(a[index]) - Number(b[index]);

		if (difference !== 0) {
			return difference;
		}
	}

	const leftPre = a[4];
	const rightPre = b[4];

	// a version with no prerelease tail outranks one that has it
	if (!leftPre && !rightPre) {
		return 0;
	}

	if (!leftPre) {
		return 1;
	}

	if (!rightPre) {
		return -1;
	}

	const leftParts = leftPre.split(".");
	const rightParts = rightPre.split(".");

	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
		const leftPart = leftParts[index];
		const rightPart = rightParts[index];

		// a shorter set of identifiers is lower, given everything before matched
		if (leftPart === undefined) {
			return -1;
		}

		if (rightPart === undefined) {
			return 1;
		}

		const leftNumeric = /^\d+$/.test(leftPart);
		const rightNumeric = /^\d+$/.test(rightPart);

		if (leftNumeric && rightNumeric) {
			const difference = Number(leftPart) - Number(rightPart);

			if (difference !== 0) {
				return difference;
			}

			continue;
		}

		// numeric identifiers always rank below alphanumeric ones
		if (leftNumeric !== rightNumeric) {
			return leftNumeric ? -1 : 1;
		}

		if (leftPart !== rightPart) {
			return leftPart < rightPart ? -1 : 1;
		}
	}

	return 0;
}

/** The version `package.json` currently declares. */
async function currentVersion(): Promise<string> {
	const pkg = (await Bun.file(PACKAGE_PATH).json()) as { version?: string };

	return pkg.version ?? "0.0.0";
}

/**
 * Everything that must be true before a version number is written.
 *
 * The clean-tree check is the important one: it is what makes the tag mean
 * something, because the release commit then holds the version bump and nothing
 * else, and what the tag points at is exactly the tree that was reviewed.
 */
async function check(options: Options, current: string): Promise<void> {
	const status = await run(["git", "status", "--porcelain"]);

	if (status) {
		fail(
			"the working tree has uncommitted changes",
			"commit or stash them first; a release commit must carry only the version bump",
		);
	}

	const branch = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"]);

	if (branch !== RELEASE_BRANCH && !options.anyBranch) {
		fail(`on branch ${branch}, not ${RELEASE_BRANCH}`, "pass --any-branch if that is deliberate");
	}

	const tag = `v${options.version}`;

	if (await succeeds(["git", "rev-parse", "-q", "--verify", `refs/tags/${tag}`])) {
		fail(`${tag} already exists`, "pick another version; a published tag must never be moved");
	}

	// a release that goes backwards is worse than no release: `luna daemon
	// upgrade` compares build versions, so a follower offered an older one either
	// refuses it or downgrades the fleet
	if (compareVersions(options.version, current) <= 0) {
		fail(
			`${options.version} is not newer than the current ${current}`,
			"versions only ever move forward",
		);
	}

	if (options.skipChecks) {
		console.log("• skipping typecheck (--skip-checks)");

		return;
	}

	console.log("• typecheck");

	if (!(await succeeds(["bunx", "tsc", "--noEmit"]))) {
		fail(
			"typecheck failed",
			"the release workflow builds from the tag, so this would fail there too",
		);
	}
}

/**
 * Write the new version into both files that carry it.
 *
 * `src/version.ts` is generated by `genversion.ts` at build time but is checked
 * in, and its value is what a from-source run reports - so a bump that touched
 * only `package.json` would leave `luna version` lying until someone next built.
 *
 * `COMMIT` and `BUILD_AT` are reset to their from-source state ("dev", empty):
 * the release commit cannot carry its own SHA, and every build stamps the real
 * values before compiling. Leaving them alone let an accidentally committed
 * stamp survive the bump, so a release commit described some older build
 * (v1.5.8 shipped saying COMMIT f496fd9, a build from two days earlier).
 */
async function writeVersion(version: string, current: string): Promise<void> {
	const pkg = await Bun.file(PACKAGE_PATH).text();
	const bumpedPkg = pkg.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`);

	if (bumpedPkg === pkg) {
		fail(`could not find the version field in package.json (expected ${current})`);
	}

	const versionSource = await Bun.file(VERSION_PATH).text();

	if (!/export const VERSION = "[^"]*";/.test(versionSource)) {
		fail("could not find the VERSION constant in src/version.ts");
	}

	const bumpedSource = versionSource
		.replace(/export const VERSION = "[^"]*";/, `export const VERSION = "${version}";`)
		.replace(/export const COMMIT = "[^"]*";/, `export const COMMIT = "dev";`)
		.replace(/export const BUILD_AT = "[^"]*";/, `export const BUILD_AT = "";`);

	// the repo is CRLF everywhere; a generator must not be the one file that isn't
	await Bun.write(PACKAGE_PATH, crlf(bumpedPkg));
	await Bun.write(VERSION_PATH, crlf(bumpedSource));
}

function crlf(text: string): string {
	return text.replace(/(?<!\r)\n/g, "\r\n");
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const current = await currentVersion();
	const tag = `v${options.version}`;

	console.log(`release ${current} → ${options.version} (${tag})`);

	await check(options, current);

	if (options.dryRun) {
		console.log("• dry run, nothing written");
		console.log(`would bump package.json and src/version.ts, commit, and tag ${tag}`);

		return;
	}

	await writeVersion(options.version, current);
	console.log("• bumped package.json and src/version.ts");

	await run(["git", "add", "--", "package.json", "src/version.ts"]);
	await run(["git", "commit", "-m", `🔖 bump version to ${options.version}`]);
	console.log("• committed");

	// annotated, not lightweight: the release workflow and `daemon upgrade` both
	// treat a tag as a published artifact, and an annotated one carries who made
	// it and when. It is also signed when `tag.gpgsign` is set, which is why this
	// is the step most likely to fail - a locked agent is enough.
	if (!(await succeeds(["git", "tag", "-a", tag, "-m", tag]))) {
		// the commit is already made, and leaving it behind would mean a bump with
		// no tag for someone to unpick by hand. The tree was verified clean before
		// any of this, so dropping that one commit puts the repo back as found.
		await run(["git", "reset", "--hard", "HEAD~1"]);

		fail(
			`could not create ${tag}; the release commit has been rolled back`,
			"if tags are signed, check the gpg agent is unlocked and run this again",
		);
	}

	console.log(`• tagged ${tag}`);

	if (!options.push) {
		console.log("");
		console.log("nothing has been pushed. to publish this release:");
		console.log(`  git push origin ${RELEASE_BRANCH} --follow-tags`);

		return;
	}

	console.log("• pushing");
	await run(["git", "push", "origin", RELEASE_BRANCH, "--follow-tags"]);
	console.log(`✔ ${tag} pushed; the release workflow builds it from here`);
}

await main();
