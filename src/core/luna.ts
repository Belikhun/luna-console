// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * In-house (`luna-*`) plugin deployment backend.
 *
 * The luna plugins are built from a separate gradle workspace (default
 * `~/luna-plugins`) that writes shadow jars to `output/<platform>/`. This module
 * drives that build, pools the artifacts under the same names the lockfile
 * already uses, and records build provenance so the console can tell a pooled
 * jar apart from the source tree it came from.
 */

import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type {
	ClusterConfig,
	LunaSourceConfig,
	PluginEntry,
	PluginFamily,
	PluginsLock,
	PluginVariant,
} from "./types";
import { PLUGIN_FAMILIES } from "./types";
import { t } from "../shared/i18n";
import { addonDirForFamily, instanceDir, managedInstances, poolDir } from "./config";
import type { ProgressReporter } from "./progress";
import { effectiveTargets } from "./families";
import { addonFileName, assignedVersion, entryNameFor, variantFileName, variantsDir } from "./plugins";
import { unzipRead } from "./archive";
import { sha512File } from "./services/download";

/** Platforms whose artifacts are pooled for this cluster. */
export const LUNA_PLATFORMS = ["paper", "velocity", "neoforge", "forge", "fabric", "pumpkin"] as const;

/**
 * Platforms whose builds are their own plugin family. Everything else pools as
 * `paper`, which is what every bukkit-API software loads.
 */
const PLATFORM_FAMILIES = new Set<string>(["velocity", "neoforge", "forge", "fabric", "pumpkin"]);

/**
 * Platforms gradle does not build.
 *
 * Pumpkin plugins are Rust WebAssembly components, so cargo builds them and the
 * workspace's own `pumpkin/build.sh` stages them; asking gradle for a shadow jar
 * of a crate would just fail. The script also writes the permissions manifest
 * beside each component, which `luna` needs to pre-approve a deployment.
 */
const NON_GRADLE_PLATFORMS = new Set<string>(["pumpkin"]);

/** Gradle task that produces the shadow jars. */
export const LUNA_BUILD_TASK = "shadowJar";

/** Default location of the luna-plugins workspace. */
const DEFAULT_LUNA_DIR = join(homedir(), "luna-plugins");

/**
 * Resolve the luna source configuration, filling in the defaults. `LUNA_PLUGINS_DIR`
 * overrides the registry so a checkout elsewhere can be built without editing
 * `cluster.json`.
 */
export function lunaSource(cfg: ClusterConfig): Required<LunaSourceConfig> {
	const configured = cfg.luna;

	const dir = process.env.LUNA_PLUGINS_DIR ?? configured?.dir ?? DEFAULT_LUNA_DIR;

	return {
		dir: resolve(dir),
		task: configured?.task ?? LUNA_BUILD_TASK,
		platforms: configured?.platforms ?? [...LUNA_PLATFORMS],
	};
}

/** Directory the gradle build writes a platform's shadow jars to. */
export function outputDir(source: Required<LunaSourceConfig>, platform: string): string {
	return join(source.dir, "output", platform);
}

export interface LunaModule {
	/** Gradle project name, e.g. "luna-core-paper" */
	name: string;
	/** paper | velocity | neoforge | fabric | api */
	platform: string;
	/** Shadow jar file name in output/<platform>/, or undefined for api-only modules */
	file?: string;
	/** Standardized name the jar is pooled under, `<plugin>@<family>.jar` */
	poolFile?: string;
	/** Game-line tag when this module is an alternative build of the same plugin */
	variant?: string;
}

/**
 * A module built for one game line rather than for the plugin's whole range,
 * named `<plugin>-mc<major>-<platform>`.
 *
 * One family can need more than one build of the same plugin: fabric's 26.x line
 * ships the game unobfuscated, so a mod built for 1.20-1.21 cannot run there and
 * the workspace produces a second jar from the same sources. Both are the same
 * plugin, so both pool under one entry - the untagged build as the primary and
 * each tagged one as a variant, which is the mechanism that already picks a build
 * per instance by MC version.
 */
const VARIANT_MODULE = /^(.+)-(mc\d+)$/;

/**
 * The pool name of a module's artifact under the standardized scheme:
 * `<plugin>@<family>.jar`. The plugin identity drops the platform suffix, the
 * `-backend` marker (luna-auth-backend is luna-auth's paper module) and any
 * game-line tag, since every build of a plugin shares one entry.
 */
