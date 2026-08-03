/**
 * CurseForge API client (api.curseforge.com), as an addon provider. Serves
 * mods, Bukkit plugins, resource packs and data packs — each a "class" of the
 * Minecraft game upstream. Requires an API key (console.curseforge.com), so
 * the provider reports itself unavailable until the daemon injects one
 * (`curseforgeApiKey` in the daemon config, or `LUNA_CURSEFORGE_KEY`).
 *
 * Quirks the mapping absorbs:
 * - a file's `gameVersions` mixes MC versions with loader tags ("Fabric",
 *   "Bukkit") and environment tags ("Client") — real MC versions come from
 *   `sortableGameVersions` entries whose `gameVersion` field is non-empty
 * - hashes are sha1/md5 only; the lockfile sha512 is computed on download
 * - `downloadUrl` is null when the author opted out of API distribution;
 *   those files are skipped rather than reconstructed from the CDN scheme
 * - files carry no clean version number — one is extracted from the display
 *   name, falling back to the file name
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

const API = "https://api.curseforge.com/v1";
const GAME_ID = 432;

/** CurseForge class ids of the addon types luna installs. */
const CLASS_IDS: Record<AddonType, number> = {
	mod: 6,
	plugin: 5,
	resourcepack: 12,
	datapack: 6945,
};

/** URL path segment of each class on curseforge.com. */
const CLASS_PATHS: Record<AddonType, string> = {
	mod: "mc-mods",
	plugin: "bukkit-plugins",
	resourcepack: "texture-packs",
	datapack: "data-packs",
};

/** ModLoaderType enum values for the loaders luna cares about. */
const MOD_LOADER_TYPES: Record<string, number> = {
	forge: 1,
	fabric: 4,
	quilt: 5,
	neoforge: 6,
};

let apiKey: string | undefined;

/** Inject the API key (daemon startup); undefined marks the provider unavailable. */
export function setApiKey(key?: string): void {
	apiKey = key?.trim() || undefined;
}

async function api<T>(path: string): Promise<T | undefined> {
	if (!apiKey) {
		throw new Error("CurseForge API key not configured");
	}

	const res = await fetch(API + path, {
		headers: {
			"User-Agent": USER_AGENT,
			"x-api-key": apiKey,
		},
	});

	if (res.status === 404) {
		return undefined;
	}

	if (!res.ok) {
		const body = (await res.text()).slice(0, 200);

		throw new Error(`curseforge ${path}: HTTP ${res.status} ${body}`);
	}

	return (await res.json()) as T;
}

interface CfAuthor {
	name: string;
}

interface CfMod {
	id: number;
	slug: string;
	name: string;
	summary: string;
	downloadCount: number;
	authors?: CfAuthor[];
	logo?: { thumbnailUrl?: string };
	categories?: Array<{ slug?: string }>;
}

interface CfSortableGameVersion {
	gameVersion: string;
}

interface CfFile {
	id: number;
	displayName: string;
	fileName: string;
	/** 1=release 2=beta 3=alpha */
	releaseType: number;
	fileDate: string;
	fileLength: number;
	downloadUrl?: string | null;
	isAvailable?: boolean;
	exposeAsAlternative?: boolean | null;
	gameVersions?: string[];
	sortableGameVersions?: CfSortableGameVersion[];
	hashes?: Array<{ value: string; algo: number }>;
}

function toHit(mod: CfMod): AddonSearchHit {
	return {
		project_id: String(mod.id),
		slug: mod.slug,
		title: mod.name,
		description: mod.summary,
		downloads: mod.downloadCount,
		author: mod.authors?.[0]?.name,
		icon_url: mod.logo?.thumbnailUrl,
	};
}

function toProject(mod: CfMod): AddonProject {
	return {
		id: String(mod.id),
		slug: mod.slug,
		title: mod.name,
		description: mod.summary,
		loaders: [],
		game_versions: [],
	};
}

/** The one modLoaderType filter the requested loader facets imply, if any. */
function loaderFilter(type: AddonType, loaders: string[]): number | undefined {
	if (type !== "mod") {
		return undefined;
	}

	for (const loader of loaders) {
		const mapped = MOD_LOADER_TYPES[loader];

		if (mapped !== undefined) {
			return mapped;
		}
	}

	return undefined;
}

/** Velocity plugins do not exist on CurseForge — fail with the reason, not silence. */
function rejectVelocity(type: AddonType, loaders: string[]): void {
	if (type === "plugin" && loaders.includes("velocity")) {
		throw new Error("CurseForge hosts Bukkit/Paper plugins only — no velocity builds");
	}
}

