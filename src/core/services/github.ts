// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { t } from "../../shared/i18n";

/**
 * GitHub Releases client; the fallback source for a daemon binary.
 *
 * A daemon prefers the primary's own binary (DESIGN.md §4.7): in a development
 * cluster that is the build somebody just made, and going through GitHub for it
 * would mean tagging a release to test a one-line change. GitHub is what answers
 * when no primary can serve one; a fresh follower on a machine that has never
 * seen a build, or a primary upgrading itself.
 */

/** API base. Overridable for GitHub Enterprise, and for testing the fallback. */
const API = process.env.LUNA_GITHUB_API ?? "https://api.github.com";
const UA = "belikhun/luna-console";

/** Repository the releases come from. */
export const RELEASE_REPO = process.env.LUNA_RELEASE_REPO ?? "Belikhun/luna-console";

/** Asset naming the release workflow produces, one per platform triple. */
export function assetName(platform: string): string {
	return `luna-${platform}`;
}

export interface ReleaseAsset {
	name: string;
	url: string;
	size: number;
}

export interface ReleaseInfo {
	/** Release version without the tag's leading "v", e.g. "1.0.1" */
	version: string;
	tag: string;
	/** The release page, for the console to link to */
	pageUrl: string;
	publishedAt: string;
	prerelease: boolean;
	notes: string;
	/** The binary for the platform asked for, when the release carries one */
	asset: ReleaseAsset | null;
	/** Its `<asset>.sha256` sidecar, when published */
	digest: ReleaseAsset | null;
}

interface GhAsset {
	name: string;
	browser_download_url: string;
	size: number;
}

interface GhRelease {
	tag_name: string;
	name: string | null;
	html_url: string;
	body: string | null;
	draft: boolean;
	prerelease: boolean;
	published_at: string;
	assets: GhAsset[];
}

/**
 * Request headers. An unauthenticated caller gets 60 requests an hour per IP,
 * which is plenty for a cached check; `LUNA_GITHUB_TOKEN` is for private repos
 * and for CI, not for the rate limit.
 */
function headers(accept: string): Record<string, string> {
	const result: Record<string, string> = {
		accept,
		"user-agent": UA,
		"x-github-api-version": "2022-11-28",
	};

	if (process.env.LUNA_GITHUB_TOKEN) {
		result.authorization = `Bearer ${process.env.LUNA_GITHUB_TOKEN}`;
	}

	return result;
}

function toRelease(raw: GhRelease, platform: string): ReleaseInfo {
	const wanted = assetName(platform);

	return {
		version: raw.tag_name.replace(/^v/, ""),
		tag: raw.tag_name,
		pageUrl: raw.html_url,
		publishedAt: raw.published_at,
		prerelease: raw.prerelease,
		notes: raw.body ?? "",
		asset: pickAsset(raw.assets, wanted),
		digest: pickAsset(raw.assets, `${wanted}.sha256`),
	};
}

function pickAsset(assets: GhAsset[], name: string): ReleaseAsset | null {
	const found = assets.find((asset) => asset.name === name);

	if (!found) {
		return null;
	}

	return { name: found.name, url: found.browser_download_url, size: found.size };
}

/**
 * The newest release carrying a binary for `platform`, or null when the repo
 * has none. Pre-releases are skipped unless `prerelease` is set; the daemon
 * that asks for them is one an operator deliberately put on that channel.
 *
 * The listing endpoint is used rather than `/releases/latest` so a repo whose
 * newest release predates this platform's assets still resolves.
 */
export async function latestRelease(
	platform: string,
	opts: { repo?: string; prerelease?: boolean; signal?: AbortSignal } = {},
): Promise<ReleaseInfo | null> {
	const repo = opts.repo ?? RELEASE_REPO;
	const response = await fetch(`${API}/repos/${repo}/releases?per_page=20`, {
		headers: headers("application/vnd.github+json"),
		signal: opts.signal,
	});

	if (response.status === 404) {
		throw new Error(t("core.services.noRepo", { repo }));
	}

	if (!response.ok) {
		throw new Error(t("core.services.githubHttp", { status: response.status }));
	}

	const releases = (await response.json()) as GhRelease[];

	for (const raw of releases) {
		if (raw.draft) {
			continue;
		}

		if (raw.prerelease && !opts.prerelease) {
			continue;
		}

		const release = toRelease(raw, platform);

		if (release.asset) {
			return release;
		}
	}

	return null;
}

/**
 * Read a `.sha256` sidecar asset. The format is `sha256sum`'s own -
 * `<hex>  <filename>`; so only the first field is taken.
 */
export async function fetchDigest(asset: ReleaseAsset, signal?: AbortSignal): Promise<string> {
	const response = await fetch(asset.url, {
		headers: headers("application/octet-stream"),
		signal,
	});

	if (!response.ok) {
		throw new Error(t("core.services.githubDigestHttp", { name: asset.name, status: response.status }));
	}

	const text = (await response.text()).trim();
	const hex = text.split(/\s+/)[0] ?? "";

	if (!/^[0-9a-f]{64}$/.test(hex)) {
		throw new Error(t("core.services.githubDigestBad", { name: asset.name }));
	}

	return hex;
}

/**
 * Compare two release versions ("1.2.3", "1.2.3-rc.1", "1.0.0+abc1234"; the
 * build metadata after "+" is ignored, as semver requires). Returns > 0 when
 * `a` is newer, 0 when they are the same release, < 0 when `a` is older.
 *
 * A pre-release sorts below the release it leads to, so 1.1.0-rc.1 < 1.1.0.
 */
export function compareVersions(a: string, b: string): number {
	const parse = (
		value: string,
	): { nums: number[]; pre: string } => {
		const [core = "", pre = ""] = value.split("+")[0]!.split("-", 2);
		const nums = core.split(".").map((part) => Number.parseInt(part, 10) || 0);

		while (nums.length < 3) {
			nums.push(0);
		}

		return { nums, pre };
	};

	const left = parse(a);
	const right = parse(b);

	for (let i = 0; i < 3; i += 1) {
		const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);

		if (diff !== 0) {
			return diff;
		}
	}

	if (left.pre === right.pre) {
		return 0;
	}

	// no pre-release beats any pre-release of the same core version
	if (!left.pre) {
		return 1;
	}

	if (!right.pre) {
		return -1;
	}

	return left.pre < right.pre ? -1 : 1;
}
