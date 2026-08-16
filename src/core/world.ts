// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What an instance's world is, where it lives, and how to read one out of a zip.
 *
 * Two things make this more than a path join. A world's directory name comes
 * from the instance's own config through a software trait (`levelName`), and
 * the *shape* of what sits under it comes from another (`worldLayout`): vanilla
 * and the loaders keep every dimension inside one folder, Bukkit and everything
 * descended from it split the nether and the end out into siblings.
 *
 * And a world zip is not a standardised artifact. It is whatever the person who
 * made it happened to zip: sometimes the world folder, sometimes its parent,
 * sometimes a whole server directory, in either dimension layout. So importing
 * one means finding the world inside the archive, working out which layout it
 * is in, and rewriting the paths into the layout the *target* reads.
 */

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { getConfValue } from "./confedit";
import { instanceDir, managedInstances } from "./config";
import { diskUsage } from "./cleanup";
import { compareMcVersionsDesc, traitsOf } from "./software";
import type { WorldLayout } from "./software";
import { listArchive, walkFiles } from "./services/archive";
import type { ArchiveEntry } from "./services/archive";
import { nbtBigInt, nbtBoolean, nbtNumber, nbtString, nbtStringList, parseNbt } from "./services/nbt";
import type { ClusterConfig, InstanceConfig } from "./types";
import { t } from "../shared/i18n";

/** The dimension folder vanilla keeps the nether in, inside its level directory. */
const NETHER_DIR = "DIM-1";

/** The dimension folder vanilla keeps the end in. */
const END_DIR = "DIM1";

/** Bukkit's suffixes on the sibling directories it splits those two into. */
const NETHER_SUFFIX = "_nether";
const END_SUFFIX = "_the_end";

/** What a `level.dat` must be called, wherever it sits. */
const LEVEL_DAT = "level.dat";

/**
 * Files that identify a directory as a server's, not a world's.
 *
 * Used only to explain a refusal: when there is no `level.dat` anywhere, saying
 * "this looks like a server directory, point at its world folder instead" is
 * far more use than "no world found".
 */
const SERVER_MARKERS = ["server.properties", "eula.txt", "paper-global.yml", "pumpkin.toml"];

/** A world's own files that never travel; the server rewrites them. */
const TRANSIENT_FILES = new Set(["session.lock", "uid.dat"]);

/** A `level.dat` big enough to be suspicious is not a `level.dat`. */
const MAX_LEVEL_DAT_BYTES = 4 * 1024 * 1024;

/** The three dimensions luna names; anything else rides along untouched. */
export type DimensionKind = "overworld" | "nether" | "end";

/** One dimension of a world, and where its data sits. */
export interface WorldDimension {
	kind: DimensionKind;
	/**
	 * Directory holding it, relative to the instance (or to the archive root).
	 * In `split` layout that is `<level>_nether`; in `nested`, `<level>/DIM-1`.
	 */
	path: string;
	sizeBytes: number;
	fileCount: number;
	regionFiles: number;
}

/** What a `level.dat` says about its world. */
export interface LevelInfo {
	levelName?: string;
	/** The version string the writer stamped, e.g. "1.21.10" */
	mcVersion?: string;
	/** Mojang's monotonic world-format number; the authority for compatibility */
	dataVersion?: number;
	/** A snapshot wrote it, so the version string is not a release */
	snapshot?: boolean;
	seed?: string;
	gameType?: number;
	difficulty?: number;
	hardcore?: boolean;
	lastPlayed?: number;
	/** Data packs the world has switched on; a pack it expects to find */
	enabledPacks: string[];
	disabledPacks: string[];
	/** Server software that has written this world, newest last */
	serverBrands: string[];
	wasModded?: boolean;
}

/** Read a `level.dat`; every field is optional because old worlds omit them. */
export async function readLevelDat(path: string): Promise<LevelInfo> {
	const info = await stat(path).catch(() => undefined);

	if (!info) {
		throw new Error(t("core.world.noLevelDat", { path }));
	}

	if (info.size > MAX_LEVEL_DAT_BYTES) {
		throw new Error(t("core.world.levelDatTooBig", { path }));
	}

	const raw = new Uint8Array(await Bun.file(path).arrayBuffer());

	return decodeLevelDat(raw);
}

