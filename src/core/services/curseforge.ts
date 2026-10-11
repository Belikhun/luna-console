// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * CurseForge API client (api.curseforge.com), as an addon provider. Serves
 * mods, Bukkit plugins, resource packs and data packs; each a "class" of the
 * Minecraft game upstream. The official API wants a key (console.curseforge.com,
 * injected as `curseforgeApiKey` in the daemon config or `LUNA_CURSEFORGE_KEY`);
 * without one the client falls back to cfwidget.com, a keyless mirror of
 * public project pages. That mirror has no search, so a keyless search only
 * finds a project named exactly (slug, id or curseforge.com URL), and it
 * carries no download URLs or hashes, so files come from the CDN path the
 * file id implies and arrive unverified, as Smithed's do.
 *
 * Quirks the mapping absorbs:
 * - a file's `gameVersions` mixes MC versions with loader tags ("Fabric",
 *   "Bukkit") and environment tags ("Client"); real MC versions come from
 *   `sortableGameVersions` entries whose `gameVersion` field is non-empty
 * - hashes are sha1/md5 only; the lockfile sha512 is computed on download
 * - `downloadUrl` is null when the author opted out of API distribution;
 *   those files are skipped rather than reconstructed from the CDN scheme
 * - files carry no clean version number; one is extracted from the display
 *   name, falling back to the file name
 */

import type { RemoteRef } from "../types";
import { t } from "../../shared/i18n";
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
const CFWIDGET = "https://api.cfwidget.com";
const GAME_ID = 432;

/** CurseForge class ids of the addon types luna installs. */
const CLASS_IDS: Record<AddonType, number> = {
	mod: 6,
	plugin: 5,
	resourcepack: 12,
	datapack: 6945,
	// listed so the record stays total; the client never serves this type, and
	// a CurseForge pack has no server-side format to install from anyway
	modpack: 4471,
};

