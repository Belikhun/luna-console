// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Pumpkin release client.
 *
 * Pumpkin is a Minecraft server written in Rust, so what is downloaded is a
 * native executable for one platform rather than a jar that runs anywhere. The
 * asset therefore has to be picked for the machine that will *run* it, which on
 * a mixed-architecture fleet is not the machine resolving the build; the
 * platform travels in the spec, exactly as a runtime install already does.
 *
 * A release tag names three versions at once: `0.2.0+26.3-26.51` is pumpkin
 * 0.2.0, serving Java 26.3 and Bedrock 26.51. Luna splits it the way it splits
 * a loader build from its game: the Java version is the instance's
 * `mcVersion`, which is what pack formats and plugin compatibility read, and
 * the whole tag is its `loaderVersion`, the build an upgrade moves. The rolling
 * `nightly` and `canary` releases are republished under the same tag, so they
 * name no build anyone could pin and are not offered.
 */

import type { Software } from "../../types";
import { splitPlatform } from "../adoptium";
import { USER_AGENT } from "../download";
import { listRepoReleases, type RepoRelease } from "../github";
import { compareMcVersionsDesc } from "../../software";
import { t } from "../../../shared/i18n";
import { buildPlatform } from "../../../version";
import { memoized } from "./resolve";
import type { ResolvedBuildSpec, SoftwareBuild, SoftwareProviderClient } from "./types";

const REPO = "Pumpkin-MC/Pumpkin";

/** The checksum list every versioned release carries, `<sha256>  <asset>` per line. */
const CHECKSUMS_ASSET = "checksums.sha256";

/** `<pumpkin semver>+<java version>-<bedrock version>` */
const TAG_PATTERN = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\+(\d+(?:\.\d+)+)-(\d+(?:\.\d+)+)$/;

/** A versioned release, its tag taken apart. */
interface PumpkinRelease {
	tag: string;
	/** Pumpkin's own semver, e.g. `0.2.0` or `0.1.0-dev` */
	version: string;
	javaVersion: string;
	/** A semver pre-release (`0.1.0-dev`), whatever GitHub's flag says */
	unstable: boolean;
	release: RepoRelease;
}

/**
 * Asset name for a platform triple: pumpkin publishes `pumpkin-X64-Linux` and
 * friends, capitalising the architecture and the operating system.
 */
function assetFor(platform: string): string | undefined {
	const { os, arch } = splitPlatform(platform);

	const arches: Record<string, string> = { x64: "X64", arm64: "ARM64", aarch64: "ARM64" };
	const systems: Record<string, string> = { linux: "Linux", darwin: "macOS", win32: "Windows" };

	const archName = arches[arch];
	const osName = systems[os];

	if (!archName || !osName) {
		return undefined;
	}

	return `pumpkin-${archName}-${osName}${osName === "Windows" ? ".exe" : ""}`;
}

/**
 * How much of an executable to read for the glibc versions it needs. The
 * dynamic string table naming them sits in the first few kilobytes of the ELF
 * (8 KB into pumpkin 0.2.0's), so this is generous without fetching a 120 MB
 * file to answer one question.
 */
const ELF_HEAD_BYTES = 65_536;

/** A `major.minor` glibc version as one comparable number. */
function glibcRank(version: string): number {
	const [major, minor] = version.split(".").map(Number);

	return (major ?? 0) * 1000 + (minor ?? 0);
}

/**
 * The glibc this process runs against, or nothing on a host without one
 * (musl, or a platform that is not linux at all).
 */
function runtimeGlibc(): string | undefined {
	const report = (process as { report?: { getReport?: () => unknown } }).report?.getReport?.() as
		| { header?: { glibcVersionRuntime?: string } }
		| undefined;

	return report?.header?.glibcVersionRuntime;
}

/**
 * The newest glibc a published executable needs, read from its first bytes.
 * Undefined when the range cannot be fetched, which the caller treats as "no
 * evidence against the glibc build".
 */
async function glibcNeeded(url: string): Promise<string | undefined> {
	try {
		const response = await fetch(url, {
			headers: { "User-Agent": USER_AGENT, Range: `bytes=0-${ELF_HEAD_BYTES - 1}` },
		});

		if (!response.ok) {
			return undefined;
		}

		const head = Buffer.from(await response.arrayBuffer()).subarray(0, ELF_HEAD_BYTES).toString("latin1");
		const versions = [...head.matchAll(/GLIBC_(\d+\.\d+)/g)].map((match) => match[1]!);

		if (!versions.length) {
			return undefined;
		}

		return versions.sort((a, b) => glibcRank(b) - glibcRank(a))[0];
	} catch {
		return undefined;
	}
}

/**
 * Whether the machine about to run a linux build needs the static musl one.
 *
 * Pumpkin links its linux builds against whatever glibc its CI runner had, and
 * that differs per architecture: 0.2.0's x64 build needs 2.35, its ARM64 build
 * 2.43, newer than the distribution a Raspberry Pi runs, where it dies before
 * writing a single log line. The musl build is static and runs anywhere, but
 * musl's allocator is the slower one, so it is only chosen when the glibc
 * build cannot start. That can only be judged for this machine: a build
 * resolved for another platform keeps the glibc asset, and the daemon that owns
 * the instance, which is the one that installs it, resolves for itself.
 */
