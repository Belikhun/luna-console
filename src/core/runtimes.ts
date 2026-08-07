// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { t } from "../shared/i18n";
import { buildPlatform } from "../version";
import { managedInstances, root } from "./config";
import { ProgressReporter } from "./progress";
import * as adoptium from "./services/adoptium";
import { downloadToFile } from "./services/download";
import * as graalvm from "./services/graalvm";
import type {
	AvailableRuntime,
	ClusterConfig,
	InstalledRuntime,
	InstanceConfig,
	JavaSelection,
	LocalRuntimeInventory,
	RuntimeConsumer,
	RuntimeVendor,
} from "./types";

/**
 * Java runtime manager: the JDKs luna installs, per machine, under
 * `<root>/.runtimes`.
 *
 * A runtime is named `<vendor>@<version>` the way jabba names one, and that id
 * is the whole handle: an instance or a java profile records it, every machine
 * that has to run it installs its own arch-specific build of it, and the
 * absolute path never leaves the machine holding it. That split is deliberate -
 * `javaSelection` decides *which* runtime from cluster config alone, so it
 * resolves the same on a client, while `runtimeJavaPath` reads the local root
 * and only ever runs inside the daemon that owns the instance.
 */

/** Directory under the cluster root holding every installed runtime. */
export const RUNTIMES_DIR = ".runtimes";

/** Metadata file written into each runtime directory at install time. */
export const RUNTIME_META = ".luna-runtime.json";

/** Distributions luna knows how to install. */
export const RUNTIME_VENDORS: RuntimeVendor[] = ["temurin", "temurin-jre", "graalvm-ce"];

/** Runtime ids: a vendor, "@", and a vendor-shaped version. */
const ID_PATTERN = /^[a-z][a-z0-9-]*@[A-Za-z0-9._+-]+$/;

/** How long a fetched catalog stays good; a vendor publishes a few times a year. */
const CATALOG_TTL_MS = 10 * 60_000;

const catalogCache = new Map<string, { at: number; rows: AvailableRuntime[] }>();

// -- identity ---------------------------------------------------------------

/**
 * This machine's platform in the vendors' own dialect. Node calls 64-bit ARM
 * `arm64`; Adoptium and GraalVM both call it `aarch64`, and the id is only
 * useful if it matches the archive that will be downloaded.
 */
export function runtimePlatform(): string {
	return buildPlatform().replace(/-arm64$/, "-aarch64");
}

/** Split a runtime id, or undefined when it is not one. */
export function parseRuntimeId(id: string): { vendor: RuntimeVendor; version: string } | undefined {
	if (!ID_PATTERN.test(id)) {
		return undefined;
	}

	const cut = id.indexOf("@");
	const vendor = id.slice(0, cut) as RuntimeVendor;

	if (!RUNTIME_VENDORS.includes(vendor)) {
		return undefined;
	}

	return { vendor, version: id.slice(cut + 1) };
}

/**
 * Directory name for a runtime id. Temurin build numbers carry a "+", which is
 * legal in a path but reads as an escape in half the tooling that will ever
 * touch it, so it is folded to "_" exactly as Adoptium folds it in its own
 * archive names. The mapping is one-way and never decoded: the canonical id is
 * read back from the directory's metadata file.
 */
export function runtimeDirName(id: string): string {
	return id.replace(/\+/g, "_");
}

/** Feature release of a version string: 21 for "21.0.5+11", 8 for "8u432-b06". */
export function runtimeFeature(version: string): number {
	return adoptium.featureOfVersion(version);
}

/** Reject an id that is not a runtime id, with the reason. */
export function validateRuntimeId(id: string): string | undefined {
	if (!id.trim()) {
		return t("core.runtimes.idEmpty");
	}

	if (!ID_PATTERN.test(id)) {
		return t("core.runtimes.idMalformed", { id });
	}

	if (!parseRuntimeId(id)) {
		return t("core.runtimes.unknownVendor", {
			id,
			vendors: RUNTIME_VENDORS.join(", "),
		});
	}

	return undefined;
}

/**
 * The Java feature release a Minecraft version needs. Mojang raised the floor
 * three times: 1.17 moved to 16, 1.18 to 17 and 1.20.5 to 21. The floor is
 * answered with the release luna would actually install, so 1.17 resolves to 17
 * rather than the long-withdrawn 16.
 */