/** URL path segment of each class on curseforge.com. */
const CLASS_PATHS: Record<AddonType, string> = {
	mod: "mc-mods",
	plugin: "bukkit-plugins",
	resourcepack: "texture-packs",
	datapack: "data-packs",
	modpack: "modpacks",
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
		throw new Error(t("core.services.curseforgeNoKey"));
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

/** The one mod loader the requested facets filter on, if any. */
function requestedLoader(type: AddonType, loaders: string[]): string | undefined {
	if (type !== "mod") {
		return undefined;
	}

	return loaders.find((loader) => MOD_LOADER_TYPES[loader] !== undefined);
}

/** The one modLoaderType filter the requested loader facets imply, if any. */
function loaderFilter(type: AddonType, loaders: string[]): number | undefined {
	const loader = requestedLoader(type, loaders);

	return loader === undefined
		? undefined
		: MOD_LOADER_TYPES[loader];
}

/** Velocity plugins do not exist on CurseForge; fail with the reason, not silence. */
function rejectVelocity(type: AddonType, loaders: string[]): void {
	if (type === "plugin" && loaders.includes("velocity")) {
		throw new Error(t("core.services.curseforgeNoVelocity"));
	}
}

async function apiSearch(
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

async function apiGetProject(idOrSlug: string, type: AddonType): Promise<AddonProject | undefined> {
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

async function apiGetVersions(
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
				// null when the author opted out of API distribution; nothing to install
				!!file.downloadUrl,
		)
		.map((file) => toVersion(ref, type, file));
}


interface WidgetFile {
	id: number;
	display: string;
	name: string;
	type: string;
	filesize: number;
	/** MC versions mixed with loader and environment tags, as on the site */
	versions?: string[];
	uploaded_at: string;
}

interface WidgetProject {
	id: number;
	title: string;
	summary: string;
	thumbnail?: string;
	downloads?: { total?: number };
	members?: Array<{ username: string }>;
	urls?: { curseforge?: string };
	files?: WidgetFile[];
}

const WIDGET_RELEASE_TYPES: Record<string, number> = { release: 1, beta: 2, alpha: 3 };

/** Same cap the official path reaches with its two pages of files. */
const WIDGET_FILE_LIMIT = 100;

async function widget(path: string): Promise<WidgetProject | undefined> {
	const res = await fetch(CFWIDGET + path, {
		headers: { "User-Agent": USER_AGENT },
	});

	if (res.status === 404) {
		return undefined;
	}

	// cfwidget answers 202 for a project it has not mirrored yet and fetches it in the background
	if (res.status === 202) {
		throw new Error(t("core.services.cfwidgetQueued"));
	}

	if (!res.ok) {
		const body = (await res.text()).slice(0, 200);

		throw new Error(`cfwidget ${path}: HTTP ${res.status} ${body}`);
	}

	return (await res.json()) as WidgetProject;
}

/** The project's slug, read off its canonical URL (the path asked for may be an old alias). */
function widgetSlug(project: WidgetProject): string {
	const url = project.urls?.curseforge ?? "";
	const segment = url.split("/").filter(Boolean).pop();

	return segment ?? String(project.id);
}

/** The cfwidget path for an id, a slug in the type's class, or a curseforge.com URL. */
function widgetPath(idOrSlug: string, type: AddonType): string {
	const trimmed = idOrSlug.trim();

	if (/^\d+$/.test(trimmed)) {
		return `/${trimmed}`;
	}

	const fromUrl = trimmed.match(/curseforge\.com\/minecraft\/([\w-]+)\/([\w-]+)/i);

	if (fromUrl) {
		return `/minecraft/${fromUrl[1]}/${fromUrl[2]}`;
	}

	const slug = trimmed
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

	return `/minecraft/${CLASS_PATHS[type]}/${encodeURIComponent(slug)}`;
}

/** Where the CDN keeps a file: its id split into thousands, no zero padding. */
function cdnUrl(file: WidgetFile): string {
	const head = Math.floor(file.id / 1000);
	const tail = file.id % 1000;

	return `https://mediafilez.forgecdn.net/files/${head}/${tail}/${encodeURIComponent(file.name)}`;
}

/** A mirrored file in the official API's shape, so one mapping serves both paths. */
function widgetFileAsCf(file: WidgetFile): CfFile {
	const tags = file.versions ?? [];

	return {
		id: file.id,
		displayName: file.display,
		fileName: file.name,
		releaseType: WIDGET_RELEASE_TYPES[file.type] ?? 1,
		fileDate: file.uploaded_at,
		fileLength: file.filesize,
		downloadUrl: cdnUrl(file),
		gameVersions: tags,
		sortableGameVersions: tags
			.filter((tag) => /^\d+(?:\.\d+)+$/.test(tag))
			.map((gameVersion) => ({ gameVersion })),
	};
}

async function widgetSearch(
	query: string,
	type: AddonType,
	loaders: string[],
): Promise<AddonSearchHit[]> {
	rejectVelocity(type, loaders);

	if (!query.trim()) {
		return [];
	}

	const project = await widget(widgetPath(query, type));

	if (!project) {
		return [];
	}

	return [
		{
			project_id: String(project.id),
			slug: widgetSlug(project),
			title: project.title,
			description: project.summary,
			downloads: project.downloads?.total ?? 0,
			author: project.members?.[0]?.username,
			icon_url: project.thumbnail,
		},
	];
}

async function widgetGetProject(idOrSlug: string, type: AddonType): Promise<AddonProject | undefined> {
	const project = await widget(widgetPath(idOrSlug, type));

	if (!project) {
		return undefined;
	}

	return {
		id: String(project.id),
		slug: widgetSlug(project),
		title: project.title,
		description: project.summary,
		loaders: [],
		game_versions: [],
	};
}

async function widgetGetVersions(
	ref: RemoteRef,
	type: AddonType,
	loaders: string[],
): Promise<AddonVersion[]> {
	rejectVelocity(type, loaders);

	const project = await widget(`/${ref.projectId}`);
	const loader = requestedLoader(type, loaders);

	const files = (project?.files ?? [])
		.filter((file) => {
			if (loader === undefined) {
				return true;
			}

			return (file.versions ?? []).some((tag) => tag.toLowerCase() === loader);
		})
		.sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at))
		.slice(0, WIDGET_FILE_LIMIT);

	return files.map((file) => toVersion(ref, type, widgetFileAsCf(file)));
}

export const client: ProviderClient = {
	id: "curseforge",
	label: "CurseForge",
	types: ["plugin", "mod", "resourcepack", "datapack"],

	status: () =>
		apiKey
			? { available: true }
			: {
					available: true,
					reason: t("core.services.curseforgeKeyHint"),
				},

	search: (query, type, loaders) =>
		apiKey
			? apiSearch(query, type, loaders)
			: widgetSearch(query, type, loaders),

	getProject: (idOrSlug, type) =>
		apiKey
			? apiGetProject(idOrSlug, type)
			: widgetGetProject(idOrSlug, type),

	getVersions: (ref, type, loaders) =>
		apiKey
			? apiGetVersions(ref, type, loaders)
			: widgetGetVersions(ref, type, loaders),

	projectUrl: (ref, type) =>
		`https://www.curseforge.com/minecraft/${CLASS_PATHS[type]}/${ref.slug}`,

	versionUrl: (ref, type, version) =>
		`https://www.curseforge.com/minecraft/${CLASS_PATHS[type]}/${ref.slug}/files/${version.id}`,
};