async function wantsMusl(platform: string, glibcUrl: string): Promise<boolean> {
	if (!platform.startsWith("linux-") || platform !== buildPlatform()) {
		return false;
	}

	const runtime = runtimeGlibc();

	if (!runtime) {
		return true;
	}

	const needed = await glibcNeeded(glibcUrl);

	return needed !== undefined && glibcRank(needed) > glibcRank(runtime);
}

/** A tag taken apart, or nothing for the rolling releases. */
function parseRelease(release: RepoRelease): PumpkinRelease | undefined {
	const match = TAG_PATTERN.exec(release.tag);

	if (!match) {
		return undefined;
	}

	const version = match[1]!;

	return {
		tag: release.tag,
		version,
		javaVersion: match[2]!,
		unstable: version.includes("-") || release.prerelease,
		release,
	};
}

/**
 * Versioned releases, newest first. GitHub's anonymous rate limit is 60 an
 * hour, so the list is fetched once and reused rather than asked for per
 * question.
 */
const releases = memoized(async (): Promise<PumpkinRelease[]> => {
	// pre-releases are fetched because the rolling ones are flagged as such and
	// a versioned pre-release is still a pinnable build; the shared client is
	// what carries the API token, so this does not spend the anonymous budget
	// the upgrade checker also draws on
	const listed = await listRepoReleases(REPO, { perPage: 30, prerelease: true });
	const parsed: PumpkinRelease[] = [];

	for (const release of listed) {
		const entry = parseRelease(release);

		if (entry) {
			parsed.push(entry);
		}
	}

	return parsed;
});

/** The releases serving one Java version, stable ones first, each group newest first. */
async function releasesFor(javaVersion: string): Promise<PumpkinRelease[]> {
	const matching = (await releases()).filter((entry) => entry.javaVersion === javaVersion);
	const stable = matching.filter((entry) => !entry.unstable);
	const unstable = matching.filter((entry) => entry.unstable);

	return [...stable, ...unstable];
}

/**
 * The published sha256 of one asset, or nothing when the release carries no
 * checksum list (the earliest ones did not). A list that fails to load is the
 * same as one that is not there: the download still records what arrived.
 */
async function publishedSha256(release: RepoRelease, assetName: string): Promise<string | undefined> {
	const list = release.assets.find((entry) => entry.name === CHECKSUMS_ASSET);

	if (!list) {
		return undefined;
	}

	try {
		const response = await fetch(list.url, { headers: { "User-Agent": USER_AGENT } });

		if (!response.ok) {
			return undefined;
		}

		for (const line of (await response.text()).split(/\r?\n/)) {
			const [hash, name] = line.trim().split(/\s+\*?/);

			if (name === assetName && hash) {
				return hash.toLowerCase();
			}
		}
	} catch {
		return undefined;
	}

	return undefined;
}

/**
 * The release a spec names.
 *
 * A pinned build is looked up by its whole tag. An instance created before
 * luna split the tag recorded it as its `mcVersion`, and nothing as its
 * loader, so a tag in that field is honoured the same way rather than
 * stranding the instance on a version nobody publishes.
 */
async function pick(spec: ResolvedBuildSpec): Promise<PumpkinRelease | undefined> {
	const all = await releases();
	const pinned = spec.loaderVersion ?? (TAG_PATTERN.test(spec.mcVersion) ? spec.mcVersion : undefined);

	if (pinned) {
		return all.find((entry) => entry.tag === pinned);
	}

	return (await releasesFor(spec.mcVersion))[0];
}

export const client: SoftwareProviderClient = {
	id: "pumpkin",
	async listMcVersions(): Promise<string[]> {
		const versions = new Set((await releases()).map((entry) => entry.javaVersion));

		return [...versions].sort(compareMcVersionsDesc);
	},

	async listLoaderVersions(_software: Software, mcVersion?: string): Promise<string[]> {
		if (!mcVersion) {
			return (await releases()).map((entry) => entry.tag);
		}

		return (await releasesFor(mcVersion)).map((entry) => entry.tag);
	},

	async resolveBuild(software: Software, spec: ResolvedBuildSpec): Promise<SoftwareBuild> {
		const chosen = await pick(spec);

		if (!chosen) {
			throw new Error(t("core.services.software.noPublishedBuilds", { software }));
		}

		const platform = spec.platform ?? "linux-x64";
		const wanted = assetFor(platform);
		let asset = wanted
			? chosen.release.assets.find((entry) => entry.name === wanted)
			: undefined;

		if (asset && wanted && (await wantsMusl(platform, asset.url))) {
			const musl = chosen.release.assets.find((entry) => entry.name === `${wanted}-musl`);

			if (musl) {
				asset = musl;
			}
		}

		if (!asset) {
			throw new Error(t("core.services.software.noAssetForPlatform", { software, platform }));
		}

		const sha256 = await publishedSha256(chosen.release, asset.name);

		return {
			software,
			mcVersion: chosen.javaVersion,
			buildId: chosen.tag,
			loaderVersion: chosen.tag,
			url: asset.url,
			fileName: asset.name,
			hashes: sha256 ? { sha256 } : {},
			kind: "native",
		};
	},
};
