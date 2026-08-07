// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * MohistMC API client, serving the youer hybrids.
 *
 * Youer is a NeoForge server that also implements the Paper API, so it runs
 * bukkit plugins and neoforge mods side by side; the build a version resolves
 * to names the neoforge it bundles, which is what the instance records as its
 * loader version.
 *
 * AsyncYouer is published through the same API but has no builds yet: the
 * project answers an empty version list rather than an error, and that is
 * reported as "nothing published" rather than as a failure, because it is the
 * upstream's state and not a fault of the request.
 */

import type { Software } from "../../types";
import { USER_AGENT } from "../download";
import { compareMcVersionsDesc } from "../../software";
import { t } from "../../../shared/i18n";
import type { ResolvedBuildSpec, SoftwareBuild, SoftwareProviderClient } from "./types";

const API = "https://api.mohistmc.com";

/** Upstream project names; luna's software ids happen to match them. */
const PROJECTS: Partial<Record<Software, string>> = {
	youer: "youer",
	asyncyouer: "asyncyouer",
};

function projectOf(software: Software): string {
	const project = PROJECTS[software];

	if (!project) {
		throw new Error(t("core.services.software.notServed", { software, provider: "mohist" }));
	}

	return project;
}

/** GET an endpoint as JSON, or undefined when the project has nothing there. */
async function get(path: string): Promise<any | undefined> {
	const res = await fetch(`${API}${path}`, { headers: { "User-Agent": USER_AGENT } });

	if (!res.ok) {
		return undefined;
	}

	return await res.json();
}

export const client: SoftwareProviderClient = {
	id: "mohist",
	async listMcVersions(software: Software): Promise<string[]> {
		const data = await get(`/project/${projectOf(software)}/versions`);

		if (!Array.isArray(data)) {
			return [];
		}

		return data
			.map((entry: any) => String(entry?.name))
			.filter((name) => name && name !== "undefined")
			.sort(compareMcVersionsDesc);
	},

	async resolveBuild(software: Software, spec: ResolvedBuildSpec): Promise<SoftwareBuild> {
		const project = projectOf(software);
		const version = spec.mcVersion;
		const build = await get(`/project/${project}/${version}/builds/latest`);

		if (!build?.id) {
			throw new Error(t("core.services.software.noPublishedBuilds", { software }));
		}

		const loaderVersion = build.loader?.neoforge_version ?? build.loader?.forge_version;

		return {
			software,
			mcVersion: version,
			buildId: String(build.id),
			...(loaderVersion ? { loaderVersion: String(loaderVersion) } : {}),
			url: `${API}/project/${project}/${version}/builds/${build.id}/download`,
			fileName: `${project}-${version}-${build.id}.jar`,
			hashes: build.file_sha256 ? { sha256: String(build.file_sha256) } : {},
			kind: "jar",
		};
	},
};
