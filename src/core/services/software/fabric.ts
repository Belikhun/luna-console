// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Fabric meta API client.
 *
 * Fabric has no installer step on a server: its meta service builds a
 * self-contained launcher jar for a (game, loader, installer) triple and serves
 * it directly, so a fabric instance is as simple to provision as a paper one.
 * Nothing upstream publishes a hash for that jar, because it is assembled per
 * request; `downloadToFile` still records the sha512 of what arrived.
 */

import type { Software } from "../../types";
import { USER_AGENT } from "../download";
import { compareMcVersionsDesc } from "../../software";
import { t } from "../../../shared/i18n";
import { memoized } from "./resolve";
import type { ResolvedBuildSpec, SoftwareBuild, SoftwareProviderClient } from "./types";

const META = "https://meta.fabricmc.net/v2";

/** GET a meta endpoint as JSON. */
async function get(path: string): Promise<any> {
	const res = await fetch(`${META}${path}`, { headers: { "User-Agent": USER_AGENT } });

	if (!res.ok) {
		throw new Error(t("core.services.cannotListVersions", { project: "fabric" }));
	}

	return await res.json();
}

/** The installer list is one small document that changes a few times a year. */
const installerVersions = memoized(async (): Promise<any[]> => await get("/versions/installer"));

/** Newest stable entry of a meta list, falling back to newest of any kind. */
function newestStable(entries: any[], versionOf: (entry: any) => string): string | undefined {
	const stable = entries.find((entry) => entry?.stable === true);

	return versionOf(stable ?? entries[0]);
}

export const client: SoftwareProviderClient = {
	id: "fabric",
	async listMcVersions(): Promise<string[]> {
		const games: any[] = await get("/versions/game");

		return games
			.filter((game) => game?.stable === true)
			.map((game) => String(game.version))
			.sort(compareMcVersionsDesc);
	},

	async listLoaderVersions(_software: Software, mcVersion?: string): Promise<string[]> {
		if (!mcVersion) {
			const loaders: any[] = await get("/versions/loader");

			return loaders.map((entry) => String(entry.version));
		}

		const loaders: any[] = await get(`/versions/loader/${mcVersion}`);

		return loaders.map((entry) => String(entry?.loader?.version));
	},

	async resolveBuild(software: Software, spec: ResolvedBuildSpec): Promise<SoftwareBuild> {
		const version = spec.mcVersion;

		// the installer list is independent of the loader list, and a pinned
		// loader needs no loader list at all
		const [loaders, installers] = await Promise.all([
			spec.loaderVersion ? Promise.resolve([]) : get(`/versions/loader/${version}`),
			installerVersions(),
		]);

		const loader = spec.loaderVersion ?? newestStable(loaders, (entry) => entry?.loader?.version);
		const installer = newestStable(installers, (entry) => entry?.version);

		if (!loader || !installer) {
			throw new Error(t("core.services.noBuild", { project: "fabric", version }));
		}

		return {
			software,
			mcVersion: version,
			buildId: loader,
			loaderVersion: loader,
			url: `${META}/versions/loader/${version}/${loader}/${installer}/server/jar`,
			fileName: `fabric-server-${version}-${loader}.jar`,
			hashes: {},
			kind: "jar",
		};
	},
};
