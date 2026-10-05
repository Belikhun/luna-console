// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Modpacks: provisioning an instance from a Modrinth `.mrpack`, and moving it
 * to another version of the same pack.
 *
 * A modpack is a provisioning source, not an addon. The pack decides the
 * loader, the Minecraft version and the loader build, so `installModpack` reads
 * those out of the index and hands them to `createInstance`, which does what it
 * does for any server; the pack's own files (its `mods/`, its configs, its
 * `overrides/`) are then laid over the result. They are *not* pooled: they
 * belong to the pack, they change with it, and the addon machinery already
 * leaves jars it does not manage alone. What luna adds on top (the forwarding
 * mod, group-targeted jars) still comes through the pool, which is why a caller
 * finishes with the same deploy step a plain create runs.
 *
 * Only Modrinth is a provider. Its format is a specification (an index naming
 * every file with its hashes and download URLs, plus `overrides/`), while a
 * CurseForge pack has no server-side format to read. Every file a pack names is
 * fetched from the hosts the specification allows and checked against the
 * hashes the index carries, and every path is confined to the instance
 * directory, because a pack author chose both.
 *
 * The files a pack wrote are listed in `.luna-modpack.json` inside the
 * instance. An update reads that list to remove what the new version no longer
 * ships, and nothing else, so a jar an operator dropped in by hand survives.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import { createInstance, setVersion } from "./admin";
import { unzipRead } from "./archive";
import { instanceDir, managedInstances, stagingDir } from "./config";
import { getStatus } from "./instances";
import { assertPublic } from "./jarinstall";
import { releaseInstancePorts } from "./ports";
import { ProgressReporter } from "./progress";
import { downloadToFile } from "./services/download";
import type { KnownHashes } from "./services/download";
import { coversMc, getProject, getVersions, primaryFile, remoteRefFor, searchProvider } from "./services/providers";
import type { AddonVersion, ReleaseChannel } from "./services/providers";
import { readZipEntries, readZipEntry } from "./services/zip";
import type { ZipEntry } from "./services/zip";
import { MODPACK_LOADERS, traitsOf } from "./software";
import type { ClusterConfig, InstanceConfig, InstanceModpack, Software } from "./types";
import { t } from "../shared/i18n";

/** Hosts the mrpack specification lets a pack download from; anything else is refused. */
export const MRPACK_HOSTS = ["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com"];

/** The list of files a pack wrote, kept inside the instance it wrote them to. */
export const MODPACK_MANIFEST = ".luna-modpack.json";

const INDEX_MEMBER = "modrinth.index.json";

/** Later entries win: a server override replaces the generic one of the same path. */
const OVERRIDE_DIRS = ["overrides/", "server-overrides/"];

/** Largest single override file taken out of the zip; a world can be bigger, a config never is. */
const OVERRIDE_LIMIT = 512 * 1024 * 1024;

/** Files fetched at once; a pack is hundreds of small jars, not one big one. */
const DOWNLOAD_WORKERS = 4;

/** A pack at the plain default of a few gigabytes dies on the first world load. */
const DEFAULT_MEMORY = "6G";

/**
 * Pack files luna refuses to lay down, because they decide how a server starts
 * and luna owns that: `server.properties` carries the port, bind address and
 * forwarding keys create wrote; the launch scripts are regenerated every start;
 * `default-server.properties` is what the mod removed below reads.
 */
const LAUNCH_FILES = new Set([
	"server.properties",
	"eula.txt",
	"run.sh",
	"run.bat",
	"start.sh",
	"start.bat",
	"start.ps1",
	"user_jvm_args.txt",
	"variables.txt",
	"default-server.properties",
]);

/**
 * A mod some packs ship that rewrites `server.properties` from the pack's own
 * defaults at first boot: the port, `server-ip` and `online-mode` luna wrote
 * are lost, the server binds `*:25565` with online mode on, and nothing in the
 * log says so.
 */
const CRUFT_MODS = /^default-server-properties.*\.jar$/i;

/**
 * Override paths that only mean something to a client. A pack has one
 * `overrides/` tree for both sides, so shader packs, resource packs and the
 * client's own option files arrive with it; a server has no use for them, and
 * a popular pack carries over a thousand of them.
 */
const CLIENT_ROOTS = ["resourcepacks/", "shaderpacks/", "screenshots/", "saves/"];
const CLIENT_FILES = new Set(["options.txt", "optionsof.txt", "optionsshaders.txt", "servers.dat"]);

/**
 * Dependency ids every mod declares that no jar provides: the game, the JVM
 * and the loader itself. Anything else unresolved is a mod the server lacks.
 */
const BUILTIN_IDS = new Set(["minecraft", "java", "fabricloader", "fabric", "forge", "neoforge"]);

/** Rounds of dependency rescue; a rescued library can itself need one more. */
const RESCUE_ROUNDS = 3;

/** The index's dependency keys that name a loader luna can host. */
const LOADER_SOFTWARE: Record<string, Software> = {
	neoforge: "neoforge",
	forge: "forge",
	"fabric-loader": "fabric",
};