export function suggestedFeature(mcVersion?: string): number {
	if (!mcVersion) {
		return 21;
	}

	const parts = mcVersion.split(".");
	const minor = Number.parseInt(parts[1] ?? "", 10);
	const patch = Number.parseInt(parts[2] ?? "0", 10) || 0;

	if (!minor) {
		return 21;
	}

	if (minor <= 16) {
		return 8;
	}

	if (minor < 20) {
		return 17;
	}

	if (minor === 20 && patch < 5) {
		return 17;
	}

	return 21;
}

// -- selection (pure; resolves identically on a client) ----------------------

/**
 * Which source decides this instance's java binary. An explicit path always
 * wins over a managed runtime, and the instance always wins over its profile,
 * so a profile can carry a runtime for everything using it while one instance
 * departs from it.
 */
export function javaSelection(cfg: ClusterConfig, inst: InstanceConfig): JavaSelection {
	const profile = cfg.javaProfiles[inst.profile];

	if (inst.java) {
		return { kind: "path", path: inst.java, source: "instance" };
	}

	if (inst.runtime) {
		return { kind: "runtime", id: inst.runtime, source: "instance" };
	}

	if (profile?.java) {
		return { kind: "path", path: profile.java, source: "profile" };
	}

	if (profile?.runtime) {
		return { kind: "runtime", id: profile.runtime, source: "profile" };
	}

	return { kind: "default" };
}

/**
 * Every runtime id the cluster asks for, and who asks. A profile is listed once
 * for itself and once per instance using it, because the machines that have to
 * hold the runtime are the instances' machines, not the profile's (it has none).
 */
export function runtimeConsumers(cfg: ClusterConfig): Record<string, RuntimeConsumer[]> {
	const out: Record<string, RuntimeConsumer[]> = {};

	const add = (id: string, consumer: RuntimeConsumer): void => {
		(out[id] ??= []).push(consumer);
	};

	for (const [name, profile] of Object.entries(cfg.javaProfiles)) {
		if (profile.runtime) {
			add(profile.runtime, { kind: "profile", name });
		}
	}

	for (const [name, inst] of Object.entries(managedInstances(cfg))) {
		const selection = javaSelection(cfg, inst);

		if (selection.kind !== "runtime") {
			continue;
		}

		add(selection.id, { kind: "instance", name, machine: inst.daemon ?? "" });
	}

	return out;
}

// -- local paths (daemon-side: reads this machine's own root) ----------------

/** Directory holding every runtime installed on this machine. */
export function runtimesDir(): string {
	return join(root(), RUNTIMES_DIR);
}

/** Where a runtime id lives on this machine, installed or not. */
export function runtimeHome(id: string): string {
	return join(runtimesDir(), runtimeDirName(id));
}

/** The java binary of a runtime id on this machine. */
export function runtimeJavaPath(id: string): string {
	return join(runtimeHome(id), "bin", "java");
}

/** Whether a runtime is installed here, judged by the binary that would run. */
export function isRuntimeInstalled(id: string): boolean {
	return existsSync(runtimeJavaPath(id));
}

/**
 * The java binary an instance runs on this machine, resolved all the way to a
 * path. Only ever called on the machine that owns the instance: a runtime's
 * path is local, and a follower's root is not the primary's.
 */
export function resolveJavaPath(cfg: ClusterConfig, inst: InstanceConfig): string {
	const selection = javaSelection(cfg, inst);

	if (selection.kind === "path") {
		return selection.path;
	}

	if (selection.kind === "runtime") {
		return runtimeJavaPath(selection.id);
	}

	return "java";
}

/** JAVA_HOME for an instance, or "" when it runs an unmanaged java. */
export function resolveJavaHome(cfg: ClusterConfig, inst: InstanceConfig): string {
	const selection = javaSelection(cfg, inst);

	if (selection.kind !== "runtime") {
		return "";
	}

	return runtimeHome(selection.id);
}

// -- catalog ----------------------------------------------------------------

/**
 * Every runtime the vendors publish for a platform, newest feature first.
 *
 * Adoptium answers one feature release per request, so the whole catalog is a
 * fan-out; it is cached because the launch wizard, the console screen and the
 * CLI all ask the same question within seconds of each other, and the answer
 * changes a handful of times a year.
 */
