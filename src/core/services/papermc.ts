/** PaperMC download API client (Fill v3, falling back to legacy v2). */

const UA = "belikhun/luna-control";

export type PaperProject = "paper" | "velocity";

export interface BuildInfo {
	build: number;
	mcVersion: string;
	url: string;
	sha256?: string;
	fileName: string;
}

/**
 * Newest build from Fill v3. The download map is keyed by artifact name, and
 * only Paper labels the server jar `server:default` — Velocity's key differs
 * per release, so fall back to whichever artifact comes first.
 */
async function fillLatestBuild(
	project: PaperProject,
	version: string,
): Promise<BuildInfo | undefined> {
	const url = `https://fill.papermc.io/v3/projects/${project}/versions/${version}/builds/latest`;
	const res = await fetch(url, { headers: { "User-Agent": UA } });

	if (!res.ok) {
		return undefined;
	}

	const data: any = await res.json();
	const download = data?.downloads?.["server:default"] ?? Object.values(data?.downloads ?? {})[0];

	if (!download?.url) {
		return undefined;
	}

	return {
		build: data.id ?? data.build ?? 0,
		mcVersion: version,
		url: download.url,
		sha256: download.checksums?.sha256,
		fileName: download.name ?? `${project}-${version}.jar`,
	};
}

/** Newest build from the legacy v2 API, whose build list is oldest-first. */
async function legacyLatestBuild(
	project: PaperProject,
	version: string,
): Promise<BuildInfo | undefined> {
	const base = `https://api.papermc.io/v2/projects/${project}/versions/${version}`;
	const res = await fetch(`${base}/builds`, { headers: { "User-Agent": UA } });

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
		build: latest.build,
		mcVersion: version,
		url: `${base}/builds/${latest.build}/downloads/${file.name}`,
		sha256: file.sha256,
		fileName: file.name,
	};
}

/** Newest build of a project for one Minecraft version. Throws when there is none. */
export async function latestBuild(project: PaperProject, version: string): Promise<BuildInfo> {
	const info =
		(await fillLatestBuild(project, version)) ?? (await legacyLatestBuild(project, version));

	if (!info) {
		throw new Error(`no ${project} build found for version ${version}`);
	}

	return info;
}

/**
 * Every Minecraft version a project publishes builds for. Fill v3 returns either
 * a flat array or a map grouped by major line, depending on the project.
 */
export async function listVersions(project: PaperProject): Promise<string[]> {
	const res = await fetch(`https://fill.papermc.io/v3/projects/${project}`, {
		headers: { "User-Agent": UA },
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
		headers: { "User-Agent": UA },
	});

	if (!legacy.ok) {
		throw new Error(`cannot list ${project} versions`);
	}

	const data: any = await legacy.json();

	return data.versions ?? [];
}

/** Bytes received so far, and the total when the server sent a content-length. */
export type DownloadProgress = (received: number, total?: number) => void;

/**
 * Download a build to `dest`, verifying its sha256 when the API published one.
 * The body is consumed chunk by chunk so `onProgress` can report a server jar
 * arriving — it is the slowest step of creating an instance by far.
 */
export async function downloadBuild(
	info: BuildInfo,
	dest: string,
	onProgress?: DownloadProgress,
): Promise<void> {
	const res = await fetch(info.url, { headers: { "User-Agent": UA } });

	if (!res.ok) {
		throw new Error(`download failed: HTTP ${res.status} for ${info.url}`);
	}

	const length = Number(res.headers.get("content-length") ?? 0);
	const total = length > 0 ? length : undefined;
	const hasher = info.sha256 ? new Bun.CryptoHasher("sha256") : undefined;
	const chunks: Uint8Array[] = [];
	let received = 0;

	for await (const chunk of res.body as ReadableStream<Uint8Array>) {
		chunks.push(chunk);
		hasher?.update(chunk);
		received += chunk.byteLength;

		onProgress?.(received, total);
	}

	if (hasher && hasher.digest("hex") !== info.sha256) {
		throw new Error("sha256 mismatch on downloaded server jar");
	}

	const buf = new Uint8Array(received);
	let offset = 0;

	for (const chunk of chunks) {
		buf.set(chunk, offset);
		offset += chunk.byteLength;
	}

	await Bun.write(dest, buf);
}
