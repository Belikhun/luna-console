/**
 * Smithed API client (api.smithed.dev/v2), as an addon provider. Smithed is a
 * data-pack platform: data packs only (a version may bundle a companion
 * resource pack, which luna ignores here). Public reads need no key.
 *
 * Quirks the mapping absorbs:
 * - versions carry no publish dates and no hashes; names are enforced semver,
 *   so ordering is a semver compare and the normalized `date_published` is a
 *   synthetic monotonic stamp (epoch + rank) that keeps `pickCompatible`'s
 *   sorting and the downgrade guard working
 * - `supports` lists exact MC version strings of mixed granularity ("1.19",
 *   "1.21.4"); `coversMc`'s prefix rule is what makes "1.19" match 1.19.2
 * - every pack has two ids: an immutable docId (the RemoteRef's projectId)
 *   and a rename-able slug (rawId, for the web URL)
 * - download URLs point at author-hosted zips (GitHub releases etc.), so a
 *   download follows redirects and verifies nothing but its own sha512
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

const API = "https://api.smithed.dev/v2";

async function api<T>(path: string): Promise<T | undefined> {
	const res = await fetch(API + path, {
		headers: { "User-Agent": USER_AGENT },
	});

	if (res.status === 404) {
		return undefined;
	}

	if (!res.ok) {
		const body = (await res.text()).slice(0, 200);

		throw new Error(`smithed ${path}: HTTP ${res.status} ${body}`);
	}

	return (await res.json()) as T;
}

interface SmVersion {
	name: string;
	supports?: string[];
	downloads?: { datapack?: string; resourcepack?: string };
}

interface SmPack {
	/** In the full pack body this is the *slug* (rawId), not the docId */
	id: string;
	display?: { name?: string; description?: string; icon?: string };
	versions?: SmVersion[];
}

interface SmMeta {
	docId: string;
	rawId: string;
	stats?: { downloads?: { total?: number } };
}

interface SmSearchEntry {
	id: string;
	displayName: string;
	data?: { display?: { description?: string; icon?: string } };
	meta?: { stats?: { downloads?: { total?: number } } };
}

async function search(query: string): Promise<AddonSearchHit[]> {
	const params = new URLSearchParams({ search: query, limit: "10" });

	// scopes pull display + stats into the list response; no per-hit fetches
	params.append("scope", "data.display");
	params.append("scope", "meta.stats");

	const res = (await api<SmSearchEntry[]>(`/packs?${params}`)) ?? [];

	return res.map((entry) => ({
		// the list's id is the docId; the slug is only known after getProject
		project_id: entry.id,
		slug: entry.id,
		title: entry.displayName,
		description: entry.data?.display?.description ?? "",
		downloads: entry.meta?.stats?.downloads?.total ?? 0,
		icon_url: entry.data?.display?.icon,
	}));
}

async function getProject(idOrSlug: string): Promise<AddonProject | undefined> {
	const [pack, meta] = await Promise.all([
		api<SmPack>(`/packs/${encodeURIComponent(idOrSlug)}`),
		api<SmMeta>(`/packs/${encodeURIComponent(idOrSlug)}/meta`),
	]);

	if (!pack || !meta) {
		return undefined;
	}

	return {
		id: meta.docId,
		slug: meta.rawId,
		title: pack.display?.name ?? meta.rawId,
		description: pack.display?.description ?? "",
		loaders: ["datapack"],
		game_versions: [...new Set((pack.versions ?? []).flatMap((version) => version.supports ?? []))],
	};
}

/** Semver-ish compare on version names, the ordering Smithed itself uses. */
function compareVersions(a: string, b: string): number {
	const parse = (name: string): { nums: number[]; pre: string } => {
		const match = name.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+](.*))?/);

		return {
			nums: [Number(match?.[1] ?? 0), Number(match?.[2] ?? 0), Number(match?.[3] ?? 0)],
			pre: match?.[4] ?? "",
		};
	};

	const left = parse(a);
	const right = parse(b);

	for (let index = 0; index < 3; index += 1) {
		if (left.nums[index]! !== right.nums[index]!) {
			return left.nums[index]! - right.nums[index]!;
		}
	}

	// a prerelease sorts below its release; two prereleases compare as strings
	if (!left.pre !== !right.pre) {
		return left.pre ? -1 : 1;
	}

	return left.pre.localeCompare(right.pre);
}

async function getVersions(ref: RemoteRef): Promise<AddonVersion[]> {
	const pack = await api<SmPack>(`/packs/${encodeURIComponent(ref.projectId)}`);
	const versions = (pack?.versions ?? []).filter((version) => version.downloads?.datapack);

	versions.sort((a, b) => compareVersions(a.name, b.name));

	return versions.map((version, rank) => ({
		id: version.name,
		project_id: ref.projectId,
		version_number: version.name,
		// smithed has no channels; a semver prerelease suffix is the one honest signal
		version_type: /[-+]/.test(version.name) ? ("beta" as const) : ("release" as const),
		game_versions: version.supports ?? [],
		loaders: ["datapack"],
		// no publish dates upstream; a synthetic monotonic stamp in semver order
		// keeps sorting and the downgrade guard consistent
		date_published: new Date((rank + 1) * 86_400_000).toISOString(),
		files: [
			{
				url: version.downloads!.datapack!,
				filename: `${ref.slug}-${version.name}.zip`,
				primary: true,
				hashes: {},
				size: 0,
			},
		],
	}));
}

export const client: ProviderClient = {
	id: "smithed",
	label: "Smithed",
	types: ["datapack"],

	status: () => ({ available: true }),

	search: async (query, _type, _loaders) => await search(query),

	getProject: async (idOrSlug) => await getProject(idOrSlug),

	getVersions: async (ref, _type, _loaders) => await getVersions(ref),

	projectUrl: (ref) => `https://smithed.net/packs/${ref.slug}`,

	versionUrl: (ref) => `https://smithed.net/packs/${ref.slug}`,
};