export async function listAvailableRuntimes(
	opts: { vendor?: RuntimeVendor; feature?: number; platform?: string; refresh?: boolean } = {},
): Promise<AvailableRuntime[]> {
	const platform = opts.platform ?? runtimePlatform();
	const cached = catalogCache.get(platform);

	let rows: AvailableRuntime[];

	if (!opts.refresh && cached && Date.now() - cached.at < CATALOG_TTL_MS) {
		rows = cached.rows;
	} else {
		rows = await fetchCatalog(platform);
		catalogCache.set(platform, { at: Date.now(), rows });
	}

	return rows.filter((row) => {
		if (opts.vendor && row.vendor !== opts.vendor) {
			return false;
		}

		if (opts.feature !== undefined && row.feature !== opts.feature) {
			return false;
		}

		return true;
	});
}

async function fetchCatalog(platform: string): Promise<AvailableRuntime[]> {
	const releases = await adoptium.availableReleases();
	const lts = new Set(releases.lts);
	const wanted: Array<Promise<AvailableRuntime[]>> = [];

	for (const feature of releases.available) {
		wanted.push(adoptium.latestRuntimes(feature, platform, "temurin"));
		wanted.push(adoptium.latestRuntimes(feature, platform, "temurin-jre"));
	}

	// a vendor being down is not a reason to show nothing: whatever answered is
	// still installable, and the row that is missing is the one nobody can reach
	wanted.push(graalvm.listGraalRuntimes(platform).catch(() => []));

	const settled = await Promise.allSettled(wanted);
	const rows: AvailableRuntime[] = [];

	for (const outcome of settled) {
		if (outcome.status !== "fulfilled") {
			continue;
		}

		for (const row of outcome.value) {
			rows.push(row.vendor === "graalvm-ce" ? row : { ...row, lts: lts.has(row.feature) });
		}
	}

	rows.sort((a, b) => {
		if (a.feature !== b.feature) {
			return b.feature - a.feature;
		}

		if (a.vendor !== b.vendor) {
			return a.vendor.localeCompare(b.vendor);
		}

		return b.version.localeCompare(a.version);
	});

	return rows;
}

/** One catalog entry by id, for this machine's platform. */
export async function findAvailableRuntime(
	id: string,
	platform?: string,
): Promise<AvailableRuntime | undefined> {
	const rows = await listAvailableRuntimes({ platform });

	return rows.find((row) => row.id === id);
}

// -- inventory --------------------------------------------------------------

/**
 * What this machine has installed. A directory without luna's metadata file is
 * skipped rather than guessed at: the id cannot be recovered from the directory
 * name once "+" has been folded, and inventing one would let a hand-copied JDK
 * masquerade as a managed runtime.
 */
export async function listInstalledRuntimes(): Promise<LocalRuntimeInventory> {
	const dir = runtimesDir();
	const platform = runtimePlatform();

	if (!existsSync(dir)) {
		return { platform, runtimes: [] };
	}

	const entries = await readdir(dir, { withFileTypes: true });
	const runtimes: InstalledRuntime[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".staging-")) {
			continue;
		}

		const meta = await readRuntimeMeta(join(dir, entry.name));

		if (!meta || !existsSync(runtimeJavaPath(meta.id))) {
			continue;
		}

		runtimes.push(meta);
	}

	runtimes.sort((a, b) => (a.feature === b.feature ? a.id.localeCompare(b.id) : b.feature - a.feature));

	return { platform, runtimes };
}

async function readRuntimeMeta(dir: string): Promise<InstalledRuntime | undefined> {
	const path = join(dir, RUNTIME_META);

	if (!existsSync(path)) {
		return undefined;
	}

	try {
		const raw = (await Bun.file(path).json()) as InstalledRuntime;

		if (!raw?.id || !parseRuntimeId(raw.id)) {
			return undefined;
		}

		// the paths are recomputed rather than read back, so a cluster root that
		// moved still resolves to where the runtime actually is now
		return {
			...raw,
			dirName: runtimeDirName(raw.id),
			javaPath: runtimeJavaPath(raw.id),
		};
	} catch {
		return undefined;
	}
}

