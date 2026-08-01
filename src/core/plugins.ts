import { readdir, rm, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";

import type { ClusterConfig, PluginEntry, PluginsLock } from "./types";
import { expandTargets, instanceDir, managedInstances, poolDir } from "./config";
import { effectiveTargets, familyMatches, familyOf } from "./families";
import * as mr from "./services/modrinth";
import type { ProgressReporter } from "./progress";

/** Modrinth loader facets a side accepts — a paper server also loads bukkit/spigot jars. */
export function loadersFor(loader: "paper" | "velocity"): string[] {
	return loader === "paper" ? mr.PAPER_LOADERS : mr.VELOCITY_LOADERS;
}

/** Lockfile key for a pool jar: its file name, lowercased and without `.jar`. */
export function entryNameFor(file: string): string {
	return basename(file, ".jar").toLowerCase();
}

/** Guess which side a jar belongs to from its file name. */
function guessLoader(file: string): "paper" | "velocity" {
	return /velocity/i.test(file) ? "velocity" : "paper";
}

/** Jar file names directly inside a directory. Missing directories list as empty. */
async function listJars(dir: string): Promise<string[]> {
	if (!existsSync(dir)) {
		return [];
	}

	return (await readdir(dir)).filter((file) => file.toLowerCase().endsWith(".jar"));
}

export interface ScanReport {
	added: string[];
	updatedHash: string[];
	identified: Array<{ name: string; slug: string; version: string }>;
	unidentified: string[];
	luna: string[];
	caseMismatches: Array<{ instance: string; actual: string; expected: string }>;
	unmanaged: Array<{ instance: string; file: string }>;
	removedEntries: string[];
}

/**
 * Scan the common pool + all instance plugin folders; build/refresh the lockfile.
 * - identifies pool jars on Modrinth by sha512
 * - seeds `targets` from which instances contain the jar (by name, case-insensitive, or hash)
 * - reports case mismatches and instance-only (unmanaged) jars
 */
export async function scan(cfg: ClusterConfig, lock: PluginsLock): Promise<ScanReport> {
	const report: ScanReport = {
		added: [],
		updatedHash: [],
		identified: [],
		unidentified: [],
		luna: [],
		caseMismatches: [],
		unmanaged: [],
		removedEntries: [],
	};

	const pool = poolDir();
	const poolJars = await listJars(pool);
	const insts = managedInstances(cfg);

	const poolHashes = new Map<string, string>();

	for (const jar of poolJars) {
		poolHashes.set(jar, await mr.sha512File(join(pool, jar)));
	}

	// Index instance jars: name(lower) -> {instance, actualName, hash}
	const instJars = new Map<string, Array<{ instance: string; actual: string; hash: string }>>();

	for (const [name, inst] of Object.entries(insts)) {
		const dir = join(instanceDir(inst), "plugins");

		for (const jar of await listJars(dir)) {
			const hash = await mr.sha512File(join(dir, jar));
			const key = jar.toLowerCase();

			if (!instJars.has(key)) {
				instJars.set(key, []);
			}

			instJars.get(key)!.push({ instance: name, actual: jar, hash });
		}
	}

	// Drop lock entries whose pool file disappeared
	for (const [name, entry] of Object.entries(lock.plugins)) {
		if (!poolJars.includes(entry.file)) {
			delete lock.plugins[name];
			report.removedEntries.push(name);
		}
	}

	const slugCache = new Map<string, string>();

	for (const jar of poolJars) {
		const name = entryNameFor(jar);
		const hash = poolHashes.get(jar)!;
		const isLuna = jar.toLowerCase().startsWith("luna-");

		let entry = lock.plugins[name];
		const isNew = !entry;

		if (!entry) {
			entry = {
				file: jar,
				source: isLuna ? "luna" : "manual",
				loader: guessLoader(jar),
				autoUpdate: !isLuna,
				targets: [],
			};

			lock.plugins[name] = entry;
			report.added.push(name);
		}

		const hashChanged = entry.installed?.sha512 !== hash;

		if (hashChanged && !isNew) {
			report.updatedHash.push(name);

			// jar content moved — the cached descriptor and log names are stale
			delete entry.aliases;
			delete entry.meta;
		}

		// Identify on Modrinth (skip luna, skip when hash unchanged and already identified with a channel)
		const needsLookup =
			hashChanged ||
			!entry.modrinth ||
			(entry.source === "modrinth" && entry.channel === undefined);

		if (entry.source !== "luna" && needsLookup) {
			const version = await mr.lookupByHash(hash);

			if (version) {
				let slug = slugCache.get(version.project_id);

				if (!slug) {
					const project = await mr.getProject(version.project_id);

					slug = project?.slug ?? version.project_id;
					slugCache.set(version.project_id, slug);
				}

				entry.source = "modrinth";
				entry.modrinth = { projectId: version.project_id, slug };

				entry.installed = {
					versionId: version.id,
					versionNumber: version.version_number,
					sha512: hash,
				};

				// Accept the channel this jar was installed from (e.g. geyser ships betas).
				entry.channel = version.version_type ?? "release";

				const velocityOnly =
					version.loaders.includes("velocity") &&
					!version.loaders.some((loader) => mr.PAPER_LOADERS.includes(loader));

				if (velocityOnly) {
					entry.loader = "velocity";
				}

				report.identified.push({ name, slug, version: version.version_number });
			} else {
				entry.installed = { ...(entry.installed ?? {}), sha512: hash };

				if (entry.source !== "manual") {
					entry.source = "manual";
				}

				report.unidentified.push(name);
			}
		} else {
			entry.installed = { ...(entry.installed ?? {}), sha512: hash };

			if (entry.source === "luna") {
				report.luna.push(name);
			}
		}

		// Seed targets from instance folders (match by lowercased filename)
		const found = instJars.get(jar.toLowerCase()) ?? [];
		const targets = new Set(entry.targets.filter((target) => target.startsWith("*")));

		for (const hit of found) {
			targets.add(hit.instance);

			if (hit.actual !== jar) {
				report.caseMismatches.push({
					instance: hit.instance,
					actual: hit.actual,
					expected: jar,
				});
			}
		}

		// keep manually-set targets that still exist
		for (const target of entry.targets) {
			if (target.startsWith("*") || insts[target]) {
				targets.add(target);
			}
		}

		entry.targets = [...targets].sort();

		// drop assignments/pins for instances that no longer exist
		for (const record of [entry.assign, entry.pins]) {
			if (!record) {
				continue;
			}

			for (const target of Object.keys(record)) {
				if (!insts[target]) {
					delete record[target];
				}
			}
		}

		pruneVariants(name, entry);
	}

	// Unmanaged: instance jars with no pool counterpart
	const poolLower = new Set(poolJars.map((jar) => jar.toLowerCase()));

	for (const [key, entries] of instJars) {
		if (poolLower.has(key)) {
			continue;
		}

		for (const hit of entries) {
			report.unmanaged.push({ instance: hit.instance, file: hit.actual });
		}
	}

	report.unmanaged.sort(
		(a, b) => a.instance.localeCompare(b.instance) || a.file.localeCompare(b.file),
	);

	return report;
}

/** Fetch the Modrinth version list for an entry (helper for pin dialogs etc.). */
export async function getVersionsForEntry(entry: PluginEntry): Promise<mr.MrVersion[]> {
	if (!entry.modrinth) {
		return [];
	}

	return await mr.getVersions(entry.modrinth.projectId, loadersFor(entry.loader));
}

/** The version an instance currently gets for an entry (pin > auto-assign > primary). */
export function assignedVersion(entry: PluginEntry, instance: string): string | undefined {
	return entry.pins?.[instance] ?? entry.assign?.[instance] ?? entry.installed?.versionNumber;
}

/** Pool subdirectory holding the non-primary builds. */
function variantsDir(): string {
	return join(poolDir(), "versions");
}

/** File name of a pooled variant, with anything path-unsafe folded to `_`. */
function variantFileName(name: string, versionNumber: string): string {
	return `${name}@${versionNumber.replace(/[^\w.+-]/g, "_")}.jar`;
}

/** One resolved version group: these targets should run this Modrinth version. */
export interface ResolvedGroup {
	version: mr.MrVersion;
	targets: string[];
	/** true = becomes the pool primary (entry.file); false = stored as a variant */
	isPrimary: boolean;
	/** targets whose currently assigned version differs from this resolution */
	changedTargets: string[];
}

export interface Holdback {
	targets: string[];
	current?: string;
	reason: string;
}

export interface EntryResolution {
	groups: ResolvedGroup[];
	holdbacks: Holdback[];
	pinned: Array<{ target: string; version: string }>;
}

/**
 * Per-target version resolution: each target independently gets the newest
 * acceptable version compatible with ITS MC version (older backends may
 * resolve to an older plugin version than newer ones). Pinned targets are
 * left alone. `targets` overrides the entry's own resolution — callers with a
 * lockfile pass `effectiveTargets` so group coverage resolves too.
 */
export function resolveEntry(
	cfg: ClusterConfig,
	entry: PluginEntry,
	versions: mr.MrVersion[],
	targets?: string[],
): EntryResolution {
	const insts = managedInstances(cfg);
	const channel = entry.channel ?? "release";
	const byVersion = new Map<string, mr.MrVersion>();
	const groupTargets = new Map<string, string[]>();
	const holdbacks: Holdback[] = [];
	const pinned: Array<{ target: string; version: string }> = [];

	for (const target of targets ?? expandTargets(cfg, entry.targets)) {
		const inst = insts[target];

		if (!inst) {
			continue;
		}

		const pin = entry.pins?.[target];

		if (pin) {
			pinned.push({ target, version: pin });

			continue;
		}

		// Only paper-side builds on a paper backend carry an MC-version requirement;
		// velocity builds are version-independent. Universal jars count when they
		// land on a paper backend.
		const required =
			familyMatches(familyOf(entry), "paper") && inst.software === "paper" && inst.mcVersion
				? [inst.mcVersion]
				: [];

		const { best } = mr.pickCompatible(versions, required, { channel });

		if (!best) {
			holdbacks.push({
				targets: [target],
				current: assignedVersion(entry, target),
				reason: `no ${channel}-channel version supports MC ${required.join("/") || "?"}`,
			});

			continue;
		}

		byVersion.set(best.id, best);

		if (!groupTargets.has(best.id)) {
			groupTargets.set(best.id, []);
		}

		groupTargets.get(best.id)!.push(target);
	}

	// merge single-target holdbacks with identical reasons
	const merged: Holdback[] = [];

	for (const holdback of holdbacks) {
		const same = merged.find(
			(other) => other.reason === holdback.reason && other.current === holdback.current,
		);

		if (same) {
			same.targets.push(...holdback.targets);
		} else {
			merged.push(holdback);
		}
	}

	const newestFirst = [...byVersion.values()].sort(
		(a, b) => new Date(b.date_published).getTime() - new Date(a.date_published).getTime(),
	);

	const groups: ResolvedGroup[] = newestFirst.map((version, index) => {
		const targets = groupTargets.get(version.id)!;

		return {
			version,
			targets: [...targets].sort(),
			isPrimary: index === 0,
			changedTargets: targets
				.filter((target) => assignedVersion(entry, target) !== version.version_number)
				.sort(),
		};
	});

	return { groups, holdbacks: merged, pinned };
}

export interface UpdateCandidate {
	name: string;
	entry: PluginEntry;
	resolution: EntryResolution;
	/** groups that require a download or reassignment */
	pendingGroups: ResolvedGroup[];
}

/**
 * Resolve every lock entry against Modrinth and report what would change.
 * Passing `names` also overrides the per-entry `autoUpdate: false` opt-out, so an
 * explicit `plugins update <name>` still works on a pinned-back plugin.
 */
export async function checkUpdates(
	cfg: ClusterConfig,
	lock: PluginsLock,
	names?: string[],
): Promise<{
	candidates: UpdateCandidate[];
	skipped: Array<{ name: string; reason: string }>;
}> {
	const candidates: UpdateCandidate[] = [];
	const skipped: Array<{ name: string; reason: string }> = [];

	for (const [name, entry] of Object.entries(lock.plugins)) {
		if (names && !names.includes(name)) {
			continue;
		}

		if (entry.source === "luna") {
			skipped.push({ name, reason: "luna plugin (custom deployment)" });

			continue;
		}

		if (entry.source === "manual" || !entry.modrinth) {
			skipped.push({ name, reason: "not identified on modrinth" });

			continue;
		}

		if (!entry.autoUpdate && !names?.includes(name)) {
			skipped.push({ name, reason: "auto-update disabled" });

			continue;
		}

		const versions = await mr.getVersions(entry.modrinth.projectId, loadersFor(entry.loader));

		// backfill the primary's game-version requirement from modrinth data
		const installed = versions.find((version) => version.id === entry.installed?.versionId);

		if (installed && entry.installed && !entry.installed.gameVersions) {
			entry.installed.gameVersions = installed.game_versions;
		}

		const resolution = resolveEntry(cfg, entry, versions, effectiveTargets(cfg, lock, name));

		const pendingGroups = resolution.groups.filter((group) => {
			if (group.changedTargets.length > 0) {
				return true;
			}

			// same version number but a different jar: modrinth re-published the build
			return (
				group.isPrimary &&
				group.version.version_number === entry.installed?.versionNumber &&
				mr.primaryFile(group.version).hashes.sha512 !== entry.installed?.sha512
			);
		});

		if (pendingGroups.length || resolution.holdbacks.length) {
			candidates.push({ name, entry, resolution, pendingGroups });
		}
	}

	return { candidates, skipped };
}

/** Download every pending group of a candidate and record assignments. */
export async function applyUpdate(lock: PluginsLock, cand: UpdateCandidate): Promise<void> {
	const entry = cand.entry;

	for (const group of cand.pendingGroups) {
		const file = mr.primaryFile(group.version);

		if (group.isPrimary) {
			await mr.download(file.url, join(poolDir(), entry.file), file.hashes.sha512);

			entry.installed = {
				versionId: group.version.id,
				versionNumber: group.version.version_number,
				sha512: file.hashes.sha512,
				gameVersions: group.version.game_versions,
			};

			for (const target of group.targets) {
				delete entry.assign?.[target];
			}

			continue;
		}

		const variantFile = variantFileName(cand.name, group.version.version_number);

		await mkdir(variantsDir(), { recursive: true });
		await mr.download(file.url, join(variantsDir(), variantFile), file.hashes.sha512);

		entry.variants ??= {};
		entry.variants[group.version.version_number] = {
			versionId: group.version.id,
			versionNumber: group.version.version_number,
			sha512: file.hashes.sha512,
			file: variantFile,
			gameVersions: group.version.game_versions,
		};

		entry.assign ??= {};

		for (const target of group.targets) {
			entry.assign[target] = group.version.version_number;
		}
	}

	pruneVariants(cand.name, entry);
	lock.plugins[cand.name] = entry;
}

/** Drop pooled variants no pin/assign references anymore. */
function pruneVariants(name: string, entry: PluginEntry): void {
	if (!entry.variants) {
		return;
	}

	const referenced = new Set([
		...Object.values(entry.assign ?? {}),
		...Object.values(entry.pins ?? {}),
	]);

	for (const [versionNumber, variant] of Object.entries(entry.variants)) {
		if (referenced.has(versionNumber)) {
			continue;
		}

		const path = join(variantsDir(), variant.file);

		if (existsSync(path)) {
			rm(path).catch(() => {});
		}

		delete entry.variants[versionNumber];
	}

	if (Object.keys(entry.variants).length === 0) {
		delete entry.variants;
	}

	if (entry.assign && Object.keys(entry.assign).length === 0) {
		delete entry.assign;
	}

	if (entry.pins && Object.keys(entry.pins).length === 0) {
		delete entry.pins;
	}
}

/** Pin instances to a specific Modrinth version (downloads it as a pooled variant). */
export async function pinVersion(
	cfg: ClusterConfig,
	lock: PluginsLock,
	name: string,
	versionSpec: string,
	targets: string[],
	force = false,
): Promise<{ version: mr.MrVersion; incompatible: string[] }> {
	const entry = lock.plugins[name];

	if (!entry) {
		throw new Error(`unknown plugin: ${name}`);
	}

	if (!entry.modrinth) {
		throw new Error(`${name} is not a modrinth plugin — pinning needs modrinth version metadata`);
	}

	const versions = await mr.getVersions(entry.modrinth.projectId, loadersFor(entry.loader));
	const version = versions.find(
		(candidate) => candidate.version_number === versionSpec || candidate.id === versionSpec,
	);

	if (!version) {
		throw new Error(`version "${versionSpec}" not found for ${name}`);
	}

	const insts = managedInstances(cfg);
	const entryTargets = effectiveTargets(cfg, lock, name);
	const expanded = expandTargets(cfg, targets).filter((target) => entryTargets.includes(target));

	if (!expanded.length) {
		throw new Error(`none of [${targets.join(",")}] are targets of ${name}`);
	}

	const incompatible = expanded.filter((target) => {
		const inst = insts[target];

		return (
			entry.loader === "paper" &&
			inst?.mcVersion !== undefined &&
			version.game_versions.length > 0 &&
			!version.game_versions.includes(inst.mcVersion)
		);
	});

	// server-version gate per DESIGN.md — an explicit --force is the only way past it
	if (incompatible.length && !force) {
		const detail = incompatible
			.map((target) => `${target} (MC ${insts[target]?.mcVersion})`)
			.join(", ");

		throw new Error(
			`${name} ${version.version_number} supports [${version.game_versions.join(", ")}] — ` +
				`incompatible with: ${detail} (use --force to pin anyway)`,
		);
	}

	if (version.version_number !== entry.installed?.versionNumber) {
		const file = mr.primaryFile(version);
		const variantFile = variantFileName(name, version.version_number);

		await mkdir(variantsDir(), { recursive: true });
		await mr.download(file.url, join(variantsDir(), variantFile), file.hashes.sha512);

		entry.variants ??= {};
		entry.variants[version.version_number] = {
			versionId: version.id,
			versionNumber: version.version_number,
			sha512: file.hashes.sha512,
			file: variantFile,
			gameVersions: version.game_versions,
		};
	}

	entry.pins ??= {};

	for (const target of expanded) {
		entry.pins[target] = version.version_number;
		delete entry.assign?.[target];
	}

	pruneVariants(name, entry);

	return { version, incompatible };
}

/**
 * Make sure the pool holds a build of `name` that supports `mcVersion`,
 * downloading one from Modrinth when it does not — the "download compatible
 * version" action behind a group-validation warning. Returns the version that
 * now covers the MC version.
 */
export async function ensureVariantForMc(
	lock: PluginsLock,
	name: string,
	mcVersion: string,
): Promise<{ version: string; downloaded: boolean }> {
	const entry = lock.plugins[name];

	if (!entry) {
		throw new Error(`unknown plugin: ${name}`);
	}

	if (entry.installed?.gameVersions?.includes(mcVersion)) {
		return { version: entry.installed.versionNumber ?? "?", downloaded: false };
	}

	const pooled = Object.values(entry.variants ?? {}).find((variant) =>
		variant.gameVersions?.includes(mcVersion),
	);

	if (pooled) {
		return { version: pooled.versionNumber, downloaded: false };
	}

	if (!entry.modrinth) {
		throw new Error(`${name} has no Modrinth metadata — pool a compatible build manually`);
	}

	const versions = await mr.getVersions(entry.modrinth.projectId, loadersFor(entry.loader));
	const { best } = mr.pickCompatible(versions, [mcVersion], { channel: entry.channel ?? "release" });

	if (!best) {
		throw new Error(`no ${entry.channel ?? "release"}-channel build of ${name} supports MC ${mcVersion}`);
	}

	const file = mr.primaryFile(best);
	const variantFile = variantFileName(name, best.version_number);

	await mkdir(variantsDir(), { recursive: true });
	await mr.download(file.url, join(variantsDir(), variantFile), file.hashes.sha512);

	entry.variants ??= {};
	entry.variants[best.version_number] = {
		versionId: best.id,
		versionNumber: best.version_number,
		sha512: file.hashes.sha512,
		file: variantFile,
		gameVersions: best.game_versions,
	};

	return { version: best.version_number, downloaded: true };
}

/** Release version pins, for the given targets or for all of them. */
export function unpinVersion(
	cfg: ClusterConfig,
	lock: PluginsLock,
	name: string,
	targets?: string[],
): string[] {
	const entry = lock.plugins[name];

	if (!entry) {
		throw new Error(`unknown plugin: ${name}`);
	}

	if (!entry.pins) {
		return [];
	}

	const remove = targets ? expandTargets(cfg, targets) : Object.keys(entry.pins);
	const removed: string[] = [];

	for (const target of remove) {
		if (entry.pins[target] !== undefined) {
			delete entry.pins[target];
			removed.push(target);
		}
	}

	pruneVariants(name, entry);

	return removed;
}

export interface CompatRow {
	plugin: string;
	version?: string;
	status: "ok" | "incompatible" | "unknown";
	gameVersions?: string[];
	pinned: boolean;
}

/** Server-version requirement check: can `instance` (at mcVersion) run its assigned plugin builds? */
export function compatReport(
	cfg: ClusterConfig,
	lock: PluginsLock,
	instance: string,
	mcVersion: string,
): CompatRow[] {
	const rows: CompatRow[] = [];

	for (const [name, entry] of Object.entries(lock.plugins)) {
		// velocity-side builds carry no MC requirement; universal jars do when
		// they run on a paper backend
		if (!familyMatches(familyOf(entry), "paper")) {
			continue;
		}

		if (!effectiveTargets(cfg, lock, name).includes(instance)) {
			continue;
		}

		const version = assignedVersion(entry, instance);

		const gameVersions =
			(version && entry.variants?.[version]?.gameVersions) ||
			(version === entry.installed?.versionNumber ? entry.installed?.gameVersions : undefined);

		const status = !gameVersions || gameVersions.length === 0
			? "unknown"
			: gameVersions.includes(mcVersion)
				? "ok"
				: "incompatible";

		rows.push({
			plugin: name,
			version,
			status,
			gameVersions,
			pinned: entry.pins?.[instance] !== undefined,
		});
	}

	return rows.sort((a, b) => a.plugin.localeCompare(b.plugin));
}

export interface DeployAction {
	instance: string;
	file: string;
	action: "updated" | "installed" | "unchanged" | "renamed" | "missing-variant" | "config";
	detail?: string;
}

/** Source jar for one target: the pool primary, a pooled variant, or nothing yet. */
type DeploySource = { src: string; version?: string } | { missing: string };

/** Copy pool jars to instance plugin folders according to each entry's targets.
 *  Targets pinned/assigned to an older version receive that pooled variant
 *  (written under the same destination file name). */
export async function deploy(
	cfg: ClusterConfig,
	lock: PluginsLock,
	opts: { instances?: string[]; plugin?: string; reporter?: ProgressReporter } = {},
): Promise<DeployAction[]> {
	const actions: DeployAction[] = [];
	const insts = managedInstances(cfg);

	const entries = Object.entries(lock.plugins).filter(
		([name]) => !opts.plugin || opts.plugin === name,
	);

	const progress = opts.reporter;
	let seen = 0;

	for (const [name, entry] of entries) {
		seen += 1;
		progress?.info(seen / Math.max(1, entries.length), name);

		if (opts.plugin && opts.plugin !== name) {
			continue;
		}

		const primarySrc = join(poolDir(), entry.file);

		if (!existsSync(primarySrc)) {
			continue;
		}

		const hashCache = new Map<string, string>();

		const srcFor = (target: string): DeploySource => {
			let version = assignedVersion(entry, target);

			// The assigned build may not fit this backend's MC version (a fresh
			// instance on an old MC, before `plugins update` has resolved it). When a
			// pooled variant fits, deploy that and record the assignment so the choice
			// is stable — and so pruneVariants keeps the jar.
			const inst = insts[target];
			const mc = inst?.software === "paper" ? inst.mcVersion : undefined;

			if (mc && familyMatches(familyOf(entry), "paper")) {
				const assigned =
					version === entry.installed?.versionNumber
						? entry.installed?.gameVersions
						: entry.variants?.[version ?? ""]?.gameVersions;

				if (assigned?.length && !assigned.includes(mc)) {
					const fit = Object.values(entry.variants ?? {}).find((variant) =>
						variant.gameVersions?.includes(mc),
					);

					if (fit) {
						version = fit.versionNumber;
						entry.assign ??= {};
						entry.assign[target] = version;
					}
				}
			}

			if (!version || version === entry.installed?.versionNumber) {
				return { src: primarySrc, version: entry.installed?.versionNumber };
			}

			const variant = entry.variants?.[version];

			if (!variant) {
				return { missing: version };
			}

			const path = join(variantsDir(), variant.file);

			return existsSync(path) ? { src: path, version } : { missing: version };
		};

		for (const target of effectiveTargets(cfg, lock, name)) {
			if (opts.instances && !opts.instances.includes(target)) {
				continue;
			}

			const inst = insts[target];

			if (!inst) {
				continue;
			}

			const plugDir = join(instanceDir(inst), "plugins");

			if (!existsSync(plugDir)) {
				continue;
			}

			const resolved = srcFor(target);

			if ("missing" in resolved) {
				actions.push({
					instance: target,
					file: entry.file,
					action: "missing-variant",
					detail: `version ${resolved.missing} not pooled — run plugins update`,
				});

				continue;
			}

			const src = resolved.src;

			if (!hashCache.has(src)) {
				hashCache.set(src, await mr.sha512File(src));
			}

			const srcHash = hashCache.get(src)!;

			const detail =
				resolved.version && resolved.version !== entry.installed?.versionNumber
					? `variant ${resolved.version}`
					: undefined;

			const dest = join(plugDir, entry.file);

			// remove wrong-case duplicates
			const duplicates = (await listJars(plugDir)).filter(
				(jar) => jar.toLowerCase() === entry.file.toLowerCase() && jar !== entry.file,
			);

			let renamed = false;

			for (const duplicate of duplicates) {
				await rm(join(plugDir, duplicate));
				renamed = true;
			}

			if (!existsSync(dest)) {
				await copyFile(src, dest);

				actions.push({
					instance: target,
					file: entry.file,
					action: renamed ? "renamed" : "installed",
					detail,
				});

				continue;
			}

			if ((await mr.sha512File(dest)) === srcHash) {
				actions.push({
					instance: target,
					file: entry.file,
					action: renamed ? "renamed" : "unchanged",
					detail,
				});

				continue;
			}

			await copyFile(src, dest);

			actions.push({ instance: target, file: entry.file, action: "updated", detail });
		}
	}

	// converge config templates on every instance this pass touched, so a jar
	// never lands without the wiring it needs (DESIGN.md §3.3)
	const touched = [...new Set(actions.map((action) => action.instance))];

	const { applyTemplates, notableTemplateResults } = await import("./templates");

	for (const instance of touched) {
		const results = notableTemplateResults(await applyTemplates(cfg, lock, instance));

		for (const result of results) {
			actions.push({
				instance,
				file: result.file,
				action: "config",
				detail:
					`${result.plugin}: ${result.key ?? "file"} ${result.outcome}` +
					(result.detail ? ` (${result.detail})` : ""),
			});
		}
	}

	return actions;
}

/** Install a new plugin from Modrinth into the pool.
 *  Per-target resolution: older backends may receive an older variant. */
export async function installFromModrinth(
	cfg: ClusterConfig,
	lock: PluginsLock,
	project: mr.MrProject,
	loader: "paper" | "velocity",
	targets: string[],
): Promise<{ name: string; entry: PluginEntry; resolution: EntryResolution }> {
	// standardized scheme: key <plugin>@<family>, pool file <plugin>@<family>.jar
	const plugin = project.slug.toLowerCase();
	const name = `${plugin}@${loader}`;
	const file = `${name}.jar`;
	const versions = await mr.getVersions(project.id, loadersFor(loader));

	const entry: PluginEntry = {
		file,
		source: "modrinth",
		loader,
		plugin,
		family: loader,
		modrinth: { projectId: project.id, slug: project.slug },
		autoUpdate: true,
		targets,
	};

	// Prefer stable releases; fall back to beta, then alpha, for projects that never publish releases.
	let resolution = resolveEntry(cfg, entry, versions);

	for (const channel of ["beta", "alpha"] as const) {
		if (resolution.groups.length) {
			break;
		}

		entry.channel = channel;
		resolution = resolveEntry(cfg, entry, versions);
	}

	if (!resolution.groups.length) {
		const reasons = resolution.holdbacks
			.map((holdback) => `${holdback.targets.join(",")}: ${holdback.reason}`)
			.join("; ");

		throw new Error(
			`no installable version of ${project.slug} (${loader}): ${reasons || "no versions found"}`,
		);
	}

	if (entry.channel === "release") {
		delete entry.channel;
	}

	lock.plugins[name] = entry;

	await applyUpdate(lock, { name, entry, resolution, pendingGroups: resolution.groups });

	return { name, entry, resolution };
}

/** Adopt an instance-only jar into the common pool. */
export async function adopt(
	cfg: ClusterConfig,
	lock: PluginsLock,
	instance: string,
	jarName: string,
): Promise<PluginEntry> {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(`unknown instance: ${instance}`);
	}

	const src = join(instanceDir(inst), "plugins", jarName);

	if (!existsSync(src)) {
		throw new Error(`${jarName} not found in ${instance}/plugins`);
	}

	await copyFile(src, join(poolDir(), jarName));

	const entry: PluginEntry = {
		file: jarName,
		source: jarName.toLowerCase().startsWith("luna-") ? "luna" : "manual",
		loader: inst.software === "velocity" ? "velocity" : "paper",
		autoUpdate: false,
		targets: [instance],
		installed: { sha512: await mr.sha512File(src) },
	};

	lock.plugins[entryNameFor(jarName)] = entry;

	return entry;
}