interface MrpackFile {
	path: string;
	hashes?: { sha1?: string; sha512?: string };
	env?: { client?: string; server?: string };
	downloads?: string[];
	fileSize?: number;
}

interface MrpackIndex {
	formatVersion?: number;
	game?: string;
	versionId?: string;
	name?: string;
	summary?: string;
	files?: MrpackFile[];
	dependencies?: Record<string, string>;
}

/** What the index asks the server to be. */
interface PackTarget {
	software: Software;
	mcVersion: string;
	loaderVersion: string;
}

/** One published version of a pack, as the pickers list them. */
export interface ModpackVersion {
	id: string;
	versionNumber: string;
	channel: ReleaseChannel;
	mcVersions: string[];
	loaders: string[];
	publishedAt: string;
	fileName: string;
	sizeBytes: number;
	/** Whether a loader luna hosts is among the version's */
	runnable: boolean;
}

export interface ModpackSearchHit {
	slug: string;
	id: string;
	title: string;
	description: string;
	downloads: number;
	mcVersions?: string[];
	categories?: string[];
}

/** The record an install leaves in the instance directory. */
export interface ModpackManifest extends InstanceModpack {
	installedAt: number;
	/** Paths from the index, relative to the instance, forward slashes */
	files: string[];
	/** Paths taken out of the overrides, the same way */
	overrides: string[];
}

/** Where a pack comes from: a Modrinth project, or an .mrpack already on this machine's disk. */
export interface ModpackSource {
	/** Modrinth project slug or id */
	slug?: string;
	/** A version id or version number; absent takes the newest stable build luna can run */
	versionId?: string;
	/** A local .mrpack, for a pack that is not on Modrinth */
	mrpackPath?: string;
}

export interface ModpackInstallOptions extends ModpackSource {
	memory?: string;
	port?: number;
	profile?: string;
	runtime?: string;
	register?: boolean;
	daemon?: string;
	/** Leave out files the pack marks optional on the server */
	skipOptional?: boolean;
	reporter?: ProgressReporter;
}

/** A dependency the pack's server mods needed and luna fetched for them. */
export interface RescuedDependency {
	id: string;
	/** `pack`: shipped by the pack under a client-only tag; `modrinth`: not in the pack, found by id */
	from: "pack" | "modrinth";
	path: string;
}

export interface ModpackInstallResult {
	name: string;
	software: Software;
	mcVersion: string;
	loaderVersion?: string;
	port: number;
	modpack: InstanceModpack;
	files: number;
	/** Index files marked unsupported on the server, which were not fetched */
	clientOnly: number;
	overrides: number;
	/** Override paths refused or unreadable, by relative path */
	skipped: string[];
	/** Override files that only a client reads, left out */
	clientOverrides: number;
	/** Files removed after laying the pack down, by relative path */
	removed: string[];
	/** Pool addons the pack already ships, so luna's copy is withheld from this instance */
	withheld: string[];
	rescued: RescuedDependency[];
	/** Dependency ids the server mods declare that nothing could supply; the server will not start */
	unresolved: string[];
}

export interface ModpackUpdateOptions {
	versionId?: string;
	mrpackPath?: string;
	skipOptional?: boolean;
	/** Reinstall the version already on the instance */
	force?: boolean;
	reporter?: ProgressReporter;
}

export interface ModpackUpdateResult {
	name: string;
	from: InstanceModpack | null;
	to: InstanceModpack;
	/** The Minecraft or loader version moved with the pack */
	versionChanged: boolean;
	mcVersion: string;
	loaderVersion: string;
	files: number;
	overrides: number;
	/** Files the previous version wrote and this one does not */
	removed: number;
	skipped: string[];
	clientOverrides: number;
	withheld: string[];
	rescued: RescuedDependency[];
	unresolved: string[];
}

interface ResolvedPack {
	mrpack: string;
	index: MrpackIndex;
	entries: ZipEntry[];
	target: PackTarget;
	provenance: InstanceModpack;
	/** The file is a download of ours and goes once used */
	staged: boolean;
}

interface LayOutcome {
	written: string[];
	skipped: string[];
	/** Client-side override files left in the zip, counted rather than listed */
	clientOnly: number;
}

function sortVersions(versions: AddonVersion[]): AddonVersion[] {
	return [...versions].sort((a, b) => b.date_published.localeCompare(a.date_published));
}

function runnable(version: AddonVersion): boolean {
	return version.loaders.some((loader) => MODPACK_LOADERS.includes(loader));
}

function summarize(version: AddonVersion): ModpackVersion {
	const file = primaryFile(version);

	return {
		id: version.id,
		versionNumber: version.version_number,
		channel: version.version_type,
		mcVersions: version.game_versions,
		loaders: version.loaders,
		publishedAt: version.date_published,
		fileName: file.filename,
		sizeBytes: file.size,
		runnable: runnable(version),
	};
}

/** Modrinth modpacks matching a query, narrowed to the loaders luna hosts unless told otherwise. */
export async function searchModpacks(query: string, loaders?: string[]): Promise<ModpackSearchHit[]> {
	const hits = await searchProvider("modrinth", query, "modpack", loaders);

	return hits.map((hit) => ({
		slug: hit.slug,
		id: hit.project_id,
		title: hit.title,
		description: hit.description,
		downloads: hit.downloads,
		mcVersions: hit.versions?.slice(-6),
		categories: hit.categories,
	}));
}