async function search(
	query: string,
	type: AddonType,
	loaders: string[],
): Promise<AddonSearchHit[]> {
	rejectVelocity(type, loaders);

	const params = new URLSearchParams({
		gameId: String(GAME_ID),
		classId: String(CLASS_IDS[type]),
		searchFilter: query,
		sortField: "2", // popularity
		sortOrder: "desc",
		pageSize: "10",
	});

	const modLoader = loaderFilter(type, loaders);

	if (modLoader !== undefined) {
		params.set("modLoaderType", String(modLoader));
	}

	const res = await api<{ data: CfMod[] }>(`/mods/search?${params}`);

	return (res?.data ?? []).map(toHit);
}

async function getProject(idOrSlug: string, type: AddonType): Promise<AddonProject | undefined> {
	if (/^\d+$/.test(idOrSlug)) {
		const res = await api<{ data: CfMod }>(`/mods/${idOrSlug}`);

		return res ? toProject(res.data) : undefined;
	}

	// slugs are only unique within a class, so the lookup is a filtered search
	const params = new URLSearchParams({
		gameId: String(GAME_ID),
		classId: String(CLASS_IDS[type]),
		slug: idOrSlug,
	});

	const res = await api<{ data: CfMod[] }>(`/mods/search?${params}`);
	const mod = res?.data.find((candidate) => candidate.slug === idOrSlug) ?? res?.data[0];

	return mod ? toProject(mod) : undefined;
}

const RELEASE_TYPES: Record<number, ReleaseChannel> = { 1: "release", 2: "beta", 3: "alpha" };

/** Loader tags a file's gameVersions may carry, in luna's facet vocabulary. */
const LOADER_TAGS: Record<string, string> = {
	bukkit: "bukkit",
	paper: "paper",
	spigot: "spigot",
	folia: "folia",
	forge: "forge",
	fabric: "fabric",
	quilt: "quilt",
	neoforge: "neoforge",
};

/** A version number extracted from the display name, else the bare file name. */
function versionNumberOf(file: CfFile): string {
	const fromDisplay = file.displayName.match(/\d+(?:\.\d+)+(?:[-+][\w.]+)*/);

	if (fromDisplay) {
		return fromDisplay[0];
	}

	return file.fileName.replace(/\.(jar|zip)$/i, "") || file.displayName;
}

function toVersion(ref: RemoteRef, type: AddonType, file: CfFile): AddonVersion {
	const gameVersions = [
		...new Set(
			(file.sortableGameVersions ?? [])
				.map((entry) => entry.gameVersion)
				.filter((version) => version !== ""),
		),
	];

	const loaders = (file.gameVersions ?? [])
		.map((tag) => LOADER_TAGS[tag.toLowerCase()])
		.filter((tag): tag is string => tag !== undefined);

	if (!loaders.length) {
		loaders.push(type === "mod" ? "neoforge" : type === "plugin" ? "paper" : type);
	}

	const sha1 = file.hashes?.find((hash) => hash.algo === 1)?.value;

	return {
		id: String(file.id),
		project_id: ref.projectId,
		version_number: versionNumberOf(file),
		version_type: RELEASE_TYPES[file.releaseType] ?? "release",
		game_versions: gameVersions,
		loaders,
		date_published: file.fileDate,
		files: [
			{
				url: file.downloadUrl!,
				filename: file.fileName,
				primary: true,
				hashes: sha1 ? { sha1 } : {},
				size: file.fileLength,
			},
		],
	};
}

async function getVersions(
	ref: RemoteRef,
	type: AddonType,
	loaders: string[],
): Promise<AddonVersion[]> {
	rejectVelocity(type, loaders);

	const files: CfFile[] = [];
	const modLoader = loaderFilter(type, loaders);

	// two pages of the newest files is plenty for resolution and pinning
	for (const index of [0, 50]) {
		const params = new URLSearchParams({ index: String(index), pageSize: "50" });

		if (modLoader !== undefined) {
			params.set("modLoaderType", String(modLoader));
		}

		const res = await api<{ data: CfFile[] }>(`/mods/${ref.projectId}/files?${params}`);
		const page = res?.data ?? [];

		files.push(...page);

		if (page.length < 50) {
			break;
		}
	}

	return files
		.filter(
			(file) =>
				file.isAvailable !== false &&
				file.exposeAsAlternative !== true &&
				// null when the author opted out of API distribution — nothing to install
				!!file.downloadUrl,
		)
		.map((file) => toVersion(ref, type, file));
}

export const client: ProviderClient = {
	id: "curseforge",
	label: "CurseForge",
	types: ["plugin", "mod", "resourcepack", "datapack"],

	status: () =>
		apiKey
			? { available: true }
			: {
					available: false,
					reason: "needs an API key — set LUNA_CURSEFORGE_KEY or curseforgeApiKey in the daemon config",
				},

	search,
	getProject,
	getVersions,

	projectUrl: (ref, type) =>
		`https://www.curseforge.com/minecraft/${CLASS_PATHS[type]}/${ref.slug}`,

	versionUrl: (ref, type, version) =>
		`https://www.curseforge.com/minecraft/${CLASS_PATHS[type]}/${ref.slug}/files/${version.id}`,
};
