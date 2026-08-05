// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Mapping an addon luna already has to the project it came from; the operation
 * that turns a hand-uploaded or adopted file into a provider-managed one, so
 * update checks, channels and the downgrade guard start applying to it.
 *
 * The hard part is not writing `remote` into a lockfile: it is knowing *which
 * published version the local file is*. Get that wrong and the first update
 * either re-downloads a build the server already runs or, worse, compares
 * against a version the operator never had and calls a downgrade an upgrade.
 * So a mapping is only ever as strong as its evidence, and this module grades it:
 *
 *   exact    the provider published a hash and the local file matches it, so
 *            the version is a fact rather than a claim
 *   likely   the file name or the byte size matches exactly one version; the
 *            usual case for CurseForge and Smithed, which publish weak hashes
 *            or none at all
 *   unknown  nothing matched. The mapping is still worth making (the project is
 *            the project), but the *version* stays blank, and every downstream
 *            check then treats the next compatible release as an update.
 *
 * `unknown` is deliberately not an error: an operator who knows a jar is Axiom
 * should be able to say so even when the jar was repackaged, and luna is better
 * off with a project it can check than with a file nobody can ever update.
 */

import type { AddonType, AddonProject, AddonVersion, ReleaseChannel } from "./services/providers";
import { getProject, getVersions, primaryFile, remoteRefFor } from "./services/providers";
import { hashesOfFile } from "./services/download";
import type { ProviderId, RemoteRef } from "./types";
import { t } from "../shared/i18n";

/** How a local file was tied to a published version, strongest first. */
export type MatchBasis = "sha512" | "sha256" | "sha1" | "filename" | "size";

/** Bases that prove identity outright, in the order they are trusted. */
const HASH_BASES = ["sha512", "sha256", "sha1"] as const;

/** What luna knows about the file sitting in its own pool. */
export interface LocalFile {
	/** Name in the pool / packs directory */
	file: string;
	sizeBytes: number;
	sha512: string;
	sha256: string;
	sha1: string;
}

/** One published version a local file might be. */
export interface IdentityMatch {
	versionId: string;
	versionNumber: string;
	/** Channel the provider published it on; a mapping adopts this */
	channel: ReleaseChannel;
	publishedAt: string;
	gameVersions?: string[];
	/** File name the provider publishes, for the operator to recognise */
	fileName: string;
	sizeBytes: number;
	/** What tied the local file to this version */
	basis: MatchBasis;
	/** A published hash matched: the version is proven, not guessed */
	exact: boolean;
}

/** How much a probe managed to prove. */
export type IdentityConfidence = "exact" | "likely" | "unknown";

/** Everything the operator needs to decide a mapping, gathered in one call. */
export interface IdentityProbe {
	provider: ProviderId;
	project: AddonProject;
	remote: RemoteRef;
	/** The file being identified */
	local: LocalFile;
	confidence: IdentityConfidence;
	/** The one version luna would record; absent when nothing matched */
	best?: IdentityMatch;
	/** Every match found, best first; an ambiguous size match lists them all */
	matches: IdentityMatch[];
	/** The project's newest version on the release channel, matched or not:
	 *  what an unidentified mapping would pull on its first update */
	newest?: IdentityMatch;
	/** Versions the provider published at all, for a manual pick */
	versions: IdentityMatch[];
}

/** Hashes + size of a file luna holds, in the shape the matcher compares. */
export async function localFile(path: string, name: string): Promise<LocalFile> {
	const size = Bun.file(path).size;
	const hashes = await hashesOfFile(path);

	return { file: name, sizeBytes: size, ...hashes };
}

/** Flatten one published version into the match shape, on a stated basis. */
function asMatch(version: AddonVersion, basis: MatchBasis, exact: boolean): IdentityMatch {
	const file = primaryFile(version);

	return {
		versionId: version.id,
		versionNumber: version.version_number,
		channel: version.version_type ?? "release",
		publishedAt: version.date_published,
		gameVersions: version.game_versions,
		fileName: file.filename,
		sizeBytes: file.size,
		basis,
		exact,
	};
}

/**
 * Which versions the local file could be, best first.
 *
 * A hash match ends the search; there is nothing stronger to find, and a second
 * version with the same bytes is the same build re-tagged. Without one, name and
 * size are reported as what they are: candidates. Size is only offered when it
 * picks out a single version, because "some jar of exactly this length" is not
 * evidence when three versions share it.
 */