async function requireProject(slug: string) {
	const project = await getProject("modrinth", slug, "modpack");

	if (!project) {
		throw new Error(t("core.modpack.projectNotFound", { slug }));
	}

	return project;
}

/** Every published version of a pack, newest first. */
export async function modpackVersions(slug: string): Promise<ModpackVersion[]> {
	const project = await requireProject(slug);
	const versions = await getVersions(remoteRefFor("modrinth", project), "modpack");

	return sortVersions(versions).map(summarize);
}

/**
 * The version to install: the one asked for by id or number, else the newest
 * stable build on a loader luna can host, else the newest such build at all.
 */
function pickVersion(versions: AddonVersion[], versionId: string | undefined, slug: string): AddonVersion {
	const sorted = sortVersions(versions);

	if (versionId) {
		const found = sorted.find((version) => version.id === versionId || version.version_number === versionId);

		if (!found) {
			throw new Error(t("core.modpack.versionNotFound", { version: versionId, slug }));
		}

		return found;
	}

	const hostable = sorted.filter(runnable);
	const pick = hostable.find((version) => version.version_type === "release") ?? hostable[0];

	if (!pick) {
		throw new Error(t("core.modpack.noVersions", { slug }));
	}

	return pick;
}

function fmtMb(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(1);
}

async function fetchMrpack(version: AddonVersion, name: string, step: ProgressReporter): Promise<string> {
	const file = primaryFile(version);

	await mkdir(stagingDir(), { recursive: true });

	const dest = join(stagingDir(), `modpack-${name}-${version.id}.mrpack`);

	await downloadToFile(file.url, dest, {
		expected: file.hashes,
		onProgress: (received, total) => {
			step.report(
				total ? 0.3 + (received / total) * 0.7 : 0.5,
				"info",
				t("core.modpack.downloading", { received: fmtMb(received), total: total ? fmtMb(total) : "?" }),
			);
		},
	});

	return dest;
}

async function readIndex(mrpack: string): Promise<{ index: MrpackIndex; entries: ZipEntry[] }> {
	const entries = await readZipEntries(mrpack);
	const member = entries.find((entry) => entry.name === INDEX_MEMBER);

	if (!member) {
		throw new Error(t("core.modpack.notAModpack", { file: basename(mrpack) }));
	}

	const raw = await readZipEntry(mrpack, member);

	if (!raw) {
		throw new Error(t("core.modpack.badIndex"));
	}

	let index: MrpackIndex;

	try {
		index = JSON.parse(raw.toString("utf8")) as MrpackIndex;
	} catch {
		throw new Error(t("core.modpack.badIndex"));
	}

	if (index.formatVersion !== 1) {
		throw new Error(t("core.modpack.badFormat", { version: String(index.formatVersion) }));
	}

	if (index.game !== "minecraft") {
		throw new Error(t("core.modpack.notMinecraft"));
	}

	if (!Array.isArray(index.files) || !index.dependencies || typeof index.dependencies !== "object") {
		throw new Error(t("core.modpack.badIndex"));
	}

	return { index, entries };
}

/** The loader and versions the index names; refused unless exactly one hostable loader is named. */
function targetOf(index: MrpackIndex): PackTarget {
	const deps = index.dependencies ?? {};
	const mcVersion = deps.minecraft;

	if (!mcVersion) {
		throw new Error(t("core.modpack.badIndex"));
	}

	const loaders = Object.keys(deps).filter((key) => key !== "minecraft");
	const unknown = loaders.find((key) => !LOADER_SOFTWARE[key]);

	if (unknown) {
		throw new Error(t("core.modpack.unsupportedLoader", { loader: unknown }));
	}

	const [loader] = loaders;

	if (!loader || loaders.length !== 1) {
		throw new Error(t("core.modpack.noLoader"));
	}

	return { software: LOADER_SOFTWARE[loader]!, mcVersion, loaderVersion: deps[loader]! };
}

/** A pack path as the manifest records it: forward slashes, normalised. */
function packPath(relative: string): string {
	return posix.normalize(relative.replace(/\\/g, "/"));
}

/** The absolute path a pack-relative one lands at, refused when it would leave the instance. */
function safePath(dir: string, relative: string): string {
	const normalized = packPath(relative);
	const escapes =
		!normalized ||
		normalized === "." ||
		normalized.startsWith("/") ||
		normalized === ".." ||
		normalized.startsWith("../") ||
		/^[a-zA-Z]:/.test(normalized);

	if (escapes) {
		throw new Error(t("core.modpack.badPath", { path: relative }));
	}

	const target = resolve(dir, normalized);

	if (target !== dir && !target.startsWith(dir + sep)) {
		throw new Error(t("core.modpack.badPath", { path: relative }));
	}

	return target;
}