// -- install ----------------------------------------------------------------

/**
 * Download, verify and unpack a runtime onto this machine.
 *
 * The whole thing reports as it goes, because a JDK is a few hundred megabytes
 * and the download is most of the wait: the archive's bytes drive the download
 * node's own progress, so a caller watching the tree sees megabytes move rather
 * than one step that sits still for a minute.
 *
 * Extraction lands in a staging directory and is renamed into place, so a
 * failed or interrupted install never leaves a half-unpacked runtime that
 * `isRuntimeInstalled` would call present.
 */
export async function installRuntime(
	id: string,
	opts: { force?: boolean; reporter?: ProgressReporter } = {},
): Promise<InstalledRuntime> {
	const invalid = validateRuntimeId(id);

	if (invalid) {
		throw new Error(invalid);
	}

	const progress = opts.reporter ?? new ProgressReporter(`install ${id}`);
	progress.weighOwn(0);

	if (!opts.force && isRuntimeInstalled(id)) {
		const existing = await readRuntimeMeta(runtimeHome(id));

		if (existing) {
			progress.complete(t("core.runtimes.alreadyInstalled", { id }));

			return existing;
		}
	}

	const resolving = progress.child(t("core.runtimes.phaseResolve"), 1);
	const fetching = progress.child(t("core.runtimes.phaseDownload"), 6);
	const unpacking = progress.child(t("core.runtimes.phaseExtract"), 2);

	const platform = runtimePlatform();
	const target = await resolving.task(
		{
			start: t("core.runtimes.resolving", { id }),
			done: t("core.runtimes.resolved", { id }),
			failed: t("core.runtimes.resolveFailed", { id }),
		},
		async () => {
			const found = await findAvailableRuntime(id, platform);

			if (!found) {
				throw new Error(t("core.runtimes.noSuchBuild", { id, platform }));
			}

			return found;
		},
	);

	await mkdir(runtimesDir(), { recursive: true });
	await sweepStaging();

	const dirName = runtimeDirName(id);
	const staging = join(runtimesDir(), `.staging-${dirName}`);
	const archive = join(runtimesDir(), `.${dirName}.tar.gz`);

	await rm(staging, { recursive: true, force: true });
	await rm(archive, { force: true });

	// GraalVM publishes its checksum as a sidecar file rather than in the release
	// metadata, so the one runtime being installed pays for one extra request
	const sha256 = target.sha256 ?? (await graalvm.graalDigest(target));

	await fetching.task(
		{
			start: t("core.runtimes.downloading", { id }),
			done: t("core.runtimes.downloaded", { id }),
			failed: t("core.runtimes.downloadFailed", { id }),
		},
		async (step) => {
			await downloadToFile(target.url, archive, {
				expected: sha256 ? { sha256 } : {},
				onProgress: (received, total) => {
					const mb = (received / 1024 / 1024).toFixed(1);

					// with no content-length there is nothing to divide by, so the step
					// only reports the byte count and its progress stays where it was
					if (!total) {
						step.info(step.progress, t("core.runtimes.downloadedSoFar", { mb }));

						return;
					}

					step.info(received / total, t("core.runtimes.downloadedOf", {
						mb,
						total: (total / 1024 / 1024).toFixed(1),
					}));
				},
			});
		},
	);

	try {
		const installed = await unpacking.task(
			{
				start: t("core.runtimes.extracting", { id }),
				done: t("core.runtimes.extracted", { id }),
				failed: t("core.runtimes.extractFailed", { id }),
			},
			async (step) => {
				await mkdir(staging, { recursive: true });
				await untar(archive, staging);

				step.info(0.6, t("core.runtimes.verifying", { id }));

				const javaPath = join(staging, "bin", "java");

				if (!existsSync(javaPath)) {
					throw new Error(t("core.runtimes.noJavaInArchive", { id }));
				}

				const versionLine = await javaVersionLine(javaPath);
				const parsed = parseRuntimeId(id)!;
				const meta: InstalledRuntime = {
					id,
					vendor: parsed.vendor,
					version: parsed.version,
					feature: runtimeFeature(parsed.version),
					dirName,
					javaPath: runtimeJavaPath(id),
					platform,
					installedAt: new Date().toISOString(),
					sizeBytes: await dirSize(staging),
					javaVersionLine: versionLine,
				};

				await Bun.write(join(staging, RUNTIME_META), `${JSON.stringify(meta, null, "\t")}\n`);

				const home = runtimeHome(id);

				await rm(home, { recursive: true, force: true });
				await rename(staging, home);

				return meta;
			},
		);

		return installed;
	} finally {
		await rm(archive, { force: true });
		await rm(staging, { recursive: true, force: true });
	}
}