export function matchVersions(versions: AddonVersion[], local: LocalFile): IdentityMatch[] {
	for (const basis of HASH_BASES) {
		const hit = versions.find((version) =>
			version.files.some((file) => {
				const published = file.hashes[basis];

				return published !== undefined && published.toLowerCase() === local[basis];
			}),
		);

		if (hit) {
			return [asMatch(hit, basis, true)];
		}
	}

	const wanted = local.file.toLowerCase();
	const byName = versions.filter((version) =>
		version.files.some((file) => file.filename.toLowerCase() === wanted),
	);

	if (byName.length) {
		return byName.map((version) => asMatch(version, "filename", false));
	}

	const bySize = versions.filter((version) =>
		version.files.some((file) => file.size === local.sizeBytes),
	);

	// several versions of the same length prove nothing about which one this is
	if (bySize.length === 1) {
		return [asMatch(bySize[0]!, "size", false)];
	}

	return [];
}

/**
 * Look a project up at its provider and grade what the local file could be.
 *
 * `type` and `loaders` are the addon's own kind (a paper plugin must not match a
 * fabric build of the same project), so the version list is already filtered to
 * builds that could actually be the file in hand.
 */
export async function probeIdentity(
	provider: ProviderId,
	project: string,
	type: AddonType,
	local: LocalFile,
	loaders?: string[],
): Promise<IdentityProbe> {
	const found = await getProject(provider, project, type);

	if (!found) {
		throw new Error(t("core.identify.noProject", { provider, type, project }));
	}

	const remote = remoteRefFor(provider, found);
	const versions = await getVersions(remote, type, loaders);
	const matches = matchVersions(versions, local);
	const best = matches[0];

	const confidence: IdentityConfidence = !best ? "unknown" : best.exact ? "exact" : "likely";

	// newest release-channel build: what an unidentified mapping would land on
	const release = versions.find((version) => (version.version_type ?? "release") === "release");

	return {
		provider,
		project: found,
		remote,
		local,
		confidence,
		best,
		matches,
		newest: release ? asMatch(release, "filename", false) : undefined,
		versions: versions.map((version) => asMatch(version, "filename", false)),
	};
}

/** What a mapping records about the version it settled on. */
export interface IdentityInstall {
	versionId?: string;
	versionNumber?: string;
	sha512: string;
	gameVersions?: string[];
	publishedAt?: string;
}

/** The version a mapping is being asked to record. */
export interface IdentityChoice {
	/** Version to record; omitted takes the probe's best match */
	versionId?: string;
	/** Record the project but no version, whatever the probe found */
	unidentified?: boolean;
}

/**
 * The match a mapping should write, given the operator's choice.
 *
 * A named version wins outright; the operator looked at the list. Otherwise
 * the probe's own best match stands, and `unidentified` throws all of it away
 * on purpose.
 */
export function chosenMatch(
	probe: IdentityProbe,
	choice: IdentityChoice = {},
): IdentityMatch | undefined {
	if (choice.unidentified) {
		return undefined;
	}

	if (choice.versionId) {
		const named = probe.versions.find((version) => version.versionId === choice.versionId);

		if (!named) {
			throw new Error(t("core.identify.noVersion", { slug: probe.project.slug, version: choice.versionId }));
		}

		return named;
	}

	return probe.best;
}

/**
 * The `installed` block for a mapping: the local sha512 always (it is what luna
 * has, whatever the provider says), plus the identity of the matched version
 * when there is one.
 */
export function installedFrom(local: LocalFile, match: IdentityMatch | undefined): IdentityInstall {
	if (!match) {
		return { sha512: local.sha512 };
	}

	return {
		versionId: match.versionId,
		versionNumber: match.versionNumber,
		sha512: local.sha512,
		gameVersions: match.gameVersions,
		publishedAt: match.publishedAt,
	};
}

/**
 * Whether a mapping should turn auto-update on by itself.
 *
 * Only a proven version earns it: with an exact match the next check compares
 * against a real build and the downgrade guard has a real date. A guess or a
 * blank leaves the switch off, because the first "update" would be luna acting
 * on a version the operator only suspects they have.
 */
export function autoUpdateDefault(match: IdentityMatch | undefined): boolean {
	return match?.exact === true;
}