async function pickDownload(file: MrpackFile): Promise<URL> {
	const urls: URL[] = [];

	for (const raw of file.downloads ?? []) {
		try {
			urls.push(new URL(raw));
		} catch {
			// a malformed entry is skipped; the next mirror may be fine
		}
	}

	if (urls.length === 0) {
		throw new Error(t("core.modpack.noDownload", { path: file.path }));
	}

	const allowed = urls.find((url) => MRPACK_HOSTS.includes(url.hostname.toLowerCase()));

	if (!allowed) {
		throw new Error(t("core.modpack.badHost", { host: urls[0]!.hostname, path: file.path }));
	}

	await assertPublic(allowed);

	return allowed;
}

function hashesOf(file: MrpackFile): KnownHashes {
	const hashes: KnownHashes = {};

	if (file.hashes?.sha1) {
		hashes.sha1 = file.hashes.sha1;
	}

	if (file.hashes?.sha512) {
		hashes.sha512 = file.hashes.sha512;
	}

	return hashes;
}

/** Fetch every server-side file the index names into the instance. */
async function layFiles(
	dir: string,
	index: MrpackIndex,
	skipOptional: boolean,
	step: ProgressReporter,
): Promise<LayOutcome & { clientOnly: number }> {
	const files = index.files ?? [];
	const clientOnly = files.filter((file) => file.env?.server === "unsupported").length;
	const queue = files.filter((file) => {
		const env = file.env?.server ?? "required";

		if (env === "unsupported") {
			return false;
		}

		return !(env === "optional" && skipOptional);
	});

	const total = queue.length;
	const written: string[] = [];
	let done = 0;

	const worker = async (): Promise<void> => {
		for (;;) {
			const file = queue.shift();

			if (!file) {
				return;
			}

			const dest = safePath(dir, file.path);
			const url = await pickDownload(file);

			await mkdir(dirname(dest), { recursive: true });
			await downloadToFile(url.href, dest, { expected: hashesOf(file) });

			written.push(packPath(file.path));
			done++;
			step.report(done / total, "info", t("core.modpack.fileProgress", { done, total, file: basename(file.path) }));
		}
	};

	await Promise.all(Array.from({ length: Math.min(DOWNLOAD_WORKERS, total) }, worker));

	return { written, skipped: [], clientOnly };
}

function clientSide(relative: string): boolean {
	return CLIENT_FILES.has(relative) || CLIENT_ROOTS.some((root) => relative.startsWith(root));
}

/** Copy the pack's override trees into the instance, server overrides over generic ones. */
async function layOverrides(dir: string, mrpack: string, entries: ZipEntry[], step: ProgressReporter): Promise<LayOutcome> {
	const prefixOf = (entry: ZipEntry): number => OVERRIDE_DIRS.findIndex((prefix) => entry.name.startsWith(prefix));
	const members = entries
		.filter((entry) => prefixOf(entry) !== -1 && !entry.name.endsWith("/"))
		.sort((a, b) => prefixOf(a) - prefixOf(b));

	const written: string[] = [];
	const skipped: string[] = [];
	let clientOnly = 0;
	let done = 0;

	for (const entry of members) {
		const relative = entry.name.slice(OVERRIDE_DIRS[prefixOf(entry)]!.length);

		done++;

		if (LAUNCH_FILES.has(relative)) {
			skipped.push(relative);

			continue;
		}

		if (clientSide(relative)) {
			clientOnly++;

			continue;
		}

		const dest = safePath(dir, relative);
		const bytes = await readZipEntry(mrpack, entry, OVERRIDE_LIMIT);

		if (!bytes) {
			skipped.push(relative);

			continue;
		}

		await mkdir(dirname(dest), { recursive: true });
		await Bun.write(dest, bytes);

		const recorded = packPath(relative);

		if (!written.includes(recorded)) {
			written.push(recorded);
		}

		step.report(done / members.length, "info", relative);
	}

	return { written, skipped, clientOnly };
}

async function removeCruft(dir: string): Promise<string[]> {
	const mods = join(dir, "mods");
	const removed: string[] = [];

	if (!existsSync(mods)) {
		return removed;
	}

	for (const name of await readdir(mods)) {
		if (CRUFT_MODS.test(name)) {
			await rm(join(mods, name), { force: true });
			removed.push(`mods/${name}`);
		}
	}

	return removed;
}

/** What one mod jar says about itself: the ids it supplies and the ids it cannot run without. */
interface ModDescriptor {
	provides: string[];
	requires: string[];
	/** Jars nested inside this one (Fabric `jars`, Forge jar-in-jar), which supply ids of their own */
	nested: string[];
}

interface FabricModJson {
	id?: string;
	provides?: string[];
	depends?: Record<string, unknown>;
	jars?: Array<{ file?: string }>;
}

/**
 * Fabric's own reader accepts raw control characters inside strings, and some
 * mods ship a description with a literal newline in it, so a strict parse
 * would call a working mod unreadable. Whitespace is insignificant outside
 * strings and only a description inside them, so every control character is
 * blanked before parsing.
 */
function parseModJson(text: string): FabricModJson | undefined {
	try {
		return JSON.parse(text.replace(/[\u0000-\u001f]/g, " ")) as FabricModJson;
	} catch {
		return undefined;
	}
}

