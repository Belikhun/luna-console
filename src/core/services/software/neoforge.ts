// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * NeoForge maven client.
 *
 * NeoForge versions encode the Minecraft version they target rather than
 * naming it: `21.1.233` is the 233rd build for 1.21.1. That is the whole
 * mapping, and it is why this client can answer a Minecraft version list from
 * a flat list of loader builds.
 *
 * What it serves is an *installer*, not a server jar: the installer writes the
 * library tree and the argument file the server is then launched from.
 */

import type { Software } from "../../types";
import { USER_AGENT } from "../download";
import { compareMcVersionsDesc } from "../../software";
import { t } from "../../../shared/i18n";
import { memoized } from "./resolve";
import type { ResolvedBuildSpec, SoftwareBuild, SoftwareProviderClient } from "./types";

const VERSIONS = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";
const RELEASES = "https://maven.neoforged.net/releases/net/neoforged/neoforge";

/**
 * The Minecraft version a neoforge build targets.
 *
 * The encoding follows whichever version scheme the game was on. Under the
 * historical one, `21.1.233` is the 233rd build for 1.21.1; under the
 * date-based one that arrived with 26.2, `26.1.2.94` is the 94th build for
 * 26.1.2. Either way a trailing zero component is dropped, because Mojang
 * writes the first release of a line as `1.21`, never `1.21.0`.
 */
function mcVersionOf(loaderVersion: string): string | undefined {
	const parts = loaderVersion.split(".");
	const major = Number.parseInt(parts[0] ?? "", 10);

	if (!Number.isFinite(major) || parts.length < 2) {
		return undefined;
	}

	// a leading year means the game version is the first three components; the
	// historical scheme spells the same thing as 1.<minor>.<patch>
	const components = major >= 22
		? parts.slice(0, 3)
		: ["1", parts[0]!, parts[1]!];

	if (components[components.length - 1] === "0") {
		components.pop();
	}

	return components.join(".");
}

/**
 * Every published loader build, newest first. One document answers the MC list,
 * every loader list and the resolve, so it is fetched once rather than per ask.
 */
const allVersions = memoized(async (): Promise<string[]> => {
	const res = await fetch(VERSIONS, { headers: { "User-Agent": USER_AGENT } });

	if (!res.ok) {
		throw new Error(t("core.services.cannotListVersions", { project: "neoforge" }));
	}

	const data: any = await res.json();
	const versions: string[] = data?.versions ?? [];

	// the maven API answers oldest-first, and beta builds are mixed in
	return versions.filter((version) => !version.includes("-beta")).reverse();
});

export const client: SoftwareProviderClient = {
	id: "neoforge",
	async listMcVersions(): Promise<string[]> {
		const mcVersions = new Set<string>();

		for (const version of await allVersions()) {
			const mc = mcVersionOf(version);

			if (mc) {
				mcVersions.add(mc);
			}
		}

		return [...mcVersions].sort(compareMcVersionsDesc);
	},

	async listLoaderVersions(_software: Software, mcVersion?: string): Promise<string[]> {
		const versions = await allVersions();

		if (!mcVersion) {
			return versions;
		}

		return versions.filter((version) => mcVersionOf(version) === mcVersion);
	},

	async resolveBuild(software: Software, spec: ResolvedBuildSpec): Promise<SoftwareBuild> {
		const loader = spec.loaderVersion ?? (await this.listLoaderVersions!(software, spec.mcVersion))[0];

		if (!loader) {
			throw new Error(
				t("core.services.noBuild", { project: "neoforge", version: spec.mcVersion ?? "latest" }),
			);
		}

		const mcVersion = mcVersionOf(loader);

		if (!mcVersion) {
			throw new Error(t("core.services.software.badLoaderVersion", { version: loader }));
		}

		return {
			software,
			mcVersion,
			buildId: loader,
			loaderVersion: loader,
			url: `${RELEASES}/${loader}/neoforge-${loader}-installer.jar`,
			fileName: `neoforge-${loader}-installer.jar`,
			hashes: {},
			kind: "installer",
		};
	},
};