/** The same, from bytes already in hand. */
export function decodeLevelDat(raw: Uint8Array): LevelInfo {
	const root = parseNbt(raw);
	const seed = nbtBigInt(root, "Data.WorldGenSettings.seed") ?? nbtBigInt(root, "Data.RandomSeed");

	return {
		levelName: nbtString(root, "Data.LevelName"),
		// `Version` arrived in 1.9; an older world reports nothing rather than a
		// guess, and the caller treats an unknown version as a warning
		mcVersion: nbtString(root, "Data.Version.Name"),
		dataVersion: nbtNumber(root, "Data.DataVersion"),
		snapshot: nbtBoolean(root, "Data.Version.Snapshot"),
		seed: seed === undefined ? undefined : String(seed),
		gameType: nbtNumber(root, "Data.GameType"),
		difficulty: nbtNumber(root, "Data.Difficulty"),
		hardcore: nbtBoolean(root, "Data.hardcore"),
		lastPlayed: nbtNumber(root, "Data.LastPlayed"),
		enabledPacks: nbtStringList(root, "Data.DataPacks.Enabled"),
		disabledPacks: nbtStringList(root, "Data.DataPacks.Disabled"),
		serverBrands: nbtStringList(root, "Data.ServerBrands"),
		wasModded: nbtBoolean(root, "Data.WasModded"),
	};
}

/**
 * The level name an instance's own config gives its world.
 *
 * Which file and key hold it is a trait, because it is not the same everywhere:
 * a JVM server reads `level-name` from `server.properties`, pumpkin reads
 * `default_level_name` from its own TOML.
 */
export async function levelNameOf(inst: InstanceConfig): Promise<string> {
	const source = traitsOf(inst.software, inst.mcVersion).levelName;

	if (!source) {
		throw new Error(t("core.world.noWorld", { name: inst.dir }));
	}

	// a fresh instance has no config yet, and the server's own default applies
	const named = await getConfValue(join(instanceDir(inst), source.file), source.format, source.key);

	return named?.trim() || source.fallback;
}

/** Absolute path of an instance's overworld directory. */
export async function worldDir(inst: InstanceConfig): Promise<string> {
	return join(instanceDir(inst), await levelNameOf(inst));
}

/** Whether an instance has a world at all; false for a proxy. */
export function hasWorld(inst: InstanceConfig): boolean {
	return traitsOf(inst.software, inst.mcVersion).levelName !== undefined;
}

/** How this instance's software arranges its dimensions on disk. */
export function layoutOf(inst: InstanceConfig): WorldLayout {
	// nested is vanilla's own shape and the safe assumption for anything whose
	// trait has not been filled in: it puts the data where the level.dat is
	return traitsOf(inst.software, inst.mcVersion).worldLayout ?? "nested";
}

/**
 * Every directory a world occupies, relative to the instance directory.
 *
 * In `split` layout that is three top-level directories; in `nested`, one. The
 * caller uses this for both ends of the job: what a backup collects, and what a
 * replace retires before installing something else.
 */
export function worldDirNames(layout: WorldLayout, level: string): string[] {
	if (layout === "split") {
		return [level, `${level}${NETHER_SUFFIX}`, `${level}${END_SUFFIX}`];
	}

	return [level];
}

/** Directory that holds a given dimension's region data, relative to the instance. */
export function dimensionPath(layout: WorldLayout, level: string, kind: DimensionKind): string {
	if (kind === "overworld") {
		return level;
	}

	if (layout === "split") {
		return kind === "nether" ? `${level}${NETHER_SUFFIX}` : `${level}${END_SUFFIX}`;
	}

	return join(level, kind === "nether" ? NETHER_DIR : END_DIR);
}

/** Sizes of one directory tree, walked once. */
interface TreeStat {
	sizeBytes: number;
	fileCount: number;
	regionFiles: number;
}