/** The dependency blocks of a Forge or NeoForge mods.toml that bind on a server. */
function tomlRequires(toml: string): string[] {
	const requires: string[] = [];

	for (const block of toml.split(/^\s*\[\[dependencies\./m).slice(1)) {
		const modId = /^\s*modId\s*=\s*"([^"]+)"/m.exec(block)?.[1];
		const required = /^\s*type\s*=\s*"required"/m.test(block) || /^\s*mandatory\s*=\s*true/m.test(block);
		const clientOnly = /^\s*side\s*=\s*"CLIENT"/m.test(block);

		if (modId && required && !clientOnly) {
			requires.push(modId);
		}
	}

	return requires;
}

/** Read a jar's descriptor, whichever loader wrote it; empty for a jar with none. */
async function describeMod(jar: string): Promise<ModDescriptor> {
	const fabric = await unzipRead(jar, "fabric.mod.json");

	if (fabric) {
		const parsed = parseModJson(fabric);

		if (!parsed?.id) {
			return { provides: [], requires: [], nested: [] };
		}

		return {
			provides: [parsed.id, ...(parsed.provides ?? [])],
			requires: parsed.depends && typeof parsed.depends === "object" ? Object.keys(parsed.depends) : [],
			nested: (parsed.jars ?? []).map((entry) => entry.file ?? "").filter((file) => file !== ""),
		};
	}

	const toml = (await unzipRead(jar, "META-INF/neoforge.mods.toml")) ?? (await unzipRead(jar, "META-INF/mods.toml"));

	if (toml) {
		const provides = [...toml.matchAll(/^\s*modId\s*=\s*"([^"]+)"/gm)].map((match) => match[1]!);
		const metadata = await unzipRead(jar, "META-INF/jarjar/metadata.json");
		let nested: string[] = [];

		if (metadata) {
			try {
				const parsed = JSON.parse(metadata) as { jars?: Array<{ path?: string }> };

				nested = (parsed.jars ?? []).map((entry) => entry.path ?? "").filter((path) => path !== "");
			} catch {
				nested = [];
			}
		}

		// a toml's modId lines include the dependency blocks' own; those are not provided
		const own = provides.filter((id) => !tomlRequires(toml).includes(id));

		return { provides: own, requires: tomlRequires(toml), nested };
	}

	return { provides: [], requires: [], nested: [] };
}

/**
 * The ids a nested jar supplies. `unzip -p` yields the inner jar's bytes, which
 * go to a scratch file so the same descriptor reader can open it; a nested jar
 * is a library and small.
 */
async function nestedProvides(outer: string, inner: string): Promise<string[]> {
	const scratch = join(tmpdir(), `luna-nested-${randomBytes(6).toString("hex")}.jar`);

	try {
		const proc = Bun.spawn(["unzip", "-p", outer, inner], { stdout: "pipe", stderr: "ignore" });
		const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());

		await proc.exited;

		if (proc.exitCode !== 0 || bytes.byteLength === 0) {
			return [];
		}

		await writeFile(scratch, bytes);

		return (await describeMod(scratch)).provides;
	} finally {
		await rm(scratch, { force: true });
	}
}

/** The mod ids a jar declares, nested jars excluded. */
async function modIdsOf(jar: string): Promise<string[]> {
	return (await describeMod(jar)).provides;
}

/** A pack filename normalised for matching against a mod id: lowercase, one kind of separator. */
function slugLike(text: string): string {
	return text.toLowerCase().replace(/[_\s]/g, "-");
}

/**
 * Fetch the dependencies the laid server mods declare and nothing supplies.
 *
 * Pack authors tag by what the *client* needs, so a library a server mod
 * depends on is often tagged client-only (uilib in ba+), or left out of the
 * index altogether because a client mod bundles it (cloth-config there). The
 * loader would refuse to start and name exactly these ids, so they are fetched
 * before the first boot instead: from the pack's own client-only entries when a
 * filename matches the id, else from Modrinth by that id for the same loader
 * and Minecraft version. A downloaded jar is kept only when it declares the id
 * it was fetched for. What neither source can supply is reported, not guessed.
 */
async function rescueDependencies(
	dir: string,
	index: MrpackIndex,
	target: PackTarget,
	step: ProgressReporter,
): Promise<{ rescued: RescuedDependency[]; unresolved: string[] }> {
	const mods = join(dir, "mods");
	const rescued: RescuedDependency[] = [];
	const clientOnly = (index.files ?? []).filter((file) => file.env?.server === "unsupported" && file.path.endsWith(".jar"));
	const loader = target.software === "fabric"
		? "fabric"
		: target.software;
	let unresolved: string[] = [];

	for (let round = 0; round < RESCUE_ROUNDS; round++) {
		if (!existsSync(mods)) {
			break;
		}

		const provided = new Set<string>(BUILTIN_IDS);
		const requires = new Set<string>();

		for (const name of await readdir(mods)) {
			if (!name.endsWith(".jar")) {
				continue;
			}

			const jar = join(mods, name);
			const descriptor = await describeMod(jar);

			for (const id of descriptor.provides) {
				provided.add(id);
			}

			for (const id of descriptor.requires) {
				requires.add(id);
			}

			for (const inner of descriptor.nested) {
				for (const id of await nestedProvides(jar, inner)) {
					provided.add(id);
				}
			}
		}

		const missing = [...requires].filter((id) => !provided.has(id));

		unresolved = [];

		if (missing.length === 0) {
			break;
		}

		for (const id of missing) {
			step.say("info", t("core.modpack.rescuing", { id }));

			const got = await rescueOne(mods, id, clientOnly, loader, target.mcVersion);

			if (got) {
				rescued.push(got);
			} else {
				unresolved.push(id);
			}
		}

		// nothing new to read on the next round means the remaining ids stay unresolved
		if (unresolved.length === missing.length) {
			break;
		}
	}

	return { rescued, unresolved };
}