/** Install a runtime unless this machine already has it. */
export async function ensureRuntime(
	id: string,
	opts: { force?: boolean; reporter?: ProgressReporter } = {},
): Promise<{ outcome: "present" | "installed"; runtime: InstalledRuntime }> {
	if (!opts.force && isRuntimeInstalled(id)) {
		const existing = await readRuntimeMeta(runtimeHome(id));

		if (existing) {
			opts.reporter?.complete(t("core.runtimes.alreadyInstalled", { id }));

			return { outcome: "present", runtime: existing };
		}
	}

	return { outcome: "installed", runtime: await installRuntime(id, opts) };
}

/**
 * Make sure the runtime an instance resolves is on this machine. Called on the
 * way into a start, which is what lets an operator point an instance at a
 * runtime the machine has never held and simply start it.
 */
export async function ensureInstanceRuntime(
	cfg: ClusterConfig,
	name: string,
	reporter?: ProgressReporter,
): Promise<{ outcome: "none" | "present" | "installed"; id?: string }> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const selection = javaSelection(cfg, inst);

	if (selection.kind !== "runtime") {
		reporter?.settle();

		return { outcome: "none" };
	}

	const result = await ensureRuntime(selection.id, { reporter });

	return { outcome: result.outcome, id: selection.id };
}

/**
 * Delete a runtime from this machine. Whether anything still asks for it is the
 * caller's question: only a routed caller holds the cluster config that knows.
 */
export async function removeLocalRuntime(id: string): Promise<{ removed: boolean; freedBytes?: number }> {
	const home = runtimeHome(id);

	if (!existsSync(home)) {
		return { removed: false };
	}

	const meta = await readRuntimeMeta(home);

	await rm(home, { recursive: true, force: true });

	return { removed: true, freedBytes: meta?.sizeBytes };
}

// -- helpers ----------------------------------------------------------------

/**
 * Unpack a vendor archive. Both vendors wrap everything in one top-level
 * directory named after the build, and its name is not the id, so the level is
 * stripped and the runtime's own layout (`bin/`, `lib/`) lands directly in the
 * target.
 */
async function untar(archive: string, dest: string): Promise<void> {
	const proc = Bun.spawn(["tar", "-xzf", archive, "-C", dest, "--strip-components=1"], {
		stdout: "ignore",
		stderr: "pipe",
	});

	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;

	if (code !== 0) {
		throw new Error(t("core.runtimes.tarFailed", { code, detail: stderr.trim().split("\n")[0] ?? "" }));
	}
}

/** First line of `java -version`, which the JVM prints on stderr. */
async function javaVersionLine(javaPath: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn([javaPath, "-version"], { stdout: "ignore", stderr: "pipe" });
		const text = await new Response(proc.stderr).text();

		await proc.exited;

		return text.trim().split("\n")[0]?.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Installed size, for the inventory. Best-effort: a missing `du` is not a failure. */
async function dirSize(dir: string): Promise<number | undefined> {
	try {
		const proc = Bun.spawn(["du", "-sb", dir], { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();

		await proc.exited;

		const bytes = Number.parseInt(text.trim().split(/\s+/)[0] ?? "", 10);

		return Number.isFinite(bytes) ? bytes : undefined;
	} catch {
		return undefined;
	}
}

/** Drop staging directories an interrupted install left behind. */
async function sweepStaging(): Promise<void> {
	const dir = runtimesDir();

	if (!existsSync(dir)) {
		return;
	}

	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(".staging-")) {
			continue;
		}

		const path = join(dir, entry.name);
		const info = await stat(path).catch(() => undefined);

		// anything still being written to right now belongs to a live install
		if (info && Date.now() - info.mtimeMs < 60_000) {
			continue;
		}

		await rm(path, { recursive: true, force: true });
	}
}
