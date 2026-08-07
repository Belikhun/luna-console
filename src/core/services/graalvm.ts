// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import type { AvailableRuntime } from "../types";
import { fetchDigest, listRepoReleases, type ReleaseAsset } from "./github";

/**
 * GraalVM Community builds, from their own GitHub releases.
 *
 * There is no catalog API: the releases are the catalog, and the archive name
 * is the only thing that reliably carries both the version and the platform
 * (tags have drifted between `jdk-25.0.2` and `graal-25.2.4` for the same
 * build). So the asset name is what gets parsed, and anything not shaped like a
 * GA build is skipped.
 */

/** Repository publishing the community builds. */
export const GRAAL_REPO = process.env.LUNA_GRAALVM_REPO ?? "graalvm/graalvm-ce-builds";

/** How many releases back the catalog looks; each feature line releases often. */
const LOOKBACK = 60;

/**
 * `graalvm-community-jdk-25.0.2_linux-x64_bin.tar.gz`. The version group stays
 * greedy-free so an interim build (`25i2-25.0.4`) is captured whole and then
 * rejected by the GA test below, rather than silently truncated to a version
 * that does not exist.
 */
const ASSET = /^graalvm-community-jdk-(.+)_([a-z]+)-([a-z0-9_]+)_bin\.tar\.gz$/;

/** A published version luna offers: dotted numbers only, no interim streams. */
const GA_VERSION = /^\d+(?:\.\d+)*$/;

/** Feature release of a GraalVM version: 21 for "21.0.2". */
function featureOf(version: string): number {
	return Number.parseInt(version, 10) || 0;
}

/**
 * Every GraalVM Community runtime published for one platform, newest release
 * first. The sha256 lives in a sidecar file rather than the release metadata,
 * so only its URL is carried here; reading one costs a request per row, which
 * is a bill the catalog should not pay before somebody picks a version.
 */
export async function listGraalRuntimes(
	platform: string,
	signal?: AbortSignal,
): Promise<AvailableRuntime[]> {
	const releases = await listRepoReleases(GRAAL_REPO, { perPage: LOOKBACK, signal });
	const out: AvailableRuntime[] = [];
	const seen = new Set<string>();

	for (const release of releases) {
		for (const asset of release.assets) {
			const match = ASSET.exec(asset.name);

			if (!match) {
				continue;
			}

			const version = match[1]!;

			if (!GA_VERSION.test(version) || `${match[2]}-${match[3]}` !== platform) {
				continue;
			}

			const id = `graalvm-ce@${version}`;

			// the same build is re-published under more than one tag; first wins,
			// and the listing is newest first
			if (seen.has(id)) {
				continue;
			}

			seen.add(id);

			const digest = release.assets.find((entry) => entry.name === `${asset.name}.sha256`);

			out.push({
				id,
				vendor: "graalvm-ce",
				version,
				feature: featureOf(version),
				platform,
				url: asset.url,
				digestUrl: digest?.url,
				size: asset.size,
			});
		}
	}

	return out;
}

/** Read a runtime's sha256 sidecar, at install time. */
export async function graalDigest(
	runtime: AvailableRuntime,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (!runtime.digestUrl) {
		return undefined;
	}

	const asset: ReleaseAsset = { name: `${runtime.id}.sha256`, url: runtime.digestUrl, size: 64 };

	return await fetchDigest(asset, signal);
}
