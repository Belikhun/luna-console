// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { t } from "../../shared/i18n";
import type { AvailableRuntime, RuntimeVendor } from "../types";
import { USER_AGENT } from "./download";

/**
 * Eclipse Temurin builds, through the Adoptium API v3.
 *
 * Adoptium is the catalog luna installs Java from: it publishes a sha256 for
 * every archive, names its releases the way the archives are named, and serves
 * linux-x64 and linux-aarch64 from the same endpoint, which is what a cluster
 * mixing a primary and an arm64 follower needs.
 */

/** API base. Overridable so a test can point at a fake. */
const API = process.env.LUNA_ADOPTIUM_API ?? "https://api.adoptium.net/v3";

/** The only JVM implementation luna asks for; OpenJ9 is a different tuning story. */
const JVM_IMPL = "hotspot";

interface AdoptiumPackage {
	checksum?: string;
	link: string;
	name: string;
	size?: number;
}

interface AdoptiumBinary {
	architecture: string;
	image_type: string;
	os: string;
	package: AdoptiumPackage;
}

interface AdoptiumAsset {
	binary: AdoptiumBinary;
	release_name: string;
}

interface RawReleases {
	available_releases?: number[];
	available_lts_releases?: number[];
	most_recent_lts?: number;
}

/** Feature releases Adoptium currently builds, and which of them are LTS. */
export interface AdoptiumReleases {
	available: number[];
	lts: number[];
	mostRecentLts?: number;
}

/**
 * Split a platform triple into the os and architecture names Adoptium uses.
 * `buildPlatform()` already speaks Adoptium's dialect for the two platforms
 * this cluster runs ("linux-x64", "linux-aarch64"), so the split is the whole
 * translation.
 */
export function splitPlatform(platform: string): { os: string; arch: string } {
	const cut = platform.indexOf("-");

	if (cut < 0) {
		return { os: platform, arch: "x64" };
	}

	return { os: platform.slice(0, cut), arch: platform.slice(cut + 1) };
}

/**
 * The version half of a runtime id, taken from the release name rather than the
 * semver: `jdk-21.0.5+11` and `jdk8u432-b06` are exactly what the archives are
 * called, and matching them keeps an id traceable to a download.
 */
export function versionOfRelease(releaseName: string): string {
	return releaseName.replace(/^jdk-?/, "");
}

/** Feature release of a version string: 21 for "21.0.5+11", 8 for "8u432-b06". */
export function featureOfVersion(version: string): number {
	const legacy = /^(\d+)u\d+/.exec(version);

	if (legacy) {
		return Number.parseInt(legacy[1]!, 10);
	}

	return Number.parseInt(version, 10) || 0;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
	const response = await fetch(`${API}${path}`, {
		headers: { accept: "application/json", "user-agent": USER_AGENT },
		signal,
	});

	if (!response.ok) {
		throw new Error(t("core.services.adoptiumHttp", { status: response.status }));
	}

	return (await response.json()) as T;
}

/** Feature releases Adoptium currently builds, and which of them are LTS. */
export async function availableReleases(signal?: AbortSignal): Promise<AdoptiumReleases> {
	const raw = await get<RawReleases>("/info/available_releases", signal);

	return {
		available: raw.available_releases ?? [],
		lts: raw.available_lts_releases ?? [],
		mostRecentLts: raw.most_recent_lts,
	};
}

/**
 * The newest build of one feature release for one platform. Adoptium answers
 * with a list because a feature release can carry several images; the caller
 * asked for one image type, so at most one entry survives the filter.
 */
export async function latestRuntimes(
	feature: number,
	platform: string,
	vendor: RuntimeVendor,
	signal?: AbortSignal,
): Promise<AvailableRuntime[]> {
	const { os, arch } = splitPlatform(platform);
	const image = vendor === "temurin-jre" ? "jre" : "jdk";
	const query = `os=${os}&architecture=${arch}&image_type=${image}&vendor=eclipse`;
	const assets = await get<AdoptiumAsset[]>(
		`/assets/latest/${feature}/${JVM_IMPL}?${query}`,
		signal,
	);

	const out: AvailableRuntime[] = [];

	for (const asset of assets) {
		const binary = asset.binary;

		if (!binary?.package?.link || binary.image_type !== image) {
			continue;
		}

		// the endpoint is already filtered, but a mismatched build slipping through
		// would install a runtime that cannot run here, so it is checked not trusted
		if (binary.os !== os || binary.architecture !== arch) {
			continue;
		}

		const version = versionOfRelease(asset.release_name);

		out.push({
			id: `${vendor}@${version}`,
			vendor,
			version,
			feature: featureOfVersion(version),
			platform,
			url: binary.package.link,
			sha256: binary.package.checksum,
			size: binary.package.size,
		});
	}

	return out;
}