/** Download one jar into mods/ and keep it only if it declares the wanted id. */
async function fetchVerified(mods: string, id: string, url: string, filename: string, expected: KnownHashes): Promise<string | null> {
	const dest = safePath(mods, basename(filename));

	await mkdir(mods, { recursive: true });
	await downloadToFile(url, dest, { expected });

	const provides = (await describeMod(dest)).provides;

	if (!provides.includes(id)) {
		await rm(dest, { force: true });

		return null;
	}

	return `mods/${basename(dest)}`;
}

async function rescueOne(
	mods: string,
	id: string,
	clientOnly: MrpackFile[],
	loader: string,
	mcVersion: string,
): Promise<RescuedDependency | null> {
	const wanted = slugLike(id);
	const shipped = clientOnly.find((file) => slugLike(basename(file.path)).includes(wanted));

	if (shipped) {
		try {
			const url = await pickDownload(shipped);
			const path = await fetchVerified(mods, id, url.href, shipped.path, hashesOf(shipped));

			if (path) {
				return { id, from: "pack", path };
			}
		} catch {
			// the pack's copy is unusable; Modrinth may still have the mod
		}
	}

	try {
		const project = await getProject("modrinth", id, "mod");

		if (!project) {
			return null;
		}

		const versions = await getVersions(remoteRefFor("modrinth", project), "mod", [loader]);
		const fitting = versions
			.filter((version) => coversMc(version.game_versions, mcVersion))
			.sort((a, b) => b.date_published.localeCompare(a.date_published));
		const version = fitting.find((candidate) => candidate.version_type === "release") ?? fitting[0];

		if (!version) {
			return null;
		}

		const file = primaryFile(version);
		const path = await fetchVerified(mods, id, file.url, file.filename, file.hashes);

		return path
			? { id, from: "modrinth", path }
			: null;
	} catch {
		return null;
	}
}

/**
 * Withhold from this instance every addon luna would pool for its software that
 * the pack already ships. Every Fabric pack carries fabric-api, and luna pools
 * it too as what the forwarding mod depends on; two jars of one mod id is a
 * server Fabric refuses to boot. The pack's copy is the one that moves with the
 * pack, so the pool's is the one to keep out, by the same override an operator
 * would set.
 */
async function withholdShipped(inst: InstanceConfig, dir: string, written: string[]): Promise<string[]> {
	const traits = traitsOf(inst.software, inst.mcVersion);
	const candidates = (traits.requiredAddons ?? []).map((addon) => addon.slug);

	if (traits.forwardingMod) {
		candidates.push(traits.forwardingMod.slug);
	}

	if (candidates.length === 0) {
		return [];
	}

	const ids = new Set<string>();

	for (const path of written) {
		if (!path.startsWith("mods/") || !path.endsWith(".jar")) {
			continue;
		}

		for (const id of await modIdsOf(join(dir, path))) {
			ids.add(id);
		}
	}

	const withheld = candidates.filter((slug) => ids.has(slug) || ids.has(slug.replace(/-/g, "_")));

	if (withheld.length > 0) {
		inst.pluginOverrides = {
			...(inst.pluginOverrides ?? {}),
			...Object.fromEntries(withheld.map((slug) => [slug, false])),
		};
	}

	return withheld;
}

async function readManifest(dir: string): Promise<ModpackManifest | undefined> {
	const file = Bun.file(join(dir, MODPACK_MANIFEST));

	if (!(await file.exists())) {
		return undefined;
	}

	try {
		return (await file.json()) as ModpackManifest;
	} catch {
		return undefined;
	}
}

async function writeManifest(dir: string, manifest: ModpackManifest): Promise<void> {
	await Bun.write(join(dir, MODPACK_MANIFEST), JSON.stringify(manifest, null, "\t") + "\n");
}

