/**
 * Hangar API client (hangar.papermc.io/api/v1), as an addon provider. Hangar
 * is PaperMC's own plugin repository: plugins only, published per platform
 * (PAPER / VELOCITY / WATERFALL). Public reads need no key.
 *
 * Quirks the mapping absorbs:
 * - release channels are free-form per project; an `UNSTABLE`/`HIDE_BY_DEFAULT`
 *   flag marks the honest ones, name heuristics catch the rest
 * - a version's download is per platform, and may be *external* (a bare link
 *   to a releases page, no file, no hash); those versions are skipped
 * - hashes are sha256 only; the lockfile sha512 is computed on download
 * - the numeric project id is immutable while slugs can be renamed, so the id
 *   is what the RemoteRef stores; owner + slug are kept for the web URL
 */

import type { RemoteRef } from "../types";
import { USER_AGENT } from "./download";
import type {
	AddonProject,
	AddonSearchHit,
	AddonType,
	AddonVersion,
	ProviderClient,
	ReleaseChannel,
} from "./providers";

const API = "https://hangar.papermc.io/api/v1";

async function api<T>(path: string): Promise<T | undefined> {
	const res = await fetch(API + path, {
		headers: { "User-Agent": USER_AGENT },
	});

	if (res.status === 404) {
		return undefined;
	}

	if (!res.ok) {
		const body = (await res.text()).slice(0, 200);

		throw new Error(`hangar ${path}: HTTP ${res.status} ${body}`);
	}

	return (await res.json()) as T;
}

type HangarPlatform = "PAPER" | "VELOCITY";

/** The Hangar platform the requested loader facets select. */
function platformFor(loaders: string[]): HangarPlatform {
	return loaders.includes("velocity") ? "VELOCITY" : "PAPER";
}

interface HgProject {
	id: number;
	name: string;
	namespace: { owner: string; slug: string };
	description?: string;
	avatarUrl?: string;
	stats?: { downloads?: number };
}

interface HgVersion {
	id: number;
	name: string;
	createdAt: string;
	channel?: { name?: string; flags?: string[] };
	downloads?: Record<
		string,
		{
			fileInfo?: { name: string; sizeBytes: number; sha256Hash?: string } | null;
			downloadUrl?: string | null;
			externalUrl?: string | null;
		}
	>;
	platformDependencies?: Record<string, string[]>;
}

function toHit(project: HgProject): AddonSearchHit {
	return {
		project_id: String(project.id),
		slug: project.namespace.slug,
		title: project.name,
		description: project.description ?? "",
		downloads: project.stats?.downloads ?? 0,
		author: project.namespace.owner,
		icon_url: project.avatarUrl,
		owner: project.namespace.owner,
	};
}

function toProject(project: HgProject): AddonProject {
	return {
		id: String(project.id),
		slug: project.namespace.slug,
		title: project.name,
		description: project.description ?? "",
		loaders: [],
		game_versions: [],
		owner: project.namespace.owner,
	};
}

async function search(
	query: string,
	_type: AddonType,
	loaders: string[],
): Promise<AddonSearchHit[]> {
	const params = new URLSearchParams({
		query,
		platform: platformFor(loaders),
		limit: "10",
		offset: "0",
	});

	const res = await api<{ result: HgProject[] }>(`/projects?${params}`);

	return (res?.result ?? []).map(toHit);
}

async function getProject(idOrSlug: string): Promise<AddonProject | undefined> {
	const res = await api<HgProject>(`/projects/${encodeURIComponent(idOrSlug)}`);

	return res ? toProject(res) : undefined;
}

/**
 * The release channel a Hangar channel maps to. Channel names are the
 * author's own, so the author-set flags come first and well-known names catch
 * the rest; an unrecognized custom channel counts as the project's main line.
 */
function channelOf(channel: HgVersion["channel"]): ReleaseChannel {
	const flags = channel?.flags ?? [];
	const name = (channel?.name ?? "").toLowerCase();

	if (flags.includes("UNSTABLE") || flags.includes("HIDE_BY_DEFAULT")) {
		return "alpha";
	}

	if (/alpha|snapshot|dev|nightly|experiment/.test(name)) {
		return "alpha";
	}

	if (/beta|rc|pre/.test(name)) {
		return "beta";
	}

	return "release";
}

async function getVersions(
	ref: RemoteRef,
	_type: AddonType,
	loaders: string[],
): Promise<AddonVersion[]> {
	const platform = platformFor(loaders);
	const versions: HgVersion[] = [];

	// two pages of the newest versions is plenty for resolution and pinning
	for (const offset of [0, 25]) {
		const params = new URLSearchParams({
			platform,
			limit: "25",
			offset: String(offset),
		});

		const res = await api<{ result: HgVersion[] }>(
			`/projects/${encodeURIComponent(ref.projectId)}/versions?${params}`,
		);

		const page = res?.result ?? [];

		versions.push(...page);

		if (page.length < 25) {
			break;
		}
	}

	const mapped: AddonVersion[] = [];

	for (const version of versions) {
		const download = version.downloads?.[platform];

		// external-only versions have no file and no hash; nothing to install
		if (!download?.downloadUrl || !download.fileInfo) {
			continue;
		}

		mapped.push({
			id: String(version.id),
			project_id: ref.projectId,
			version_number: version.name,
			version_type: channelOf(version.channel),
			game_versions: version.platformDependencies?.[platform] ?? [],
			loaders: [platform === "VELOCITY" ? "velocity" : "paper"],
			date_published: version.createdAt,
			files: [
				{
					url: download.downloadUrl,
					filename: download.fileInfo.name,
					primary: true,
					hashes: download.fileInfo.sha256Hash
						? { sha256: download.fileInfo.sha256Hash }
						: {},
					size: download.fileInfo.sizeBytes,
				},
			],
		});
	}

	return mapped;
}

/** Owner + slug when both are known; the API accepts the bare id everywhere else. */
function webPath(ref: RemoteRef): string {
	return ref.owner ? `${ref.owner}/${ref.slug}` : ref.slug;
}

export const client: ProviderClient = {
	id: "hangar",
	label: "Hangar",
	types: ["plugin"],

	status: () => ({ available: true }),

	search,

	getProject: async (idOrSlug) => await getProject(idOrSlug),

	getVersions,

	projectUrl: (ref) => `https://hangar.papermc.io/${webPath(ref)}`,

	versionUrl: (ref, _type, version) =>
		`https://hangar.papermc.io/${webPath(ref)}/versions/${encodeURIComponent(version.version_number)}`,
};
