/** Modrinth v2 API client. */

const API = "https://api.modrinth.com/v2";
const UA = "belikhun/luna-control";

// Loader families accepted per side. A paper server loads bukkit/spigot/paper plugins.
export const PAPER_LOADERS = ["paper", "spigot", "bukkit", "folia"];
export const VELOCITY_LOADERS = ["velocity"];

/** A 404 is a normal answer here ("unknown to Modrinth"), so it maps to undefined. */
async function api<T>(path: string, init?: RequestInit): Promise<T | undefined> {
	const res = await fetch(API + path, {
		...init,
		headers: {
			"User-Agent": UA,
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

export interface MrVersionFile {
	url: string;
	filename: string;
	primary: boolean;
	hashes: { sha512: string; sha1: string };
	size: number;
}

export type MrChannel = "release" | "beta" | "alpha";

export interface MrVersion {
	id: string;
	project_id: string;
	version_number: string;
	version_type: MrChannel;
	game_versions: string[];
	loaders: string[];
	date_published: string;
	files: MrVersionFile[];
}

export interface MrProject {
	id: string;
	slug: string;
	title: string;
	description: string;
	loaders: string[];
	game_versions: string[];
}

/** Identify a jar by its sha512 hash. Returns undefined if unknown to Modrinth. */
export async function lookupByHash(sha512: string): Promise<MrVersion | undefined> {
	return await api<MrVersion>(`/version_file/${sha512}?algorithm=sha512`);
}

/** Project metadata by id or slug. Undefined when the project does not exist. */
export async function getProject(idOrSlug: string): Promise<MrProject | undefined> {
	return await api<MrProject>(`/project/${encodeURIComponent(idOrSlug)}`);
}

/** Every published version of a project that targets any of `loaders`. */
export async function getVersions(idOrSlug: string, loaders: string[]): Promise<MrVersion[]> {
	const query = encodeURIComponent(JSON.stringify(loaders));
	const path = `/project/${encodeURIComponent(idOrSlug)}/version?loaders=${query}`;

	return (await api<MrVersion[]>(path)) ?? [];
}

export interface MrSearchHit {
	project_id: string;
	slug: string;
	title: string;
	description: string;
	downloads: number;
}

/** Top ten plugin hits for a free-text query, restricted to the given loaders. */
export async function search(query: string, loaders: string[]): Promise<MrSearchHit[]> {
	const facets = encodeURIComponent(
		JSON.stringify([["project_type:plugin"], loaders.map((loader) => `categories:${loader}`)]),
	);

	const res = await api<{ hits: MrSearchHit[] }>(
		`/search?query=${encodeURIComponent(query)}&facets=${facets}&limit=10`,
	);

	return res?.hits ?? [];
}

/** The jar to install for a version — the primary file, or the first one published. */
export function primaryFile(version: MrVersion): MrVersionFile {
	return version.files.find((file) => file.primary) ?? version.files[0]!;
}

const CHANNEL_RANK: Record<MrChannel, number> = { release: 0, beta: 1, alpha: 2 };

export interface PickOptions {
	/** Most unstable channel to accept (default "release") */
	channel?: MrChannel;
	/** Only accept versions published after this date (downgrade guard) */
	afterDate?: string;
}

/**
 * Pick the newest acceptable version whose game_versions cover every required
 * MC version. Channel-gated (no snapshots unless the entry opted in) and
 * downgrade-guarded (never older than what is installed).
 *
 * `newest` is the newest acceptable version regardless of MC coverage, so a
 * caller can explain *why* it is holding an instance back.
 */
export function pickCompatible(
	versions: MrVersion[],
	requiredMc: string[],
	opts: PickOptions = {},
): { best?: MrVersion; newest?: MrVersion } {
	const maxRank = CHANNEL_RANK[opts.channel ?? "release"];
	const after = opts.afterDate ? new Date(opts.afterDate).getTime() : undefined;

	const sorted = [...versions].sort(
		(a, b) => new Date(b.date_published).getTime() - new Date(a.date_published).getTime(),
	);

	const acceptable = sorted.filter((version) => {
		const inChannel = CHANNEL_RANK[version.version_type ?? "release"] <= maxRank;
		const newEnough =
			after === undefined || new Date(version.date_published).getTime() > after;

		return inChannel && newEnough;
	});

	const required = requiredMc.filter(Boolean);
	const best = acceptable.find((version) =>
		required.every((mc) => version.game_versions.includes(mc)),
	);

	return { best, newest: acceptable[0] };
}

/** Download a jar to `dest`, verifying its sha512 when one is known. */
export async function download(
	url: string,
	dest: string,
	expectedSha512?: string,
): Promise<void> {
	const res = await fetch(url, { headers: { "User-Agent": UA } });

	if (!res.ok) {
		throw new Error(`download failed: HTTP ${res.status} for ${url}`);
	}

	const buf = new Uint8Array(await res.arrayBuffer());

	if (expectedSha512) {
		const hasher = new Bun.CryptoHasher("sha512");

		hasher.update(buf);

		if (hasher.digest("hex") !== expectedSha512) {
			throw new Error(`sha512 mismatch for ${url}`);
		}
	}

	await Bun.write(dest, buf);
}

/** sha512 of a file on disk, in the hex form Modrinth uses. */
export async function sha512File(path: string): Promise<string> {
	const buf = new Uint8Array(await Bun.file(path).arrayBuffer());
	const hasher = new Bun.CryptoHasher("sha512");

	hasher.update(buf);

	return hasher.digest("hex");
}