/**
 * Measure a directory tree.
 *
 * Its own function rather than a `browseInstance` call: that one is
 * deliberately non-recursive because a world holds hundreds of thousands of
 * region files, and this is the one place that genuinely has to walk them.
 */
async function measureTree(dir: string): Promise<TreeStat> {
	const out: TreeStat = { sizeBytes: 0, fileCount: 0, regionFiles: 0 };

	if (!existsSync(dir)) {
		return out;
	}

	const stack = [dir];

	while (stack.length > 0) {
		const current = stack.pop()!;

		let items;

		try {
			items = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const item of items) {
			const path = join(current, item.name);

			if (item.isSymbolicLink()) {
				continue;
			}

			if (item.isDirectory()) {
				stack.push(path);

				continue;
			}

			if (!item.isFile()) {
				continue;
			}

			const info = await stat(path).catch(() => undefined);

			if (!info) {
				continue;
			}

			out.sizeBytes += info.size;
			out.fileCount++;

			if (item.name.endsWith(".mca") || item.name.endsWith(".mcr")) {
				out.regionFiles++;
			}
		}
	}

	return out;
}

/** What the World tab shows about the world an instance currently has. */
export interface WorldReport {
	instance: string;
	level: string;
	layout: WorldLayout;
	/** False when the server has not generated it yet */
	exists: boolean;
	dimensions: WorldDimension[];
	sizeBytes: number;
	fileCount: number;
	/** From the overworld's `level.dat`; absent when there is no world yet */
	level_dat?: LevelInfo;
	/** Data pack zips sitting in the world's own datapacks folder */
	datapacks: string[];
	modifiedAt?: number;
	/** Free space on the volume the world lives on; absent when df said nothing */
	freeBytes?: number;
	totalBytes?: number;
}

/** Everything the console needs to describe an instance's current world. */
export async function worldInfo(cfg: ClusterConfig, name: string): Promise<WorldReport> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	if (!hasWorld(inst)) {
		throw new Error(t("core.world.noWorld", { name }));
	}

	const dir = instanceDir(inst);
	const level = await levelNameOf(inst);
	const layout = layoutOf(inst);
	const kinds: DimensionKind[] = ["overworld", "nether", "end"];

	const dimensions: WorldDimension[] = [];
	let sizeBytes = 0;
	let fileCount = 0;

	for (const kind of kinds) {
		const rel = dimensionPath(layout, level, kind);
		const abs = join(dir, rel);

		if (!existsSync(abs)) {
			continue;
		}

		const measured = await measureTree(abs);

		// in split layout the overworld's own measurement is its whole directory,
		// which is correct; in nested it would swallow DIM-1 and DIM1, so those
		// are subtracted back out below
		dimensions.push({
			kind,
			path: rel,
			sizeBytes: measured.sizeBytes,
			fileCount: measured.fileCount,
			regionFiles: measured.regionFiles,
		});
	}

	if (layout === "nested") {
		const overworld = dimensions.find((entry) => entry.kind === "overworld");

		for (const entry of dimensions) {
			if (entry.kind === "overworld" || !overworld) {
				continue;
			}

			overworld.sizeBytes -= entry.sizeBytes;
			overworld.fileCount -= entry.fileCount;
			overworld.regionFiles -= entry.regionFiles;
		}
	}

	for (const rel of worldDirNames(layout, level)) {
		const measured = await measureTree(join(dir, rel));

		sizeBytes += measured.sizeBytes;
		fileCount += measured.fileCount;
	}

	const overworldDir = join(dir, level);
	const exists = existsSync(join(overworldDir, LEVEL_DAT));
	const usage = await diskUsage(dir);

	let levelDat: LevelInfo | undefined;

	if (exists) {
		// a world whose level.dat will not parse is still a world; the report says
		// what it can rather than failing the whole tab
		levelDat = await readLevelDat(join(overworldDir, LEVEL_DAT)).catch(() => undefined);
	}

	const packsDir = join(overworldDir, "datapacks");
	const datapacks = existsSync(packsDir)
		? (await readdir(packsDir)).filter((file) => file.toLowerCase().endsWith(".zip")).sort()
		: [];

	const modified = exists ? await stat(join(overworldDir, LEVEL_DAT)).catch(() => undefined) : undefined;

	return {
		instance: name,
		level,
		layout,
		exists,
		dimensions,
		sizeBytes,
		fileCount,
		level_dat: levelDat,
		datapacks,
		modifiedAt: modified?.mtimeMs,
		freeBytes: usage?.freeBytes,
		totalBytes: usage?.totalBytes,
	};
}

