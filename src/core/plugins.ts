import { readdir, rm, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";

import type { ClusterConfig, InstanceConfig, PluginEntry, PluginFamily, PluginsLock, ProviderId } from "./types";
import { t } from "../shared/i18n";
import type { AddonDir } from "./config";
import { addonDirForFamily, addonDirOf, expandTargets, instanceDir, managedInstances, poolDir } from "./config";
import { carriesMcRequirement, effectiveTargets, familyMatches, familyOf, pluginNameOf } from "./families";
import { download, sha512File } from "./services/download";
import * as modrinth from "./services/modrinth";
import type { AddonProject, AddonType, AddonVersion } from "./services/providers";
import {
	coversMc,
	getVersions,
	NEOFORGE_LOADERS,
	PAPER_LOADERS,
	pickCompatible,
	primaryFile,
	remoteRefFor,
	VELOCITY_LOADERS,
} from "./services/providers";
import type { ProgressReporter } from "./progress";
import type { IdentityMatch, IdentityProbe } from "./identify";
import {
	autoUpdateDefault,
	chosenMatch,
	installedFrom,
	localFile,
	probeIdentity,
} from "./identify";

/**
 * Loader facets a family's builds are published under; a paper server also
 * loads bukkit/spigot jars, a mod loader accepts only its own. A universal
 * jar is a paper build that happens to carry a velocity descriptor too, so the
 * paper facets are what find it.
 */
export function loadersFor(family: PluginFamily): string[] {
	if (family === "neoforge") {
		return NEOFORGE_LOADERS;
	}

	if (family === "velocity") {
		return VELOCITY_LOADERS;
	}

	return PAPER_LOADERS;
}

/**
 * Project type a family's builds are published as. Mods and plugins are
 * separate types upstream, and a search for one never returns the other.
 */
export function projectTypeFor(family: PluginFamily): AddonType {
	return family === "neoforge" ? "mod" : "plugin";
}

/** The version list of an entry's remote project, in its family's facets. */
async function remoteVersions(entry: PluginEntry): Promise<AddonVersion[]> {
	if (!entry.remote) {
		return [];
	}

	const family = familyOf(entry);

	return await getVersions(entry.remote, projectTypeFor(family), loadersFor(family));
}

/** Lockfile key for a pool jar: its file name, lowercased and without `.jar`. */
export function entryNameFor(file: string): string {
	return basename(file, ".jar").toLowerCase();
}

/** Pool file names under the standardized `<addon>@<family>.jar` scheme. */
const STANDARDIZED = /^(.+)@(paper|velocity|universal|neoforge)$/;

/**
 * The (name, family) a pool jar declares through its own file name. Undefined
 * for a jar that predates the standardized scheme; the caller then guesses.
 */
export function identityFromFile(file: string): { plugin: string; family: PluginFamily } | undefined {
	const match = entryNameFor(file).match(STANDARDIZED);

	if (!match) {
		return undefined;
	}

	return { plugin: match[1]!, family: match[2] as PluginFamily };
}

/** Guess which side a hand-dropped jar belongs to from its file name. */
function guessFamily(file: string): "paper" | "velocity" {
	return /velocity/i.test(file) ? "velocity" : "paper";
}

/** Jar file names directly inside a directory. Missing directories list as empty. */
async function listJars(dir: string): Promise<string[]> {
	if (!existsSync(dir)) {
		return [];
	}

	return (await readdir(dir)).filter((file) => file.toLowerCase().endsWith(".jar"));
}

/** Absolute path of the directory luna deploys an instance's addons into. */
export function instanceAddonDir(inst: InstanceConfig): string {
	return join(instanceDir(inst), addonDirOf(inst.software));
}

/** One addon jar found inside an instance's own addon directory. */
interface InstanceJar {
	instance: string;
	dir: AddonDir;
	actual: string;
	hash: string;
}

export interface ScanReport {
	added: string[];
	updatedHash: string[];
	identified: Array<{ name: string; slug: string; version: string }>;
	unidentified: string[];
	luna: string[];
	caseMismatches: Array<{ instance: string; dir: AddonDir; actual: string; expected: string }>;
	/** Instance jars that are a pooled build under the instance's own file name */
	recognized: Array<{ instance: string; dir: AddonDir; file: string; entry: string; plugin: string }>;
	unmanaged: Array<{ instance: string; dir: AddonDir; file: string }>;
	removedEntries: string[];
}

/**
 * Scan the common pool + every instance's addon directory (`plugins/`, or
 * `mods/` on a mod loader); build/refresh the lockfile.
 * - identifies pool jars on Modrinth by sha512
 * - seeds `targets` from the instances that already hold *our* build of a jar
 * - reports case mismatches and instance-only (unmanaged) jars
 *
 * "Ours" is deliberately narrow: the instance's copy has to be byte-identical
 * to a pooled build, or carry the standardized `<addon>@<family>.jar` name that
 * only a luna deploy writes. A server that was adopted with its own jars keeps
 * them; a name that merely happens to collide never pulls a stranger's file
 * under management (DESIGN.md: adoption leaves the directory alone).
 */
export async function scan(cfg: ClusterConfig, lock: PluginsLock): Promise<ScanReport> {
	const report: ScanReport = {
		added: [],
		updatedHash: [],
		identified: [],
		unidentified: [],
		luna: [],
		caseMismatches: [],
		recognized: [],
		unmanaged: [],
		removedEntries: [],
	};

	const pool = poolDir();
	const poolJars = await listJars(pool);
	const insts = managedInstances(cfg);

	const poolHashes = new Map<string, string>();

	for (const jar of poolJars) {
		poolHashes.set(jar, await sha512File(join(pool, jar)));
	}

	// Index instance jars twice: by name (a deployed copy keeps the pool's file
	// name) and by content (a renamed copy is still the same build)
	const instJars: InstanceJar[] = [];
	const byName = new Map<string, InstanceJar[]>();
	const byHash = new Map<string, InstanceJar[]>();

	for (const [name, inst] of Object.entries(insts)) {
		const dir = addonDirOf(inst.software);

		for (const jar of await listJars(join(instanceDir(inst), dir))) {
			const hash = await sha512File(join(instanceDir(inst), dir, jar));
			const found: InstanceJar = { instance: name, dir, actual: jar, hash };

			instJars.push(found);

			const nameKey = jar.toLowerCase();

			byName.set(nameKey, [...(byName.get(nameKey) ?? []), found]);
			byHash.set(hash, [...(byHash.get(hash) ?? []), found]);
		}
	}

	// instance/file pairs claimed by a lockfile entry; everything left over is
	// the instance's own business and gets reported, never adopted
	const claimed = new Set<string>();

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
		const identity = identityFromFile(jar);

		let entry = lock.plugins[name];
		const isNew = !entry;

		if (!entry) {
			entry = {
				file: jar,
				source: isLuna ? "luna" : "manual",
				// the file name already says which platform a standardized jar is
				// for; only a hand-dropped legacy name has to be guessed at
				plugin: identity?.plugin ?? name,
				family: identity?.family ?? guessFamily(jar),
				autoUpdate: !isLuna,
				targets: [],
			};

			lock.plugins[name] = entry;
			report.added.push(name);
		}

		const hashChanged = entry.installed?.sha512 !== hash;

		if (hashChanged && !isNew) {
			report.updatedHash.push(name);

			// jar content moved; the cached descriptor and log names are stale
			delete entry.aliases;
			delete entry.meta;
		}

		// Identify on Modrinth by hash: the one provider that can answer "what
		// is this jar". Skip luna, skip entries another provider owns, and skip
		// when the hash is unchanged and already identified with a channel.
		const needsLookup =
			hashChanged ||
			!entry.remote ||
			(entry.remote.provider === "modrinth" && entry.channel === undefined);

		if (entry.source !== "luna" && needsLookup) {
			const version = await modrinth.lookupByHash(hash);

			if (version) {
				let slug = slugCache.get(version.project_id);

				if (!slug) {
					const project = await modrinth.getProject(version.project_id);

					slug = project?.slug ?? version.project_id;
					slugCache.set(version.project_id, slug);
				}

				entry.source = "modrinth";
				entry.remote = { provider: "modrinth", projectId: version.project_id, slug };

				entry.installed = {
					versionId: version.id,
					versionNumber: version.version_number,
					sha512: hash,
				};

				// Accept the channel this jar was installed from (e.g. geyser ships betas).
				entry.channel = version.version_type ?? "release";

				const velocityOnly =
					version.loaders.includes("velocity") &&
					!version.loaders.some((loader) => PAPER_LOADERS.includes(loader));

				// a hash identification outranks a name guess, never the file name's
				// own declaration; a standardized jar already said what it is
				if (velocityOnly && isNew && !identity) {
					entry.family = "velocity";
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

		// Seed targets from the instances that already hold this build. A
		// standardized file name is proof on its own (luna wrote it, and a drifted
		// copy still belongs to us); anything else has to match by content.
		const dir = addonDirForFamily(familyOf(entry));
		const pooledHashes = new Set([hash, ...Object.values(entry.variants ?? {}).map((variant) => variant.sha512)]);

		const found = new Map<string, InstanceJar>();

		for (const pooled of pooledHashes) {
			for (const hit of byHash.get(pooled) ?? []) {
				found.set(`${hit.instance}/${hit.actual}`, hit);
			}
		}

		if (identity) {
			for (const hit of byName.get(jar.toLowerCase()) ?? []) {
				found.set(`${hit.instance}/${hit.actual}`, hit);
			}
		}

		const targets = new Set(entry.targets.filter((target) => target.startsWith("*")));

		for (const hit of found.values()) {
			// a copy sitting in the other kind's directory is not this build's
			// deployment; leave it to whichever entry actually owns that side
			if (hit.dir !== dir) {
				continue;
			}

			claimed.add(`${hit.instance}/${hit.dir}/${hit.actual}`);

			// Byte-identical but under the instance's own file name: ours by
			// content, not by deployment. Making it a target would have deploy
			// write the pool name beside it and the server would load the addon
			// twice, so this is offered as an action instead of done silently.
			if (hit.actual.toLowerCase() !== jar.toLowerCase()) {
				report.recognized.push({
					instance: hit.instance,
					dir: hit.dir,
					file: hit.actual,
					entry: name,
					plugin: pluginNameOf(name, entry),
				});

				continue;
			}

			targets.add(hit.instance);

			if (hit.actual !== jar) {
				report.caseMismatches.push({
					instance: hit.instance,
					dir: hit.dir,
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

	// Unmanaged: everything no entry claimed. These are the instance's own,
	// adopted with the server, hand-dropped, or shipped by a modpack, and scan
	// only ever reports them.
	for (const hit of instJars) {
		if (claimed.has(`${hit.instance}/${hit.dir}/${hit.actual}`)) {
			continue;
		}

		report.unmanaged.push({ instance: hit.instance, dir: hit.dir, file: hit.actual });
	}

	report.unmanaged.sort(
		(a, b) => a.instance.localeCompare(b.instance) || a.file.localeCompare(b.file),
	);

	report.recognized.sort(
		(a, b) => a.instance.localeCompare(b.instance) || a.file.localeCompare(b.file),
	);

	return report;
}

/** Fetch the provider's version list for an entry (helper for pin dialogs etc.). */
export async function getVersionsForEntry(entry: PluginEntry): Promise<AddonVersion[]> {
	return await remoteVersions(entry);
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

/** One resolved version group: these targets should run this provider version. */
export interface ResolvedGroup {
	version: AddonVersion;
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
 * left alone. `targets` overrides the entry's own resolution; callers with a
 * lockfile pass `effectiveTargets` so group coverage resolves too.
 */
export function resolveEntry(
	cfg: ClusterConfig,
	entry: PluginEntry,
	versions: AddonVersion[],
	targets?: string[],
): EntryResolution {
	const insts = managedInstances(cfg);
	const channel = entry.channel ?? "release";
	const byVersion = new Map<string, AddonVersion>();
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

		// Builds that land on a game server carry an MC-version requirement; a
		// paper plugin and a neoforge mod alike; velocity builds are
		// version-independent. Universal jars count when they land on a backend.
		const required =
			carriesMcRequirement(inst.software) &&
			familyMatches(familyOf(entry), inst.software) &&
			inst.mcVersion
				? [inst.mcVersion]
				: [];

		const { best } = pickCompatible(versions, required, { channel });

		if (!best) {
			holdbacks.push({
				targets: [target],
				current: assignedVersion(entry, target),
				reason: t("core.plugins.noChannelVersionForMc", { channel, mc: required.join("/") || "?" }),
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
 * Resolve every lock entry against its provider and report what would change.
 * Passing `names` also overrides the per-entry `autoUpdate: false` opt-out, so an
 * explicit `plugins update <name>` still works on a pinned-back plugin.
 *
 * One provider round trip per entry, so it reports live: the entries that cost a
 * query are counted first and each one reports twice: once as its request goes
 * out, once with what came back.
 */
export async function checkUpdates(
	cfg: ClusterConfig,
	lock: PluginsLock,
	names?: string[],
	opts: { reporter?: ProgressReporter } = {},
): Promise<{
	candidates: UpdateCandidate[];
	skipped: Array<{ name: string; reason: string }>;
}> {
	const candidates: UpdateCandidate[] = [];
	const skipped: Array<{ name: string; reason: string }> = [];
	const progress = opts.reporter;

	// classified up front so the progress denominator counts only the entries
	// that actually reach a provider; the skips are free
	const queryable: Array<[string, PluginEntry]> = [];

	for (const [name, entry] of Object.entries(lock.plugins)) {
		if (names && !names.includes(name)) {
			continue;
		}

		if (entry.source === "luna") {
			skipped.push({ name, reason: t("core.plugins.skipLuna") });

			continue;
		}

		if (entry.source === "manual" || !entry.remote) {
			skipped.push({ name, reason: t("core.plugins.skipUnidentified") });

			continue;
		}

		if (!entry.autoUpdate && !names?.includes(name)) {
			skipped.push({ name, reason: t("core.plugins.skipAutoOff") });

			continue;
		}

		queryable.push([name, entry]);
	}

	if (!queryable.length) {
		progress?.complete(
			skipped.length
				? t("core.plugins.nothingToCheckSkipped", { count: skipped.length })
				: t("core.plugins.nothingToCheck"),
		);

		return { candidates, skipped };
	}

	let checked = 0;

	for (const [name, entry] of queryable) {
		progress?.info(checked / queryable.length, t("core.plugins.asking", { name, provider: entry.remote!.provider }));

		const versions = await remoteVersions(entry);

		// backfill the primary's game-version requirement from provider data
		const installed = versions.find((version) => version.id === entry.installed?.versionId);

		if (installed && entry.installed && !entry.installed.gameVersions) {
			entry.installed.gameVersions = installed.game_versions;
		}

		const resolution = resolveEntry(cfg, entry, versions, effectiveTargets(cfg, lock, name));

		const pendingGroups = resolution.groups.filter((group) => {
			if (group.changedTargets.length > 0) {
				return true;
			}

			// same version number but a different jar: the provider re-published the
			// build (only detectable when it publishes a sha512, i.e. modrinth)
			const published = primaryFile(group.version).hashes.sha512;

			return (
				group.isPrimary &&
				group.version.version_number === entry.installed?.versionNumber &&
				published !== undefined &&
				published !== entry.installed?.sha512
			);
		});

		if (pendingGroups.length || resolution.holdbacks.length) {
			candidates.push({ name, entry, resolution, pendingGroups });
		}

		checked += 1;

		// what came back, per entry: the reason a check that finds nothing still
		// reads as work having happened
		const outcome = pendingGroups.length
			? `${pendingGroups.map((group) => group.version.version_number).join(", ")} available`
			: resolution.holdbacks.length
				? "held back"
				: "up to date";

		progress?.report(
			checked / queryable.length,
			resolution.holdbacks.length && !pendingGroups.length ? "warn" : "okay",
			`${name}: ${outcome}`,
		);
	}

	const updatable = candidates.filter((cand) => cand.pendingGroups.length).length;

	progress?.complete(
		updatable
			? t("core.plugins.checkedUpdates", { checked, updatable })
			: t("core.plugins.checkedUpToDate", { checked }),
	);

	return { candidates, skipped };
}

/** Download every pending group of a candidate and record assignments. */
export async function applyUpdate(lock: PluginsLock, cand: UpdateCandidate): Promise<void> {
	const entry = cand.entry;

	for (const group of cand.pendingGroups) {
		const file = primaryFile(group.version);

		if (group.isPrimary) {
			const sha512 = await download(file.url, join(poolDir(), entry.file), file.hashes);

			entry.installed = {
				versionId: group.version.id,
				versionNumber: group.version.version_number,
				sha512,
				gameVersions: group.version.game_versions,
			};

			for (const target of group.targets) {
				delete entry.assign?.[target];
			}

			continue;
		}

		const variantFile = variantFileName(cand.name, group.version.version_number);

		await mkdir(variantsDir(), { recursive: true });

		const sha512 = await download(file.url, join(variantsDir(), variantFile), file.hashes);

		entry.variants ??= {};
		entry.variants[group.version.version_number] = {
			versionId: group.version.id,
			versionNumber: group.version.version_number,
			sha512,
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

/** Pin instances to a specific provider version (downloads it as a pooled variant). */
export async function pinVersion(
	cfg: ClusterConfig,
	lock: PluginsLock,
	name: string,
	versionSpec: string,
	targets: string[],
	force = false,
): Promise<{ version: AddonVersion; incompatible: string[] }> {
	const entry = lock.plugins[name];

	if (!entry) {
		throw new Error(t("core.plugins.unknown", { name }));
	}

	if (!entry.remote) {
		throw new Error(t("core.plugins.pinNeedsProvider", { name }));
	}

	const versions = await remoteVersions(entry);
	const version = versions.find(
		(candidate) => candidate.version_number === versionSpec || candidate.id === versionSpec,
	);

	if (!version) {
		throw new Error(t("core.plugins.versionNotFound", { version: versionSpec, name }));
	}

	const insts = managedInstances(cfg);
	const entryTargets = effectiveTargets(cfg, lock, name);
	const expanded = expandTargets(cfg, targets).filter((target) => entryTargets.includes(target));

	if (!expanded.length) {
		throw new Error(t("core.plugins.notTargets", { targets: targets.join(","), name }));
	}

	const incompatible = expanded.filter((target) => {
		const inst = insts[target];

		if (!inst || !carriesMcRequirement(inst.software) || inst.mcVersion === undefined) {
			return false;
		}

		return version.game_versions.length > 0 && !coversMc(version.game_versions, inst.mcVersion);
	});

	// server-version gate per DESIGN.md; an explicit --force is the only way past it
	if (incompatible.length && !force) {
		const detail = incompatible
			.map((target) => `${target} (MC ${insts[target]?.mcVersion})`)
			.join(", ");

		throw new Error(
			t("core.plugins.pinIncompatible", {
				name,
				version: version.version_number,
				supported: version.game_versions.join(", "),
				detail,
			}),
		);
	}

	if (version.version_number !== entry.installed?.versionNumber) {
		const file = primaryFile(version);
		const variantFile = variantFileName(name, version.version_number);

		await mkdir(variantsDir(), { recursive: true });

		const sha512 = await download(file.url, join(variantsDir(), variantFile), file.hashes);

		entry.variants ??= {};
		entry.variants[version.version_number] = {
			versionId: version.id,
			versionNumber: version.version_number,
			sha512,
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
 * downloading one from the entry's provider when it does not; the "download
 * compatible version" action behind a group-validation warning. Returns the
 * version that now covers the MC version.
 */
export async function ensureVariantForMc(
	lock: PluginsLock,
	name: string,
	mcVersion: string,
): Promise<{ version: string; downloaded: boolean }> {
	const entry = lock.plugins[name];

	if (!entry) {
		throw new Error(t("core.plugins.unknown", { name }));
	}

	if (coversMc(entry.installed?.gameVersions, mcVersion)) {
		return { version: entry.installed?.versionNumber ?? "?", downloaded: false };
	}

	const pooled = Object.values(entry.variants ?? {}).find((variant) =>
		coversMc(variant.gameVersions, mcVersion),
	);

	if (pooled) {
		return { version: pooled.versionNumber, downloaded: false };
	}

	if (!entry.remote) {
		throw new Error(t("core.plugins.noProviderMeta", { name }));
	}

	const versions = await remoteVersions(entry);
	const { best } = pickCompatible(versions, [mcVersion], { channel: entry.channel ?? "release" });

	if (!best) {
		throw new Error(t("core.plugins.noBuildForMc", { channel: entry.channel ?? "release", name, mc: mcVersion }));
	}

	const file = primaryFile(best);
	const variantFile = variantFileName(name, best.version_number);

	await mkdir(variantsDir(), { recursive: true });

	const sha512 = await download(file.url, join(variantsDir(), variantFile), file.hashes);

	entry.variants ??= {};
	entry.variants[best.version_number] = {
		versionId: best.id,
		versionNumber: best.version_number,
		sha512,
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
		throw new Error(t("core.plugins.unknown", { name }));
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

/** Server-version requirement check: can `instance` (at mcVersion) run its assigned addon builds? */
export function compatReport(
	cfg: ClusterConfig,
	lock: PluginsLock,
	instance: string,
	mcVersion: string,
): CompatRow[] {
	const rows: CompatRow[] = [];
	const software = managedInstances(cfg)[instance]?.software ?? "paper";

	if (!carriesMcRequirement(software)) {
		return rows;
	}

	for (const [name, entry] of Object.entries(lock.plugins)) {
		// velocity-side builds carry no MC requirement; universal jars do when
		// they run on a backend, and every mod does
		if (!familyMatches(familyOf(entry), software)) {
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
			: coversMc(gameVersions, mcVersion)
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
	action: "updated" | "installed" | "unchanged" | "renamed" | "missing-variant" | "config" | "error";
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
			// is stable, and so pruneVariants keeps the jar.
			const inst = insts[target];
			const mc = inst && carriesMcRequirement(inst.software) ? inst.mcVersion : undefined;

			if (mc && inst && familyMatches(familyOf(entry), inst.software)) {
				const assigned =
					version === entry.installed?.versionNumber
						? entry.installed?.gameVersions
						: entry.variants?.[version ?? ""]?.gameVersions;

				if (assigned?.length && !coversMc(assigned, mc)) {
					const fit = Object.values(entry.variants ?? {}).find((variant) =>
						coversMc(variant.gameVersions, mc),
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

			// `mods/` on a mod loader, `plugins/` everywhere else; effectiveTargets
			// already guaranteed the build belongs in whichever one this is
			const addonDir = instanceAddonDir(inst);

			if (!existsSync(addonDir)) {
				continue;
			}

			const resolved = srcFor(target);

			if ("missing" in resolved) {
				actions.push({
					instance: target,
					file: entry.file,
					action: "missing-variant",
					detail: t("core.plugins.variantNotPooled", { version: resolved.missing }),
				});

				continue;
			}

			const src = resolved.src;

			if (!hashCache.has(src)) {
				hashCache.set(src, await sha512File(src));
			}

			const srcHash = hashCache.get(src)!;

			const detail =
				resolved.version && resolved.version !== entry.installed?.versionNumber
					? `variant ${resolved.version}`
					: undefined;

			const dest = join(addonDir, entry.file);

			// remove wrong-case duplicates
			const duplicates = (await listJars(addonDir)).filter(
				(jar) => jar.toLowerCase() === entry.file.toLowerCase() && jar !== entry.file,
			);

			let renamed = false;

			for (const duplicate of duplicates) {
				await rm(join(addonDir, duplicate));
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

			if ((await sha512File(dest)) === srcHash) {
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

/**
 * The resolution for an install with no targets: the plugin is being *pooled*,
 * not deployed, so no instance constrains the choice: take the newest build on
 * the channel as the pool primary. When the plugin later lands on an instance
 * (an explicit target, or an addon group), the per-instance resolution fetches
 * a fitting build for it exactly as it does for every other entry.
 */
function poolOnlyResolution(entry: PluginEntry, versions: AddonVersion[]): EntryResolution {
	const channel = entry.channel ?? "release";
	const { best } = pickCompatible(versions, [], { channel });

	if (!best) {
		return {
			groups: [],
			holdbacks: [{ targets: [], reason: t("core.plugins.noChannelVersion", { channel }) }],
			pinned: [],
		};
	}

	return {
		groups: [{ version: best, targets: [], isPrimary: true, changedTargets: [] }],
		holdbacks: [],
		pinned: [],
	};
}

/** Install a new plugin or mod from a provider into the pool.
 *  Per-target resolution: older backends may receive an older variant. */
export async function installFromProvider(
	cfg: ClusterConfig,
	lock: PluginsLock,
	provider: ProviderId,
	project: AddonProject,
	family: "paper" | "velocity" | "neoforge",
	targets: string[],
): Promise<{ name: string; entry: PluginEntry; resolution: EntryResolution }> {
	// standardized scheme: key <plugin>@<family>, pool file <plugin>@<family>.jar
	const plugin = project.slug.toLowerCase();
	const name = `${plugin}@${family}`;
	const file = `${name}.jar`;
	const remote = remoteRefFor(provider, project);
	const versions = await getVersions(remote, projectTypeFor(family), loadersFor(family));

	const entry: PluginEntry = {
		file,
		source: provider,
		plugin,
		family,
		remote,
		autoUpdate: true,
		targets,
	};

	// an install with no targets pools the jar and deploys nowhere
	const resolve = (): EntryResolution =>
		expandTargets(cfg, entry.targets).length
			? resolveEntry(cfg, entry, versions)
			: poolOnlyResolution(entry, versions);

	// Prefer stable releases; fall back to beta, then alpha, for projects that never publish releases.
	let resolution = resolve();

	for (const channel of ["beta", "alpha"] as const) {
		if (resolution.groups.length) {
			break;
		}

		entry.channel = channel;
		resolution = resolve();
	}

	if (!resolution.groups.length) {
		// a pool-only holdback names no target, so it is its own whole reason
		const reasons = resolution.holdbacks
			.map((holdback) =>
				holdback.targets.length ? `${holdback.targets.join(",")}: ${holdback.reason}` : holdback.reason,
			)
			.join("; ");

		throw new Error(
			t("core.plugins.noInstallable", {
				slug: project.slug,
				family,
				reasons: reasons || t("core.plugins.noVersionsFound"),
			}),
		);
	}

	if (entry.channel === "release") {
		delete entry.channel;
	}

	lock.plugins[name] = entry;

	await applyUpdate(lock, { name, entry, resolution, pendingGroups: resolution.groups });

	return { name, entry, resolution };
}

/** How an uploaded jar is identified and where it should land. */
export interface JarUpload {
	/** Plugin name, the identity half of the entry key */
	plugin: string;
	/** Platform the build runs on; decides the entry key's family suffix */
	family: PluginFamily;
	/** Instances (or wildcards) to deploy to; empty pools the jar only */
	targets?: string[];
	/** The jar itself, base64-encoded (the console cannot post multipart) */
	dataBase64: string;
}

/**
 * Decode an uploaded jar. A jar is a zip, so the magic check is the same one
 * the pack uploads use; enough to reject a wrong file picked by mistake
 * before it lands in the pool under a name something else will try to load.
 */
function decodeJar(dataBase64: string): Uint8Array {
	const buf = Uint8Array.from(atob(dataBase64), (char) => char.charCodeAt(0));
	const isZip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03;

	if (!isZip) {
		throw new Error(t("core.plugins.notAJar"));
	}

	return buf;
}

/**
 * Pool a jar uploaded from the console, under the standardized
 * `<plugin>@<family>` scheme with manual provenance, the same shape `scan`
 * and `adopt` produce, so everything downstream (deploy, groups, drift) treats
 * it like any other entry. Uploading over an existing entry replaces its file
 * and drops the version identity it no longer has.
 */
export async function uploadJar(
	cfg: ClusterConfig,
	lock: PluginsLock,
	opts: JarUpload,
): Promise<{ name: string; entry: PluginEntry }> {
	const plugin = opts.plugin.trim().toLowerCase();

	if (!/^[a-z0-9][a-z0-9_-]*$/.test(plugin)) {
		throw new Error(t("core.plugins.badPluginName"));
	}

	const targets = opts.targets ?? [];

	// reject a typo before anything is written
	expandTargets(cfg, targets);

	const buf = decodeJar(opts.dataBase64);
	const name = `${plugin}@${opts.family}`;
	const file = `${name}.jar`;

	await mkdir(poolDir(), { recursive: true });
	await Bun.write(join(poolDir(), file), buf);

	const existing = lock.plugins[name];

	const entry: PluginEntry = {
		...existing,
		file,
		source: plugin.startsWith("luna-") ? "luna" : "manual",
		plugin,
		family: opts.family,
		autoUpdate: false,
		targets: targets.length ? targets : (existing?.targets ?? []),
		installed: { sha512: await sha512File(join(poolDir(), file)) },
	};

	// an uploaded jar is not the provider build the entry used to track, so the
	// provenance that would make an "update" compare against it has to go
	delete entry.remote;
	delete entry.variants;
	delete entry.assign;
	delete entry.meta;
	delete entry.aliases;

	lock.plugins[name] = entry;

	return { name, entry };
}

/**
 * Adopt an instance-only jar into the common pool: the explicit way an addon
 * a server brought with it becomes managed. Nothing else does this: a scan
 * reports unmanaged jars and leaves them where they are, because a server that
 * was adopted with its own plugins or modpack is working and rewriting its
 * directory is how that stops being true.
 *
 * The jar keeps its file name so the instance's existing copy *is* the
 * deployment; no rename, no second jar the server would load twice.
 */
export async function adopt(
	cfg: ClusterConfig,
	lock: PluginsLock,
	instance: string,
	jarName: string,
): Promise<PluginEntry> {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name: instance }));
	}

	const dir = addonDirOf(inst.software);
	const src = join(instanceDir(inst), dir, jarName);

	if (!existsSync(src)) {
		throw new Error(t("core.plugins.jarNotFound", { jar: jarName, path: `${instance}/${dir}` }));
	}

	await copyFile(src, join(poolDir(), jarName));

	const identity = identityFromFile(jarName);

	const entry: PluginEntry = {
		file: jarName,
		source: jarName.toLowerCase().startsWith("luna-") ? "luna" : "manual",
		plugin: identity?.plugin ?? entryNameFor(jarName),
		// the jar runs on the software it was found under; a universal build is
		// only ever declared by hand, never guessed from one instance
		family: identity?.family ?? inst.software,
		autoUpdate: false,
		targets: [instance],
		installed: { sha512: await sha512File(src) },
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
		throw new Error(t("core.plugins.unknown", { name }));
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

		const dest = join(instanceAddonDir(inst), entry.file);

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

// -- provider mapping ----------------------------------------------------------

/**
 * What the operator is asking luna to record about a plugin's origin.
 */
export interface IdentifyPluginOptions {
	provider: ProviderId;
	/** Project slug or id at that provider */
	project: string;
	/** Version to record; omitted takes the probe's own best match */
	versionId?: string;
	/** Map the project but record no version at all */
	unidentified?: boolean;
	/** Overrides the auto-update default (on only for a proven version) */
	autoUpdate?: boolean;
}

/** A probe carrying the entry it was run for. */
export interface PluginIdentityProbe extends IdentityProbe {
	name: string;
	entry: PluginEntry;
}

/**
 * The pooled file of an entry, which is what a mapping has to identify, not the
 * copies in the instance directories, which deploy may not have caught up with.
 */
function poolFileOf(name: string, entry: PluginEntry): string {
	const path = join(poolDir(), entry.file);

	if (!existsSync(path)) {
		throw new Error(t("core.plugins.notInPool", { name, file: entry.file }));
	}

	return path;
}

/** An entry a mapping may touch at all, with the reason when it may not. */
function mappable(lock: PluginsLock, name: string): PluginEntry {
	const entry = lock.plugins[name];

	if (!entry) {
		throw new Error(t("core.plugins.unknown", { name }));
	}

	// an in-house jar has no upstream project: its provenance is the gradle
	// workspace, and pointing it at a provider would make `update` fight `luna sync`
	if (entry.source === "luna") {
		throw new Error(t("core.plugins.inHouseIdentify", { name }));
	}

	return entry;
}

/**
 * Grade what a plugin's pooled jar could be at one provider, without writing
 * anything. The console shows this before asking the operator to commit, and the
 * CLI prints it when a mapping is ambiguous.
 */
export async function probePluginIdentity(
	lock: PluginsLock,
	name: string,
	provider: ProviderId,
	project: string,
): Promise<PluginIdentityProbe> {
	const entry = mappable(lock, name);
	const local = await localFile(poolFileOf(name, entry), entry.file);

	const probe = await probeIdentity(
		provider,
		project,
		projectTypeFor(entry.family),
		local,
		loadersFor(entry.family),
	);

	return { ...probe, name, entry };
}

/**
 * Map a plugin luna already holds to the project it came from: the jar stays
 * exactly as it is (no download, no rename), and the entry gains the provenance
 * that makes update checks, channels and the downgrade guard apply to it.
 */
export async function identifyPlugin(
	cfg: ClusterConfig,
	lock: PluginsLock,
	name: string,
	opts: IdentifyPluginOptions,
): Promise<{ name: string; entry: PluginEntry; probe: PluginIdentityProbe; match?: IdentityMatch }> {
	const probe = await probePluginIdentity(lock, name, opts.provider, opts.project);
	const match = chosenMatch(probe, opts);
	const entry = probe.entry;

	entry.source = opts.provider;
	entry.remote = probe.remote;
	entry.installed = installedFrom(probe.local, match);
	entry.autoUpdate = opts.autoUpdate ?? autoUpdateDefault(match);

	// the mapped build's own channel, so a beta jar is not "updated" to the
	// newest release the moment it is identified
	if (match && match.channel !== "release") {
		entry.channel = match.channel;
	} else {
		delete entry.channel;
	}

	// the jar was never a provider build before, so nothing that describes one
	// may survive the mapping
	delete entry.variants;
	delete entry.assign;

	lock.plugins[name] = entry;

	return { name, entry, probe, match };
}

/**
 * Drop a plugin's provider mapping, back to a file luna simply has. The jar and
 * its deployments are untouched; what goes is the claim that an upstream project
 * says what this file should be.
 */
export async function forgetPluginIdentity(
	lock: PluginsLock,
	name: string,
): Promise<PluginEntry> {
	const entry = lock.plugins[name];

	if (!entry) {
		throw new Error(t("core.plugins.unknown", { name }));
	}

	if (entry.source === "luna") {
		throw new Error(t("core.plugins.inHouseForget", { name }));
	}

	entry.source = "manual";
	entry.autoUpdate = false;

	// the sha512 of what luna actually holds is the one fact that survives, so
	// drift detection keeps working; the pool is re-read when it was never recorded
	entry.installed = {
		sha512: entry.installed?.sha512 ?? (await sha512File(poolFileOf(name, entry))),
	};

	delete entry.remote;
	delete entry.channel;
	delete entry.variants;
	delete entry.assign;

	return entry;
}
