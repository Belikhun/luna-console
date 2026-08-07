// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * PurpurMC download API client. Purpur is a paper fork, so its instances are
 * paper-shaped in every way except where the jar comes from; the API answers a
 * flat version list and a build list per version, with an md5 per build.
 */

import type { Software } from "../../types";
import { USER_AGENT } from "../download";
import { compareMcVersionsDesc } from "../../software";
import { t } from "../../../shared/i18n";
import type { ResolvedBuildSpec, SoftwareBuild, SoftwareProviderClient } from "./types";

const API = "https://api.purpurmc.org/v2/purpur";

/** GET a purpur endpoint as JSON, or undefined when it answers anything else. */
async function get(path: string): Promise<any | undefined> {
	const res = await fetch(`${API}${path}`, { headers: { "User-Agent": USER_AGENT } });

	if (!res.ok) {
		return undefined;
	}

	return await res.json();
}

export const client: SoftwareProviderClient = {
	id: "purpur",
	async listMcVersions(): Promise<string[]> {
		const data = await get("");

		if (!Array.isArray(data?.versions)) {
			throw new Error(t("core.services.cannotListVersions", { project: "purpur" }));
		}

		return (data.versions as string[]).sort(compareMcVersionsDesc);
	},

	async resolveBuild(software: Software, spec: ResolvedBuildSpec): Promise<SoftwareBuild> {
		const version = spec.mcVersion;

		// the build list names its own newest, which is what "latest" resolves to
		const builds = await get(`/${version}`);
		const build = builds?.builds?.latest;

		if (!build) {
			throw new Error(t("core.services.noBuild", { project: "purpur", version }));
		}

		// the per-build document is where the hash lives; the list carries none
		const detail = await get(`/${version}/${build}`);

		return {
			software,
			mcVersion: version,
			buildId: String(build),
			url: `${API}/${version}/${build}/download`,
			fileName: `purpur-${version}-${build}.jar`,
			hashes: detail?.md5 ? { md5: detail.md5 } : {},
			kind: "jar",
		};
	},
};
