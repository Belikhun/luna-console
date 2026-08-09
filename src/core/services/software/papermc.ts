// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * PaperMC download API client (Fill v3, falling back to legacy v2). One API
 * serves three of luna's softwares: paper, its regionised sibling folia, and
 * the velocity proxy.
 */

import type { Software } from "../../types";
import { USER_AGENT } from "../download";
import { compareMcVersionsDesc } from "../../software";
import { t } from "../../../shared/i18n";
import type { ResolvedBuildSpec, SoftwareBuild, SoftwareProviderClient } from "./types";

/**
 * Newest build from Fill v3. The download map is keyed by artifact name, and
 * only Paper labels the server jar `server:default`; Velocity's key differs
 * per release, so fall back to whichever artifact comes first.
 */
async function fillLatestBuild(project: string, version: string): Promise<Partial<SoftwareBuild> | undefined> {
	const url = `https://fill.papermc.io/v3/projects/${project}/versions/${version}/builds/latest`;
	const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

	if (!res.ok) {
		return undefined;
	}

	const data: any = await res.json();
	const download = data?.downloads?.["server:default"] ?? Object.values(data?.downloads ?? {})[0] as any;

	if (!download?.url) {
		return undefined;
	}

	return {
		buildId: String(data.id ?? data.build ?? 0),
		url: download.url,
		hashes: { sha256: download.checksums?.sha256 },
		fileName: download.name ?? `${project}-${version}.jar`,
	};
}

/** Newest build from the legacy v2 API, whose build list is oldest-first. */
async function legacyLatestBuild(project: string, version: string): Promise<Partial<SoftwareBuild> | undefined> {
	const base = `https://api.papermc.io/v2/projects/${project}/versions/${version}`;
	const res = await fetch(`${base}/builds`, { headers: { "User-Agent": USER_AGENT } });

	if (!res.ok) {
		return undefined;
	}

	const data: any = await res.json();
	const builds = data?.builds ?? [];
	const latest = builds[builds.length - 1];

	if (!latest) {
		return undefined;
	}

	const file = latest.downloads?.application;

	if (!file) {
		return undefined;
	}

	return {
		buildId: String(latest.build),
		url: `${base}/builds/${latest.build}/downloads/${file.name}`,
		hashes: { sha256: file.sha256 },
		fileName: file.name,
	};
}

/**
 * The java feature release Fill says a version needs, when it says one.
 *
 * PaperMC publishes this per version, which is the only place the requirement
 * is actually stated: velocity 4 needs java 25 while every Minecraft release
 * still runs on 21, so nothing derived from a game version can know it. A
 * missing or unreadable answer is `undefined`, not a guess - the caller falls
 * back to `suggestedFeature`, and a floor invented here would be worse than
 * the inference it replaced.
 */
async function fillJavaMinimum(project: string, version: string): Promise<number | undefined> {
	const url = `https://fill.papermc.io/v3/projects/${project}/versions/${version}`;
	const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });

	if (!res.ok) {
		return undefined;
	}

	const data: any = await res.json();
	const minimum = Number(data?.version?.java?.version?.minimum);

	return Number.isFinite(minimum) && minimum > 0 ? minimum : undefined;
}

/**
 * Every Minecraft version a project publishes builds for. Fill v3 returns
 * either a flat array or a map grouped by major line, depending on the project.
 */
async function listVersions(project: string): Promise<string[]> {
	const res = await fetch(`https://fill.papermc.io/v3/projects/${project}`, {
		headers: { "User-Agent": USER_AGENT },
	});

	if (res.ok) {
		const data: any = await res.json();
		const versions = data?.versions;

		if (Array.isArray(versions)) {
			return versions;
		}

		if (versions && typeof versions === "object") {
			return Object.values(versions).flat() as string[];
		}
	}

	const legacy = await fetch(`https://api.papermc.io/v2/projects/${project}`, {
		headers: { "User-Agent": USER_AGENT },
	});

	if (!legacy.ok) {
		throw new Error(t("core.services.cannotListVersions", { project }));
	}

	const data: any = await legacy.json();

	return data.versions ?? [];
}

export const client: SoftwareProviderClient = {
	id: "papermc",
	async listMcVersions(software: Software): Promise<string[]> {
		// paper, folia and velocity are PaperMC's own project names as well as
		// luna's software ids, so the id is the project
		const versions = await listVersions(software);

		return versions.sort(compareMcVersionsDesc);
	},

	async resolveBuild(software: Software, spec: ResolvedBuildSpec): Promise<SoftwareBuild> {
		const project = software;
		const version = spec.mcVersion;

		// both reads hit the same API, and neither depends on the other
		const [info, javaMinimum] = await Promise.all([
			fillLatestBuild(project, version).then(
				(build) => build ?? legacyLatestBuild(project, version),
			),
			fillJavaMinimum(project, version),
		]);

		if (!info) {
			throw new Error(t("core.services.noBuild", { project, version }));
		}

		return {
			software,
			mcVersion: version,
			buildId: info.buildId!,
			url: info.url!,
			fileName: info.fileName!,
			hashes: info.hashes ?? {},
			kind: "jar",
			...(javaMinimum ? { javaMinimum } : {}),
		};
	},
};