/** Find the pack, fetch it when it is remote, read its index and decide what it needs. */
async function resolvePack(source: ModpackSource, name: string, step: ProgressReporter): Promise<ResolvedPack> {
	if (!source.mrpackPath === !source.slug) {
		throw new Error(t("core.modpack.oneSource"));
	}

	let mrpack: string;
	let staged = false;
	let provenance: Partial<InstanceModpack> & Pick<InstanceModpack, "provider">;

	if (source.mrpackPath) {
		if (!existsSync(source.mrpackPath)) {
			throw new Error(t("core.modpack.fileMissing", { path: source.mrpackPath }));
		}

		mrpack = source.mrpackPath;
		provenance = { provider: "file" };
	} else {
		const project = await requireProject(source.slug!);
		const versions = await getVersions(remoteRefFor("modrinth", project), "modpack");
		const version = pickVersion(versions, source.versionId, source.slug!);

		step.info(0.3, t("core.modpack.resolved", { name: project.title, version: version.version_number }));

		mrpack = await fetchMrpack(version, name, step);
		staged = true;
		provenance = {
			provider: "modrinth",
			projectId: project.id,
			slug: project.slug,
			versionId: version.id,
			versionNumber: version.version_number,
		};
	}

	try {
		const { index, entries } = await readIndex(mrpack);
		const target = targetOf(index);
		const fallbackVersion = index.versionId ?? "unknown";

		return {
			mrpack,
			index,
			entries,
			target,
			staged,
			provenance: {
				...provenance,
				versionId: provenance.versionId ?? fallbackVersion,
				versionNumber: provenance.versionNumber ?? fallbackVersion,
				name: index.name ?? provenance.slug ?? basename(mrpack),
			},
		};
	} catch (err) {
		if (staged) {
			await rm(mrpack, { force: true });
		}

		throw err;
	}
}

/**
 * Provision a new instance from a modpack: the server the pack's index calls
 * for, then the pack's files over it. Mutates cfg with the registry entry
 * (caller saves) exactly as `createInstance` does; the caller then runs the
 * same deploy step a plain create runs, so luna's own additions arrive.
 *
 * A failure after the server was created removes it again, so the registry
 * never ends up naming a half-filled directory.
 */
export async function installModpack(
	cfg: ClusterConfig,
	name: string,
	opts: ModpackInstallOptions,
): Promise<ModpackInstallResult> {
	const progress = opts.reporter ?? new ProgressReporter(`modpack ${name}`);

	progress.weighOwn(0);

	const fetching = progress.child(t("core.modpack.phaseFetch"), 2);
	const server = progress.child(t("core.modpack.phaseServer"), 6);
	const files = progress.child(t("core.modpack.phaseFiles"), 6);
	const overrides = progress.child(t("core.modpack.phaseOverrides"), 1);
	const deps = progress.child(t("core.modpack.phaseDeps"), 2);

	const pack = await fetching.task({ start: t("core.modpack.fetching") }, (step) => resolvePack(opts, name, step));

	try {
		const created = await createInstance(cfg, name, {
			software: pack.target.software,
			mcVersion: pack.target.mcVersion,
			loaderVersion: pack.target.loaderVersion,
			memory: opts.memory ?? DEFAULT_MEMORY,
			port: opts.port,
			profile: opts.profile,
			runtime: opts.runtime,
			register: opts.register,
			daemon: opts.daemon,
			reporter: server,
		});

		const inst = cfg.instances[name]!;
		const dir = instanceDir(inst);

		try {
			const laid = await files.task({ start: t("core.modpack.layingFiles") }, (step) =>
				layFiles(dir, pack.index, !!opts.skipOptional, step),
			);

			files.complete(t("core.modpack.filesDone", { count: laid.written.length, clientOnly: laid.clientOnly }));

			const over = await overrides.task({ start: t("core.modpack.layingOverrides") }, (step) =>
				layOverrides(dir, pack.mrpack, pack.entries, step),
			);

			overrides.complete(t("core.modpack.overridesDone", { count: over.written.length, skipped: over.skipped.length + over.clientOnly }));

			const removed = await removeCruft(dir);
			const resolution = await deps.task({ start: t("core.modpack.resolvingDeps") }, (step) =>
				rescueDependencies(dir, pack.index, pack.target, step),
			);

			deps.complete(t("core.modpack.depsDone", { rescued: resolution.rescued.length, unresolved: resolution.unresolved.length }));

			const withheld = await withholdShipped(inst, dir, [...laid.written, ...resolution.rescued.map((entry) => entry.path)]);

			await writeManifest(dir, {
				...pack.provenance,
				installedAt: Date.now(),
				files: [...laid.written, ...resolution.rescued.map((entry) => entry.path)],
				overrides: over.written.filter((path) => !removed.includes(path)),
			});

			inst.modpack = pack.provenance;

			return {
				name,
				software: pack.target.software,
				mcVersion: created.build.mcVersion ?? pack.target.mcVersion,
				loaderVersion: created.build.loaderVersion,
				port: created.port,
				modpack: pack.provenance,
				files: laid.written.length,
				clientOnly: laid.clientOnly,
				overrides: over.written.length,
				skipped: over.skipped,
				clientOverrides: over.clientOnly,
				removed,
				withheld,
				rescued: resolution.rescued,
				unresolved: resolution.unresolved,
			};
		} catch (err) {
			// the server exists but the pack does not: take it back out, so the
			// registry never names a directory the pack only half filled
			await rm(dir, { recursive: true, force: true });
			releaseInstancePorts(inst);
			delete cfg.instances[name];

			throw err;
		}
	} finally {
		if (pack.staged) {
			await rm(pack.mrpack, { force: true });
		}
	}
}