// --- reading a world out of an archive ---------------------------------------

/** How the world sits inside the archive that carries it. */
export type ArchiveLayout =
	/** one `level.dat` with `DIM-1`/`DIM1` beside it: vanilla's own shape */
	| "nested"
	/** sibling `X`, `X_nether`, `X_the_end`: what a Bukkit server wrote */
	| "split"
	/** one `level.dat`, no dimension folders: an overworld on its own */
	| "overworld-only";

/** Something the operator should be told before the import runs. */
export interface WorldFinding {
	/** Stable id, so the console can render its own wording per case */
	code: string;
	level: "info" | "warning" | "error";
	/** Placeholder values for the console's message; never pre-rendered prose */
	params?: Record<string, string>;
}

/** What an archive turned out to hold. */
export interface WorldScan {
	archiveLayout: ArchiveLayout;
	/**
	 * Where the overworld root sits inside the archive, "" when the archive *is*
	 * the world. No trailing slash; this is a path, not a prefix, and every
	 * `from` in a plan is built from it so a wrapper folder cannot be lost.
	 */
	rootPath: string;
	/** The overworld's directory name inside the archive, e.g. "world" */
	sourceLevel: string;
	/** Dimension directories found, keyed by kind, relative to `rootPrefix` */
	sources: Partial<Record<DimensionKind, string>>;
	level_dat?: LevelInfo;
	/** Data pack zips carried in the world's own datapacks folder */
	datapacks: string[];
	fileCount: number;
	totalBytes: number;
	findings: WorldFinding[];
}

/** A member name that must never be extracted. */
function unsafeEntry(name: string): boolean {
	if (name.startsWith("/") || /^[a-zA-Z]:/.test(name) || name.includes("\\")) {
		return true;
	}

	return name.split("/").some((part) => part === "..");
}

/** Directory part of an archive member, "" at the archive root. */
function dirOf(name: string): string {
	const cut = name.lastIndexOf("/");

	return cut < 0 ? "" : name.slice(0, cut);
}

/** Last path segment of a directory prefix. */
function baseOf(path: string): string {
	const cut = path.lastIndexOf("/");

	return cut < 0 ? path : path.slice(cut + 1);
}

/**
 * Work out what world an archive holds, and refuse the ones that hold none.
 *
 * The whole algorithm hangs off `level.dat`: wherever one sits, that directory
 * is a world root. Everything after that is deciding which of several roots is
 * the overworld and which layout they are in.
 *
 * @throws when the archive is unreadable, holds no `level.dat`, or holds a
 *   member whose name would escape the directory it is extracted into
 */