/** Remove a plugin from targets (and their plugin folders); if no targets remain, drop pool file + entry. */
export async function removePlugin(
	cfg: ClusterConfig,
	lock: PluginsLock,
	name: string,
	fromTargets?: string[],
): Promise<{ deletedFrom: string[]; entryRemoved: boolean }> {
	const entry = lock.plugins[name];

	if (!entry) {
		throw new Error(`unknown plugin: ${name}`);
	}

	const insts = managedInstances(cfg);
	// removal must reach group-covered copies too, or the jars would linger
	const current = effectiveTargets(cfg, lock, name);
	const remove = fromTargets ? expandTargets(cfg, fromTargets) : current;
	const deletedFrom: string[] = [];

	for (const target of remove) {
		const inst = insts[target];

		if (!inst) {
			continue;
		}

		const dest = join(instanceDir(inst), "plugins", entry.file);

		if (existsSync(dest)) {
			await rm(dest);
			deletedFrom.push(target);
		}
	}

	for (const target of remove) {
		delete entry.assign?.[target];
		delete entry.pins?.[target];
	}

	const remaining = current.filter((target) => !remove.includes(target));

	if (remaining.length === 0) {
		const poolFile = join(poolDir(), entry.file);

		if (existsSync(poolFile)) {
			await rm(poolFile);
		}

		for (const variant of Object.values(entry.variants ?? {})) {
			const path = join(variantsDir(), variant.file);

			if (existsSync(path)) {
				await rm(path);
			}
		}

		delete lock.plugins[name];

		return { deletedFrom, entryRemoved: true };
	}

	entry.targets = remaining;
	pruneVariants(name, entry);

	return { deletedFrom, entryRemoved: false };
}