export function poolFileFor(base: string, platform: string): string {
	const untagged = VARIANT_MODULE.exec(base)?.[1] ?? base;
	const plugin = untagged.endsWith("-backend") ? untagged.slice(0, -8) : untagged;
	const family = familyForPlatform(platform);

	// a pumpkin build is a wasm component, not a jar, and the pool name has to
	// say so: it is the name the server looks for in its own plugins directory
	return addonFileName(`${plugin}@${family}`, family);
}

/** The plugin family a platform's artifacts are pooled under. */
export function familyForPlatform(platform: string): PluginFamily {
	return PLATFORM_FAMILIES.has(platform) ? (platform as PluginFamily) : "paper";
}

/**
 * Enumerate the workspace's gradle modules and the jar each one produces.
 *
 * The mapping mirrors the artifact-naming rules in the workspace's root
 * `build.gradle.kts`: velocity modules are those suffixed `-velocity` plus a
 * hardcoded set, `-api` modules ship no shadow jar, and the archive base name
 * drops the platform suffix before re-appending the platform. Keep this in step
 * with that file; a rename there silently changes every pooled file name.
 */
export async function listModules(source: Required<LunaSourceConfig>): Promise<LunaModule[]> {
	const settingsPath = join(source.dir, "settings.gradle.kts");

	if (!existsSync(settingsPath)) {
		throw new Error(t("core.luna.workspaceMissing", { dir: source.dir }));
	}

	const settings = await Bun.file(settingsPath).text();
	const names = [...settings.matchAll(/^\s*include\("([^"]+)"\)/gm)].map((match) => match[1]!);

	const velocityExtras = new Set(["luna-pack", "luna-auth", "luna-vault", "luna-glyph"]);
	const neoForgeExtras = new Set(["luna-core-messaging"]);

	const gradle: LunaModule[] = names.map((name) => {
		if (name.endsWith("-api")) {
			return { name, platform: "api" };
		}

		// -neoforge is tested first because a module named for it also ends in
		// "forge"; classic forge is the narrower `-forge` suffix.
		const platform = name.endsWith("-neoforge") || neoForgeExtras.has(name)
			? "neoforge"
			: name.endsWith("-forge")
				? "forge"
				: name.endsWith("-fabric")
					? "fabric"
					: name.endsWith("-velocity") || velocityExtras.has(name)
						? "velocity"
						: "paper";

		const base = name.endsWith(`-${platform}`) ? name.slice(0, -platform.length - 1) : name;

		return {
			name,
			platform,
			file: `${base}-${platform}-all.jar`,
			poolFile: poolFileFor(base, platform),
			variant: VARIANT_MODULE.exec(base)?.[2],
		};
	});

	return [...gradle, ...(await listPumpkinModules(source))];
}

/**
 * The workspace's pumpkin components, read from its cargo workspace.
 *
 * These are invisible to `settings.gradle.kts` because gradle does not build
 * them, so they are enumerated from `pumpkin/Cargo.toml` instead. A member that
 * does not build a `cdylib` is a library the components share, not a plugin, so
 * it is skipped exactly as an `-api` gradle module is.
 */
async function listPumpkinModules(source: Required<LunaSourceConfig>): Promise<LunaModule[]> {
	const workspace = join(source.dir, "pumpkin", "Cargo.toml");

	if (!existsSync(workspace)) {
		return [];
	}

	const manifest = await Bun.file(workspace).text();
	const members = manifest.match(/^members\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
	const modules: LunaModule[] = [];

	for (const member of [...members.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)) {
		const crate = join(source.dir, "pumpkin", member, "Cargo.toml");

		if (!existsSync(crate)) {
			continue;
		}

		if (!/crate-type\s*=\s*\[[^\]]*"cdylib"/.test(await Bun.file(crate).text())) {
			continue;
		}

		modules.push({
			name: member,
			platform: "pumpkin",
			// cargo turns a crate's dashes into underscores for the artefact
			file: `${member.replace(/-/g, "_")}.wasm`,
			poolFile: poolFileFor(member, "pumpkin"),
		});
	}

	return modules;
}

export interface LunaBuildStamp {
	/** Version declared in the workspace's root build script */
	version: string;
	/** Short commit hash of the source tree */
	commit?: string;
	/** Whether the tree has uncommitted changes */
	dirty: boolean;
}

/** Run a command in the workspace and return its trimmed stdout, or undefined. */
async function capture(dir: string, cmd: string[]): Promise<string | undefined> {
	try {
		const proc = Bun.spawn(cmd, { cwd: dir, stdout: "pipe", stderr: "ignore" });
		const out = (await new Response(proc.stdout).text()).trim();

		return (await proc.exited) === 0 && out ? out : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Identify what a build of this workspace would produce: the declared gradle
 * version plus the commit it is built from. A dirty tree is flagged rather than
 * refused; building work in progress is the normal development case.
 */
export async function buildStamp(source: Required<LunaSourceConfig>): Promise<LunaBuildStamp> {
	const buildScript = join(source.dir, "build.gradle.kts");
	let version = "0.0.0";

	if (existsSync(buildScript)) {
		const text = await Bun.file(buildScript).text();

		version = /^\s*version\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? version;
	}

	const commit = await capture(source.dir, ["git", "rev-parse", "--short", "HEAD"]);
	const status = await capture(source.dir, ["git", "status", "--porcelain"]);

	return { version, commit, dirty: status !== undefined && status.length > 0 };
}

/** Version string recorded in the lockfile for a luna jar. */
export function stampVersion(stamp: LunaBuildStamp): string {
	const suffix = stamp.commit ? `+${stamp.commit}${stamp.dirty ? ".dirty" : ""}` : "";

	return stamp.version + suffix;
}

export interface BuildOptions {
	/** Restrict the build to these gradle modules (default: the whole workspace) */
	modules?: string[];
	/** Called with each line of gradle output, for spinners and log streaming */
	onLine?: (line: string) => void;
	/** Live progress: gradle's output lines ride the report messages, so a
	 *  daemon job streams them to remote renderers the same way onLine feeds
	 *  a local spinner */
	reporter?: ProgressReporter;
}

export interface BuildResult {
	ok: boolean;
	exitCode: number;
	/** Full gradle output, newest last */
	log: string[];
	tookMs: number;
	stamp: LunaBuildStamp;
}

/**
 * Run the workspace's gradle build. Uses the repo's own wrapper through `sh` so a
 * checkout whose `gradlew` lost its executable bit still builds (it is committed
 * mode 644 upstream), and merges stderr into the line stream so a failure is
 * visible in the same log the caller is already showing.
 */
export async function build(
	source: Required<LunaSourceConfig>,
	opts: BuildOptions = {},
): Promise<BuildResult> {
	const wrapper = join(source.dir, "gradlew");

	if (!existsSync(wrapper)) {
		throw new Error(t("core.luna.wrapperMissing", { path: wrapper }));
	}

	const tasks = opts.modules?.length
		? opts.modules.map((module) => `:${module}:${source.task}`)
		: [source.task];

	const started = Date.now();
	const log: string[] = [];

	const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		const decoder = new TextDecoder();
		let pending = "";

		for await (const chunk of stream) {
			pending += decoder.decode(chunk, { stream: true });

			const lines = pending.split("\n");

			pending = lines.pop() ?? "";

			for (const line of lines) {
				log.push(line);
				opts.onLine?.(line);
				opts.reporter?.say("info", line);
			}
		}

		if (pending.length > 0) {
			log.push(pending);
			opts.onLine?.(pending);
			opts.reporter?.say("info", pending);
		}
	};

	/** Run one build command to completion, streaming it into the shared log. */
	const run = async (cmd: string[]): Promise<number> => {
		const spawned = Bun.spawn(cmd, { cwd: source.dir, stdout: "pipe", stderr: "pipe" });

		await Promise.all([drain(spawned.stdout), drain(spawned.stderr)]);

		return await spawned.exited;
	};

	// the cargo platforms first, and only when this build covers them: they are a
	// separate toolchain, and a failure there should be read before gradle's
	// output buries it
	for (const platform of source.platforms.filter((entry) => NON_GRADLE_PLATFORMS.has(entry))) {
		const script = join(source.dir, platform, "build.sh");

		if (!existsSync(script)) {
			continue;
		}

		const code = await run(["sh", script]);

		if (code !== 0) {
			return {
				ok: false,
				exitCode: code,
				log,
				tookMs: Date.now() - started,
				stamp: await buildStamp(source),
			};
		}
	}

	const exitCode = await run(["sh", wrapper, ...tasks, "--console=plain"]);

	return {
		ok: exitCode === 0,
		exitCode,
		log,
		tookMs: Date.now() - started,
		stamp: await buildStamp(source),
	};
}

export interface LunaArtifact {
	module: string;
	platform: string;
	/** Jar name as gradle wrote it (…-all.jar) */
	file: string;
	/** Standardized name it is pooled under (`<plugin>@<family>.jar`) */
	poolFile: string;
	path: string;
	sha512: string;
	sizeBytes: number;
	builtAt: Date;
	/** Game-line tag when this jar is an alternative build of the same plugin */
	variant?: string;
	/** MC versions this build declares it runs on */
	gameVersions?: string[];
}

/**
 * The MC versions an in-house jar says it covers, read from `luna-plugin.json`
 * at its root.
 *
 * A pooled jar from a provider carries its game versions in the entry the
 * provider's API filled in; an in-house one has nobody to ask, so a build that
 * covers only part of its plugin's range declares it itself. Saying nothing
 * means unconstrained, which is what a jar serving its whole family does.
 */
async function declaredGameVersions(path: string): Promise<string[] | undefined> {
	const text = await unzipRead(path, "luna-plugin.json");

	if (!text) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(text) as { gameVersions?: unknown };

		if (!Array.isArray(parsed.gameVersions)) {
			return undefined;
		}

		const versions = parsed.gameVersions.filter(
			(entry): entry is string => typeof entry === "string" && entry.length > 0,
		);

		return versions.length ? versions : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Hash every shadow jar the last build left in `output/`, restricted to the
 * platforms this cluster deploys. Modules that were never built are simply absent
 * from the result; the caller reports them as not-built.
 */
export async function artifacts(source: Required<LunaSourceConfig>): Promise<LunaArtifact[]> {
	const modules = await listModules(source);
	const found: LunaArtifact[] = [];

	for (const module of modules) {
		if (!module.file || !source.platforms.includes(module.platform)) {
			continue;
		}

		const path = join(outputDir(source, module.platform), module.file);

		if (!existsSync(path)) {
			continue;
		}

		const info = await stat(path);

		found.push({
			module: module.name,
			platform: module.platform,
			file: module.file,
			poolFile: module.poolFile!,
			path,
			sha512: await sha512File(path),
			sizeBytes: info.size,
			builtAt: info.mtime,
			variant: module.variant,
			gameVersions: await declaredGameVersions(path),
		});
	}

	return found;
}

/** Shadow jars present in `output/` that no gradle module accounts for. */
export async function strayArtifacts(source: Required<LunaSourceConfig>): Promise<string[]> {
	const expected = new Set((await listModules(source)).map((module) => module.file));
	const stray: string[] = [];

	for (const platform of source.platforms) {
		const dir = outputDir(source, platform);

		if (!existsSync(dir)) {
			continue;
		}

		for (const file of await readdir(dir)) {
			if (file.toLowerCase().endsWith(".jar") && !expected.has(file)) {
				stray.push(join(platform, file));
			}
		}
	}

	return stray;
}

/** What `sync` did to one artifact. */
export type SyncAction = "pooled" | "updated" | "unchanged" | "registered";

export interface SyncEntry {
	name: string;
	module: string;
	file: string;
	action: SyncAction;
	/** Version string recorded in the lockfile */
	version: string;
	/** True when the entry has no targets yet, so a deploy would skip it */
	unassigned: boolean;
}

/**
 * Replace a plugin's pooled build for one game line.
 *
 * The tag is what identifies the build across rebuilds; the version around it
 * changes with every commit. So the previous jar for the same tag is removed
 * rather than left to accumulate, and any instance auto-assigned to it is moved
 * onto the replacement, which is the same build for the same game line and the
 * only one that still exists. A hand-set pin is left pointing at the version it
 * named, so deploy reports it as missing instead of quietly moving it.
 */
async function replaceVariantBuild(
	entry: PluginEntry,
	tag: string,
	variant: PluginVariant,
): Promise<void> {
	for (const [versionNumber, previous] of Object.entries(entry.variants ?? {})) {
		if (versionNumber === variant.versionNumber || !versionNumber.endsWith(`+${tag}`)) {
			continue;
		}

		await rm(join(variantsDir(), previous.file), { force: true });

		delete entry.variants![versionNumber];

		for (const [instance, assigned] of Object.entries(entry.assign ?? {})) {
			if (assigned === versionNumber) {
				entry.assign![instance] = variant.versionNumber;
			}
		}
	}

	entry.variants ??= {};
	entry.variants[variant.versionNumber] = variant;
}

/** Suffix of the capability manifest a pumpkin component is built with. */
const MANIFEST_SUFFIX = ".permissions.json";

/**
 * Carry a component's capability manifest into the pool beside it.
 *
 * A pumpkin component is only loadable if the operator has consented to the
 * capabilities it asks for, and luna consents on their behalf when it deploys
 * (nothing is attached to a screen session to answer the server's prompt). It
 * can only do that from the list the build recorded, so the manifest has to
 * travel with the artefact rather than staying in the workspace. Nothing else
 * builds one, and its absence is not an error: a jar simply has none.
 */
async function copyManifest(sourcePath: string, targetPath: string): Promise<void> {
	const manifest = `${sourcePath}${MANIFEST_SUFFIX}`;

	if (!existsSync(manifest)) {
		return;
	}

	await copyFile(manifest, `${targetPath}${MANIFEST_SUFFIX}`);
}

/**
 * Copy freshly built jars into the shared pool and update their lockfile entries.
 *
 * A jar whose pooled copy already has the same hash is left alone, so syncing is
 * idempotent and does not churn `pooledAt`. Jars with no lockfile entry are
 * registered as `source: "luna"` with no targets; deliberately not deployed
 * anywhere until the operator picks targets with `plugins apply`.
 *
 * A plugin built once per game line pools as one entry: the untagged build is the
 * primary and each tagged one a variant, so the per-instance version resolution
 * that already picks a build by MC version picks these too. That ordering is why
 * primaries are handled first - a variant has nothing to attach to until its
 * plugin's entry exists.
 */
export async function sync(
	lock: PluginsLock,
	built: LunaArtifact[],
	stamp: LunaBuildStamp,
): Promise<SyncEntry[]> {
	const pool = poolDir();
	const version = stampVersion(stamp);
	const results: SyncEntry[] = [];

	await mkdir(pool, { recursive: true });

	for (const artifact of built.filter((candidate) => !candidate.variant)) {
		const name = entryNameFor(artifact.poolFile);
		const target = join(pool, artifact.poolFile);
		const pooled = existsSync(target) ? await sha512File(target) : undefined;

		let entry = lock.plugins[name];
		let action: SyncAction = pooled === artifact.sha512 ? "unchanged" : pooled ? "updated" : "pooled";

		if (!entry) {
			const identity = name.match(new RegExp(`^(.+)@(${PLUGIN_FAMILIES.join("|")})$`));

			entry = {
				file: artifact.poolFile,
				source: "luna",
				plugin: identity?.[1] ?? name,
				family: (identity?.[2] as PluginEntry["family"] | undefined) ?? familyForPlatform(artifact.platform),
				autoUpdate: false,
				targets: [],
			};

			lock.plugins[name] = entry;
			action = "registered";
		}

		if (pooled !== artifact.sha512) {
			await copyFile(artifact.path, target);
			await copyManifest(artifact.path, target);

			// content changed; the cached descriptor and log names are stale
			delete entry.aliases;
			delete entry.meta;
		}

		entry.source = "luna";
		entry.installed = {
			...entry.installed,
			sha512: artifact.sha512,
			versionNumber: version,
			gameVersions: artifact.gameVersions,
		};

		entry.luna = {
			module: artifact.module,
			commit: stamp.commit,
			dirty: stamp.dirty,
			pooledAt:
				pooled === artifact.sha512 && entry.luna?.pooledAt
					? entry.luna.pooledAt
					: new Date().toISOString(),
		};

		results.push({
			name,
			module: artifact.module,
			file: artifact.poolFile,
			action,
			version,
			unassigned: entry.targets.length === 0,
		});
	}

	for (const artifact of built.filter((candidate) => candidate.variant)) {
		const name = entryNameFor(artifact.poolFile);
		const entry = lock.plugins[name];

		// no entry means the plugin's primary build is missing from output/, which
		// `status` already reports against that module; an extra build of a plugin
		// that is not pooled has nothing to be an extra build of
		if (!entry) {
			continue;
		}

		const versionNumber = `${version}+${artifact.variant}`;
		const file = variantFileName(name, versionNumber);
		const target = join(variantsDir(), file);
		const pooled = existsSync(target) ? await sha512File(target) : undefined;

		await mkdir(variantsDir(), { recursive: true });

		if (pooled !== artifact.sha512) {
			await copyFile(artifact.path, target);
		}

		await replaceVariantBuild(entry, artifact.variant!, {
			versionNumber,
			sha512: artifact.sha512,
			file,
			gameVersions: artifact.gameVersions,
		});

		results.push({
			name,
			module: artifact.module,
			file,
			action: pooled === artifact.sha512 ? "unchanged" : pooled ? "updated" : "pooled",
			version: versionNumber,
			unassigned: entry.targets.length === 0,
		});
	}

	return results;
}

/** Where one luna module stands between source, pool and instances. */
export type LunaState = "in-sync" | "needs-deploy" | "stale-pool" | "not-built" | "unregistered";

export interface LunaStatusRow {
	module: string;
	platform: string;
	/** Lockfile key, when the jar is registered */
	name?: string;
	file?: string;
	state: LunaState;
	/** Version recorded in the lockfile */
	pooledVersion?: string;
	builtAt?: Date;
	/** Instances the lockfile targets */
	targets: string[];
	/** Targets whose deployed copy differs from the pooled jar */
	drifted: string[];
}

/**
 * Compare the built artifacts, the pool and every instance's `plugins/` folder.
 *
 * `stale-pool` means the source tree was rebuilt but never synced; `needs-deploy`
 * means the pool is current but some instance still runs an older copy. Both are
 * fixed by `deploy`, which is why they are separate states rather than one.
 */
export async function status(
	cfg: ClusterConfig,
	lock: PluginsLock,
	source: Required<LunaSourceConfig>,
): Promise<LunaStatusRow[]> {
	const modules = await listModules(source);
	const built = new Map((await artifacts(source)).map((artifact) => [artifact.module, artifact]));
	const insts = managedInstances(cfg);
	const rows: LunaStatusRow[] = [];

	for (const module of modules) {
		if (!module.file || !source.platforms.includes(module.platform)) {
			continue;
		}

		const artifact = built.get(module.name);
		const name = entryNameFor(module.poolFile!);
		const entry = lock.plugins[name];

		if (!entry) {
			rows.push({
				module: module.name,
				platform: module.platform,
				file: module.file,
				state: artifact ? "unregistered" : "not-built",
				builtAt: artifact?.builtAt,
				targets: [],
				drifted: [],
			});

			continue;
		}

		// a game-line module produced one of the entry's variants, not its primary,
		// so that is the pooled build its row is about
		const pooled = module.variant
			? Object.entries(entry.variants ?? {}).find(([key]) => key.endsWith(`+${module.variant}`))?.[1]
			: undefined;

		if (module.variant && !pooled) {
			rows.push({
				module: module.name,
				platform: module.platform,
				name,
				file: module.file,
				state: artifact ? "stale-pool" : "not-built",
				builtAt: artifact?.builtAt,
				targets: [],
				drifted: [],
			});

			continue;
		}

		const pooledHash = pooled?.sha512 ?? entry.installed?.sha512;
		const pooledVersion = pooled?.versionNumber ?? entry.installed?.versionNumber;

		// every instance the entry covers, narrowed to the ones running this build
		const targets = effectiveTargets(cfg, lock, name).filter(
			(target) => assignedVersion(entry, target) === pooledVersion,
		);

		const drifted: string[] = [];

		for (const target of targets) {
			const inst = insts[target];

			if (!inst) {
				continue;
			}

			const addonDir = join(instanceDir(inst), addonDirForFamily(entry.family));

			// deploy() skips instances with no addon folder, so neither does drift
			if (!existsSync(addonDir)) {
				continue;
			}

			const deployed = join(addonDir, entry.file);

			if (!existsSync(deployed) || (await sha512File(deployed)) !== pooledHash) {
				drifted.push(target);
			}
		}

		const state: LunaState = !artifact
			? "not-built"
			: artifact.sha512 !== pooledHash
				? "stale-pool"
				: drifted.length > 0
					? "needs-deploy"
					: "in-sync";

		rows.push({
			module: module.name,
			platform: module.platform,
			name,
			file: pooled?.file ?? entry.file,
			state,
			pooledVersion,
			builtAt: artifact?.builtAt,
			targets,
			drifted,
		});
	}

	return rows;
}