export async function scanWorldArchive(archivePath: string): Promise<WorldScan> {
	const listing = await listArchive(archivePath);

	// zip-slip, refused before anything is planned rather than relying on
	// unzip's own silent stripping; an operator gets to see why
	const escaping = listing.entries.find((entry) => unsafeEntry(entry.name));

	if (escaping) {
		throw new Error(t("core.world.archiveEscapes", { path: escaping.name }));
	}

	const levelDats = listing.entries
		.filter((entry) => !entry.directory && baseOf(entry.name) === LEVEL_DAT)
		.map((entry) => dirOf(entry.name));

	if (levelDats.length === 0) {
		throw new Error(describeMissingWorld(listing.entries));
	}

	// the shallowest root is the overworld: a Bukkit split puts all three at the
	// same depth, and a nested world has exactly one
	const depthOf = (path: string): number => (path === "" ? 0 : path.split("/").length);
	const minDepth = Math.min(...levelDats.map(depthOf));
	const roots = levelDats.filter((path) => depthOf(path) === minDepth).sort();

	const dirs = new Set(
		listing.entries.map((entry) => (entry.directory ? entry.name.replace(/\/$/, "") : dirOf(entry.name))),
	);

	const findings: WorldFinding[] = [];
	const primary = pickPrimaryRoot(roots, dirs);
	const sourceLevel = primary === "" ? "" : baseOf(primary);

	const sources: Partial<Record<DimensionKind, string>> = { overworld: "" };
	let archiveLayout: ArchiveLayout = "overworld-only";

	const nestedNether = dirs.has(joinPrefix(primary, NETHER_DIR));
	const nestedEnd = dirs.has(joinPrefix(primary, END_DIR));

	if (nestedNether || nestedEnd) {
		archiveLayout = "nested";

		if (nestedNether) {
			sources.nether = NETHER_DIR;
		}

		if (nestedEnd) {
			sources.end = END_DIR;
		}
	}

	// a Bukkit split lives beside the overworld, so it is looked for one level up
	const parent = primary === "" ? "" : dirOf(primary);
	const splitNether = `${sourceLevel}${NETHER_SUFFIX}`;
	const splitEnd = `${sourceLevel}${END_SUFFIX}`;

	if (sourceLevel !== "" && roots.includes(joinPrefix(parent, splitNether))) {
		archiveLayout = "split";
		sources.nether = `../${splitNether}`;
	}

	if (sourceLevel !== "" && roots.includes(joinPrefix(parent, splitEnd))) {
		archiveLayout = "split";
		sources.end = `../${splitEnd}`;
	}

	if (archiveLayout === "overworld-only") {
		findings.push({ code: "overworld-only", level: "info" });
	}

	const levelDatEntry = listing.entries.find((entry) => entry.name === joinPrefix(primary, LEVEL_DAT));
	let levelInfo: LevelInfo | undefined;

	if (levelDatEntry) {
		levelInfo = await readArchivedLevelDat(archivePath, levelDatEntry.name).catch(() => undefined);
	}

	if (!levelInfo) {
		findings.push({ code: "level-dat-unreadable", level: "warning" });
	} else if (!levelInfo.mcVersion) {
		findings.push({ code: "version-unknown", level: "warning" });
	}

	const packPrefix = joinPrefix(primary, "datapacks");
	const datapacks = listing.entries
		.filter((entry) => !entry.directory && dirOf(entry.name) === packPrefix)
		.map((entry) => baseOf(entry.name))
		.filter((file) => file.toLowerCase().endsWith(".zip"))
		.sort();

	if (levelInfo) {
		const missing = missingPacks(levelInfo, datapacks);

		if (missing.length > 0) {
			findings.push({
				code: "datapack-missing",
				level: "warning",
				params: { packs: missing.join(", "), count: String(missing.length) },
			});
		}
	}

	if (listing.entries.some((entry) => SERVER_MARKERS.includes(baseOf(entry.name)))) {
		findings.push({ code: "server-files", level: "info" });
	}

	return {
		archiveLayout,
		rootPath: primary,
		sourceLevel,
		sources,
		level_dat: levelInfo,
		datapacks,
		fileCount: listing.fileCount,
		totalBytes: listing.totalBytes,
		findings,
	};
}

/** Join a prefix and a name, tolerating an empty prefix at the archive root. */
function joinPrefix(prefix: string, name: string): string {
	return prefix === "" ? name : `${prefix}/${name}`;
}

/**
 * Which of several equally shallow world roots is the overworld.
 *
 * A Bukkit split gives three, and the overworld is the one whose name the other
 * two are suffixed forms of. Falling back to the first alphabetically is not a
 * guess worth agonising over: it is only reached when the names do not follow
 * the convention, and the console lets the operator override the choice.
 */
