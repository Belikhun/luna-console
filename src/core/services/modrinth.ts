// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Modrinth v2 API client, as an addon provider (services/providers.ts). Its
 * wire shapes are what the normalized types were modelled on, so the mapping
 * here is mostly a pass-through. Also home of the sha512 hash lookup `scan`
 * identifies pool jars with; the one capability no other provider has.
 */

import type { RemoteRef } from "../types";
import { USER_AGENT } from "./download";
import type {
	AddonProject,
	AddonSearchHit,
	AddonType,
	AddonVersion,
	ProviderClient,
} from "./providers";

const API = "https://api.modrinth.com/v2";

/** A 404 is a normal answer here ("unknown to Modrinth"), so it maps to undefined. */
async function api<T>(path: string, init?: RequestInit): Promise<T | undefined> {
	const res = await fetch(API + path, {
		...init,
		headers: {
			"User-Agent": USER_AGENT,
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});

	if (res.status === 404) {
		return undefined;
	}

	if (!res.ok) {
		const body = (await res.text()).slice(0, 200);

		throw new Error(`modrinth ${path}: HTTP ${res.status} ${body}`);
	}

	return (await res.json()) as T;
}

/** Identify a jar by its sha512 hash. Returns undefined if unknown to Modrinth. */
export async function lookupByHash(sha512: string): Promise<AddonVersion | undefined> {
	return await api<AddonVersion>(`/version_file/${sha512}?algorithm=sha512`);
}

/** Project metadata by id or slug. Undefined when the project does not exist. */
export async function getProject(idOrSlug: string): Promise<AddonProject | undefined> {
	return await api<AddonProject>(`/project/${encodeURIComponent(idOrSlug)}`);
}

/** Every published version of a project that targets any of `loaders`. */
export async function getVersions(idOrSlug: string, loaders: string[]): Promise<AddonVersion[]> {
	const query = encodeURIComponent(JSON.stringify(loaders));
	const path = `/project/${encodeURIComponent(idOrSlug)}/version?loaders=${query}`;

	return (await api<AddonVersion[]>(path)) ?? [];
}

/**
 * The search facets selecting one project type. Data packs are the odd one
 * out: Modrinth stores them as *mods* carrying the "datapack" loader, and the
 * search index answers `project_type:datapack` for exactly those; pairing it
 * with `project_type:mod` (which is what the hits report themselves as) is an
 * empty intersection, so the pseudo type has to stand alone.
 *
 * `mod` and `plugin` are separate project types upstream, so a mod search must
 * not fall through to the plugin facet: "create" is a mod and would never
 * appear under `project_type:plugin` no matter which loader is asked for.
 */
function typeFacets(type: AddonType, loaders: string[]): string[][] {
	if (type === "datapack") {
		return [["project_type:datapack"]];
	}

	if (type === "resourcepack") {
		return [["project_type:resourcepack"]];
	}

	if (type === "mod") {
		return [["project_type:mod"], loaders.map((loader) => `categories:${loader}`)];
	}

	return [["project_type:plugin"], loaders.map((loader) => `categories:${loader}`)];
}

/** Top ten hits of one project type for a free-text query. */
async function search(
	query: string,
	type: AddonType,
	loaders: string[],
): Promise<AddonSearchHit[]> {
	const facets = encodeURIComponent(JSON.stringify(typeFacets(type, loaders)));

	const res = await api<{ hits: AddonSearchHit[] }>(
		`/search?query=${encodeURIComponent(query)}&facets=${facets}&limit=10`,
	);

	return res?.hits ?? [];
}

/** Modrinth's own URL segment for a project type. */
function typePath(type: AddonType): string {
	return type;
}

export const client: ProviderClient = {
	id: "modrinth",
	label: "Modrinth",
	types: ["plugin", "mod", "resourcepack", "datapack"],

	status: () => ({ available: true }),

	search,

	getProject: async (idOrSlug) => await getProject(idOrSlug),

	getVersions: async (ref: RemoteRef, _type, loaders) =>
		await getVersions(ref.projectId, loaders),

	projectUrl: (ref, type) => `https://modrinth.com/${typePath(type)}/${ref.slug}`,

	versionUrl: (ref, type, version) =>
		`https://modrinth.com/${typePath(type)}/${ref.slug}/version/${encodeURIComponent(version.version_number)}`,
};
