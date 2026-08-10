// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * MinecraftForge client.
 *
 * Forge publishes two things: `promotions_slim.json`, which names the latest
 * and recommended build per Minecraft version, and a maven metadata document
 * listing every build ever released. The promotions file is what a version pick
 * should follow, because "latest" there means "latest Forge chose to promote";
 * the maven list is the full catalog behind it.
 *
 * A forge version is `<mc>-<forge>`, e.g. `1.21.1-52.0.20`, and what is served
 * is an *installer*: it writes the library tree and the argument file the
 * server is then launched from. Only 1.17 and up work that way, which is the
 * cutoff this client enforces; older releases were a runnable jar with a
 * completely different layout.
 */

import type { Software } from "../../types";
import { USER_AGENT } from "../download";
import { compareMcVersionsDesc, mcVersionParts } from "../../software";
import { t } from "../../../shared/i18n";
import { memoized } from "./resolve";
import type { ResolvedBuildSpec, SoftwareBuild, SoftwareProviderClient } from "./types";

const PROMOTIONS = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const MAVEN = "https://maven.minecraftforge.net/net/minecraftforge/forge";

/** Oldest Minecraft version whose forge installs the way luna launches it. */
const OLDEST_SUPPORTED = "1.17";

/**
 * Oldest Minecraft version of the legacy era luna will provision.
 *
 * Forge published back to 1.1, but the ports below this are their own projects: 1.7.x
 * needs UniMixins rather than MixinBooter, and luna has no mod built for any of them.
 * Serving a version nothing can run on is worse than refusing it.
 */
const OLDEST_LEGACY = "1.12";

/** Whether a Minecraft version's forge uses the installer + argument file layout. */
function isSupportedMcVersion(mcVersion: string): boolean {
	const parts = mcVersionParts(mcVersion);

	// the date-based scheme is newer than anything that predates the installer
	if ((parts[0] ?? 0) !== 1) {
		return true;
	}

	return (parts[1] ?? 0) >= 17;
}

/**
 * Whether a Minecraft version belongs to the legacy line luna builds mods for.
 *
 * Deliberately the 1.12 line alone rather than everything `isSupportedMcVersion`
 * rejects. The two predicates are not complements: 1.13-1.16 are neither the modern
 * layout nor a line luna has a mod for, so both clients refuse them.
 */
function isLegacyMcVersion(mcVersion: string): boolean {
	const parts = mcVersionParts(mcVersion);

	return (parts[0] ?? 0) === 1 && (parts[1] ?? 0) === 12;
}

/** Promoted builds, keyed `<mc>-latest` / `<mc>-recommended`. */
const promotions = memoized(async (): Promise<Record<string, string>> => {
	const res = await fetch(PROMOTIONS, { headers: { "User-Agent": USER_AGENT } });

	if (!res.ok) {
		throw new Error(t("core.services.cannotListVersions", { project: "forge" }));
	}

	const data: any = await res.json();

	return data?.promos ?? {};
});

/**
 * Every `<mc>-<forge>` version maven holds. Parsed with a regex rather than an
 * XML library: the document is a flat list of `<version>` elements and pulling
 * in a parser for it would be the only XML in the codebase.
 */
const mavenVersions = memoized(async (): Promise<string[]> => {
	const res = await fetch(`${MAVEN}/maven-metadata.xml`, { headers: { "User-Agent": USER_AGENT } });

	if (!res.ok) {
		throw new Error(t("core.services.cannotListVersions", { project: "forge" }));
	}

	const xml = await res.text();

	return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]!);
});

/** Split `1.21.1-52.0.20` into its two halves. */
function splitVersion(version: string): { mcVersion: string; loaderVersion: string } | undefined {
	const at = version.indexOf("-");

	if (at < 0) {
		return undefined;
	}

	return { mcVersion: version.slice(0, at), loaderVersion: version.slice(at + 1) };
}

/**
 * Whether luna will provision this version at all: the modern installer layout,
 * or the 1.12 line the legacy trunk builds for. The gap between them (1.13-1.16)
 * is neither, and refusing it beats serving a version nothing can run on.
 */
function serves(mcVersion: string): boolean {
	return isSupportedMcVersion(mcVersion) || isLegacyMcVersion(mcVersion);
}

/**
 * Forge's publishing has not changed in fifteen years - the same promotions file, the
 * same maven layout, the same installer URL - so both launcher eras share one client.
 * What differs once installed is what the installer left behind for the launch to
 * use, and that lives in the traits table (`isLegacyForge`), not here.
 */
export const client: SoftwareProviderClient = {
	id: "forge",
	async listMcVersions(): Promise<string[]> {
		const promos = await promotions();
		const mcVersions = new Set<string>();

		for (const key of Object.keys(promos)) {
			const mcVersion = key.replace(/-(latest|recommended)$/, "");

			if (mcVersion !== key && serves(mcVersion)) {
				mcVersions.add(mcVersion);
			}
		}

		return [...mcVersions].sort(compareMcVersionsDesc);
	},

	async listLoaderVersions(_software: Software, mcVersion?: string): Promise<string[]> {
		const versions = await mavenVersions();
		const out: string[] = [];

		for (const version of versions) {
			const split = splitVersion(version);

			if (!split) {
				continue;
			}

			if (mcVersion && split.mcVersion !== mcVersion) {
				continue;
			}

			out.push(split.loaderVersion);
		}

		// maven answers oldest-first
		return out.reverse();
	},

	async resolveBuild(software: Software, spec: ResolvedBuildSpec): Promise<SoftwareBuild> {
		const mcVersion = spec.mcVersion;

		if (!serves(mcVersion)) {
			throw new Error(
				t("core.services.software.forgeUnserved", {
					version: mcVersion,
					oldest: OLDEST_SUPPORTED,
					legacy: OLDEST_LEGACY,
				}),
			);
		}

		let loader = spec.loaderVersion;

		if (!loader) {
			// what forge itself promotes for this version, recommended before latest
			const promos = await promotions();

			loader = promos[`${mcVersion}-recommended`] ?? promos[`${mcVersion}-latest`];
		}

		// a version forge never promoted still has builds; the catalog has them
		if (!loader) {
			loader = (await this.listLoaderVersions!(software, mcVersion))[0];
		}

		if (!loader) {
			throw new Error(t("core.services.noBuild", { project: "forge", version: mcVersion }));
		}

		const full = `${mcVersion}-${loader}`;

		return {
			software,
			mcVersion,
			buildId: loader,
			loaderVersion: loader,
			url: `${MAVEN}/${full}/forge-${full}-installer.jar`,
			fileName: `forge-${full}-installer.jar`,
			hashes: {},
			kind: "installer",
		};
	},
};