function pickPrimaryRoot(roots: string[], dirs: Set<string>): string {
	for (const root of roots) {
		const name = baseOf(root);

		if (name.endsWith(NETHER_SUFFIX) || name.endsWith(END_SUFFIX)) {
			continue;
		}

		const parent = dirOf(root);

		if (
			roots.includes(joinPrefix(parent, `${name}${NETHER_SUFFIX}`)) ||
			roots.includes(joinPrefix(parent, `${name}${END_SUFFIX}`)) ||
			dirs.has(joinPrefix(root, NETHER_DIR)) ||
			dirs.has(joinPrefix(root, END_DIR))
		) {
			return root;
		}
	}

	return roots.find((root) => !baseOf(root).endsWith(NETHER_SUFFIX) && !baseOf(root).endsWith(END_SUFFIX)) ?? roots[0]!;
}

/** Data packs `level.dat` has switched on that the archive does not carry. */
function missingPacks(info: LevelInfo, present: string[]): string[] {
	const have = new Set(present.map((file) => file.toLowerCase()));

	return info.enabledPacks
		// only `file/` packs are files at all; "vanilla" and "paper" are built in
		.filter((name) => name.startsWith("file/"))
		.map((name) => name.slice("file/".length))
		.filter((name) => !have.has(name.toLowerCase()) && !have.has(`${name.toLowerCase()}.zip`));
}

/** The refusal for an archive with no world in it, saying what was there instead. */
function describeMissingWorld(entries: ArchiveEntry[]): string {
	const marker = entries.find((entry) => SERVER_MARKERS.includes(baseOf(entry.name)));

	if (marker) {
		return t("core.world.archiveIsServerDir", { file: marker.name });
	}

	const sample = entries
		.filter((entry) => !entry.directory)
		.slice(0, 3)
		.map((entry) => entry.name)
		.join(", ");

	return t("core.world.archiveNoLevelDat", { sample: sample || t("core.world.nothing") });
}

/** Pull one `level.dat` out of an archive without extracting the rest. */
async function readArchivedLevelDat(archivePath: string, member: string): Promise<LevelInfo> {
	const proc = Bun.spawn(["unzip", "-p", "--", archivePath, member], {
		stdout: "pipe",
		stderr: "ignore",
	});

	const raw = new Uint8Array(await new Response(proc.stdout).arrayBuffer());

	await proc.exited;

	if (raw.length === 0 || raw.length > MAX_LEVEL_DAT_BYTES) {
		throw new Error(t("core.world.levelDatUnreadable"));
	}

	return decodeLevelDat(raw);
}

// --- planning the import ------------------------------------------------------

/** One directory move the import performs after extraction. */
export interface WorldMove {
	kind: DimensionKind;
	/** Path inside the extracted staging tree */
	from: string;
	/** Path relative to the instance directory */
	to: string;
	/** A `level.dat` must be synthesised here; a split sibling needs its own */
	copyLevelDat?: boolean;
}

/** What an import will do, as data, so it can be shown before it is done. */
export interface WorldImportPlan {
	targetLevel: string;
	targetLayout: WorldLayout;
	moves: WorldMove[];
	/** Directories under the instance this will replace */
	replaces: string[];
	findings: WorldFinding[];
}

/** Where the import is going. */
export interface WorldTarget {
	level: string;
	layout: WorldLayout;
	/** The target's Minecraft version, for the compatibility verdict */
	mcVersion?: string;
}

/**
 * Map an archive's world onto a target instance, converting layouts as needed.
 *
 * The conversion is the point. A vanilla world dropped onto Paper has to have
 * its `DIM-1` and `DIM1` lifted out into `<level>_nether` and `<level>_the_end`
 * (each of which needs its own `level.dat`, which Bukkit writes per world), and
 * a Paper world dropped onto Fabric has to have them folded back in. Getting it
 * wrong leaves a nether nobody can reach and nothing in any log about it.
 */