/**
 * Move an instance to another version of its pack: the Minecraft and loader
 * versions first when they changed, then the new files over the old, then
 * whatever the previous version wrote and this one does not is removed. The
 * instance must be stopped; mods are swapped under no running JVM. Mutates cfg
 * (caller saves).
 */
export async function updateModpack(
	cfg: ClusterConfig,
	name: string,
	opts: ModpackUpdateOptions = {},
): Promise<ModpackUpdateResult> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const from = inst.modpack ?? null;

	if (!from && !opts.mrpackPath) {
		throw new Error(t("core.modpack.notFromModpack", { name }));
	}

	if (from?.provider === "file" && !opts.mrpackPath) {
		throw new Error(t("core.modpack.fileNeedsPath", { name }));
	}

	const status = await getStatus(cfg, name);

	if (status.state !== "stopped") {
		throw new Error(t("core.modpack.stopFirst", { name }));
	}

	const progress = opts.reporter ?? new ProgressReporter(`modpack update ${name}`);

	progress.weighOwn(0);

	const fetching = progress.child(t("core.modpack.phaseFetch"), 2);
	const version = progress.child(t("core.modpack.phaseVersion"), 4);
	const files = progress.child(t("core.modpack.phaseFiles"), 6);
	const overrides = progress.child(t("core.modpack.phaseOverrides"), 1);
	const cleanup = progress.child(t("core.modpack.phaseCleanup"), 1);
	const deps = progress.child(t("core.modpack.phaseDeps"), 2);

	const source: ModpackSource = opts.mrpackPath
		? { mrpackPath: opts.mrpackPath }
		: { slug: from!.slug ?? from!.projectId, versionId: opts.versionId };

	const pack = await fetching.task({ start: t("core.modpack.fetching") }, (step) => resolvePack(source, name, step));

	try {
		if (from && pack.provenance.versionId === from.versionId && !opts.force) {
			throw new Error(t("core.modpack.alreadyOn", { version: from.versionNumber }));
		}

		if (pack.target.software !== inst.software) {
			throw new Error(t("core.modpack.loaderChanged", { from: inst.software, to: pack.target.software }));
		}

		const versionChanged =
			pack.target.mcVersion !== inst.mcVersion || pack.target.loaderVersion !== inst.loaderVersion;

		if (versionChanged) {
			await version.task(
				{ start: t("core.modpack.movingVersion", { mc: pack.target.mcVersion, loader: pack.target.loaderVersion }) },
				(step) => setVersion(cfg, name, { mcVersion: pack.target.mcVersion, loaderVersion: pack.target.loaderVersion }, step),
			);
		} else {
			version.complete(t("core.modpack.sameVersion"));
		}

		const dir = instanceDir(inst);
		const previous = await readManifest(dir);

		const laid = await files.task({ start: t("core.modpack.layingFiles") }, (step) =>
			layFiles(dir, pack.index, !!opts.skipOptional, step),
		);

		files.complete(t("core.modpack.filesDone", { count: laid.written.length, clientOnly: laid.clientOnly }));

		const over = await overrides.task({ start: t("core.modpack.layingOverrides") }, (step) =>
			layOverrides(dir, pack.mrpack, pack.entries, step),
		);

		overrides.complete(t("core.modpack.overridesDone", { count: over.written.length, skipped: over.skipped.length + over.clientOnly }));

		const kept = new Set([...laid.written, ...over.written]);
		const stale = [...(previous?.files ?? []), ...(previous?.overrides ?? [])].filter((path) => !kept.has(path));

		await cleanup.task({ start: t("core.modpack.removingStale") }, async (step) => {
			for (const path of stale) {
				await rm(safePath(dir, path), { force: true });
			}

			step.report(1, "okay", t("core.modpack.staleRemoved", { count: stale.length }));
		});

		const cruft = await removeCruft(dir);
		const resolution = await deps.task({ start: t("core.modpack.resolvingDeps") }, (step) =>
			rescueDependencies(dir, pack.index, pack.target, step),
		);

		deps.complete(t("core.modpack.depsDone", { rescued: resolution.rescued.length, unresolved: resolution.unresolved.length }));

		const withheld = await withholdShipped(inst, dir, [...laid.written, ...resolution.rescued.map((entry) => entry.path)]);

		await writeManifest(dir, {
			...pack.provenance,
			installedAt: Date.now(),
			files: [...laid.written, ...resolution.rescued.map((entry) => entry.path)],
			overrides: over.written.filter((path) => !cruft.includes(path)),
		});

		inst.modpack = pack.provenance;

		return {
			name,
			from,
			to: pack.provenance,
			versionChanged,
			mcVersion: pack.target.mcVersion,
			loaderVersion: pack.target.loaderVersion,
			files: laid.written.length,
			overrides: over.written.length,
			removed: stale.length,
			skipped: over.skipped,
			clientOverrides: over.clientOnly,
			withheld,
			rescued: resolution.rescued,
			unresolved: resolution.unresolved,
		};
	} finally {
		if (pack.staged) {
			await rm(pack.mrpack, { force: true });
		}
	}
}
