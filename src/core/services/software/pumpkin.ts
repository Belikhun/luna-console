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
 * Upstream publishes a rolling `nightly` release rather than tagged versions,
 * so its "Minecraft versions" are release tags. That is why the software is
 * marked experimental.
 */

import type { Software } from "../../types";
import { splitPlatform } from "../adoptium";
import { listRepoReleases, type RepoRelease } from "../github";
import { t } from "../../../shared/i18n";
import { memoized } from "./resolve";
import type { ResolvedBuildSpec, SoftwareBuild, SoftwareProviderClient } from "./types";

const REPO = "Pumpkin-MC/Pumpkin";

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
 * Releases, newest first. GitHub's anonymous rate limit is 60 an hour, so the
 * list is fetched once and reused rather than asked for per question.
 */
const releases = memoized(
	// pre-releases are kept because pumpkin publishes nothing else yet, and the
	// shared client is what carries the API token, so this does not spend the
	// anonymous budget the upgrade checker also draws on
	async (): Promise<RepoRelease[]> => await listRepoReleases(REPO, { perPage: 20, prerelease: true }),
);

export const client: SoftwareProviderClient = {
	id: "pumpkin",
	async listMcVersions(): Promise<string[]> {
		return (await releases()).map((release) => release.tag);
	},

	async resolveBuild(software: Software, spec: ResolvedBuildSpec): Promise<SoftwareBuild> {
		const release = (await releases()).find((entry) => entry.tag === spec.mcVersion);

		if (!release) {
			throw new Error(t("core.services.software.noPublishedBuilds", { software }));
		}

		const platform = spec.platform ?? "linux-x64";
		const wanted = assetFor(platform);
		const asset = wanted ? release.assets.find((entry) => entry.name === wanted) : undefined;

		if (!asset) {
			throw new Error(t("core.services.software.noAssetForPlatform", { software, platform }));
		}

		return {
			software,
			mcVersion: release.tag,
			buildId: release.tag,
			url: asset.url,
			fileName: asset.name,
			hashes: {},
			kind: "native",
		};
	},
};