export function planWorldImport(scan: WorldScan, target: WorldTarget): WorldImportPlan {
	const findings = [...scan.findings, ...compatibilityFindings(scan.level_dat, target)];
	const moves: WorldMove[] = [];
	const level = target.level;

	// every `from` is relative to the extraction root, so it is built from the
	// archive-relative root path; using the bare level name would silently move
	// the wrong directory whenever the world sits inside a wrapper folder
	const sourceOf = (kind: DimensionKind): string | undefined => {
		const rel = scan.sources[kind];

		if (rel === undefined) {
			return undefined;
		}

		// "../x" is how a split sibling is recorded, since it lives beside the
		// overworld rather than inside it
		if (rel.startsWith("../")) {
			return joinPrefix(dirOf(scan.rootPath), rel.slice(3));
		}

		return rel === "" ? scan.rootPath : joinPrefix(scan.rootPath, rel);
	};

	const overworld = sourceOf("overworld");

	if (overworld !== undefined) {
		moves.push({ kind: "overworld", from: overworld, to: level });
	}

	for (const kind of ["nether", "end"] as const) {
		const from = sourceOf(kind);

		if (from === undefined) {
			continue;
		}

		const to = dimensionPath(target.layout, level, kind);
		const sourceIsSplit = (scan.sources[kind] ?? "").startsWith("../");

		if (target.layout === "split" && !sourceIsSplit) {
			// nested → split: the dimension folder keeps its vanilla name inside
			// the new sibling directory, and that sibling needs a level.dat of
			// its own because Bukkit treats it as a world in its own right
			moves.push({
				kind,
				from,
				to: join(to, kind === "nether" ? NETHER_DIR : END_DIR),
				copyLevelDat: true,
			});

			continue;
		}

		if (target.layout === "nested" && sourceIsSplit) {
			// split → nested: reach past the sibling's own wrapper for the
			// dimension folder that actually holds the region data
			moves.push({ kind, from: joinPrefix(from, kind === "nether" ? NETHER_DIR : END_DIR), to });

			continue;
		}

		moves.push({ kind, from, to });
	}

	return {
		targetLevel: level,
		targetLayout: target.layout,
		moves,
		replaces: worldDirNames(target.layout, level),
		findings,
	};
}

/**
 * Whether a world can be opened by the server that is about to get it.
 *
 * The two directions are not symmetric, which is the whole reason this is not
 * one comparison. A world from a later version simply will not load. A world
 * from an earlier one loads fine and is *converted on the way*, irreversibly;
 * across 1.13 that is a rewrite of every chunk. Both deserve to be said out
 * loud, but only the first is a refusal.
 */
function compatibilityFindings(info: LevelInfo | undefined, target: WorldTarget): WorldFinding[] {
	if (!info?.mcVersion || !target.mcVersion) {
		return [];
	}

	const order = compareMcVersionsDesc(info.mcVersion, target.mcVersion);

	if (order === 0) {
		return [];
	}

	// descending comparator: a negative result means the world sorts first, so
	// the world is the newer of the two
	if (order < 0) {
		return [
			{
				code: "version-newer",
				level: "error",
				params: { world: info.mcVersion, target: target.mcVersion },
			},
		];
	}

	return [
		{
			code: "version-older",
			level: "warning",
			params: { world: info.mcVersion, target: target.mcVersion },
		},
	];
}

/** Whether any finding forbids the import outright. */
export function planBlocked(findings: WorldFinding[]): boolean {
	return findings.some((finding) => finding.level === "error");
}

/** Files a world carries that a backup and an import both leave behind. */
export function isTransient(name: string): boolean {
	return TRANSIENT_FILES.has(name);
}

/** Every file of a world on disk, ready to be handed to `createArchive`. */
export async function worldSources(
	dir: string,
	layout: WorldLayout,
	level: string,
): Promise<Awaited<ReturnType<typeof walkFiles>>> {
	const out: Awaited<ReturnType<typeof walkFiles>> = [];

	for (const rel of worldDirNames(layout, level)) {
		if (!existsSync(join(dir, rel))) {
			continue;
		}

		const files = await walkFiles(dir, rel);

		out.push(...files.filter((file) => !isTransient(baseOf(file.rel))));
	}

	return out;
}
