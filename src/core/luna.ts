/**
 * In-house (`luna-*`) plugin deployment backend.
 *
 * The luna plugins are built from a separate gradle workspace (default
 * `~/luna-plugins`) that writes shadow jars to `output/<platform>/`. This module
 * drives that build, pools the artifacts under the same names the lockfile
 * already uses, and records build provenance so the console can tell a pooled
 * jar apart from the source tree it came from.
 */

import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ClusterConfig, LunaSourceConfig, PluginEntry, PluginsLock } from "./types";
import { instanceDir, managedInstances, poolDir } from "./config";
import type { ProgressReporter } from "./progress";
import { effectiveTargets } from "./families";
import { entryNameFor } from "./plugins";
import * as mr from "./services/modrinth";

/** Platforms whose artifacts are pooled for this cluster. */
export const LUNA_PLATFORMS = ["paper", "velocity", "neoforge"] as const;

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
	/** paper | velocity | neoforge | api */
	platform: string;
	/** Shadow jar file name in output/<platform>/, or undefined for api-only modules */
	file?: string;
	/** Standardized name the jar is pooled under, `<plugin>@<family>.jar` */
	poolFile?: string;
}

/**
 * The pool name of a module's artifact under the standardized scheme:
 * `<plugin>@<family>.jar`. The plugin identity drops the platform suffix and
 * the `-backend` marker (luna-auth-backend is luna-auth's paper module).
 */
export function poolFileFor(base: string, platform: string): string {
	const plugin = base.endsWith("-backend") ? base.slice(0, -8) : base;
	const family = platform === "velocity" || platform === "neoforge" ? platform : "paper";

	return `${plugin}@${family}.jar`;
}

/**
 * Enumerate the workspace's gradle modules and the jar each one produces.
 *
 * The mapping mirrors the artifact-naming rules in the workspace's root
 * `build.gradle.kts`: velocity modules are those suffixed `-velocity` plus a
 * hardcoded set, `-api` modules ship no shadow jar, and the archive base name
 * drops the platform suffix before re-appending the platform. Keep this in step
 * with that file — a rename there silently changes every pooled file name.
 */
export async function listModules(source: Required<LunaSourceConfig>): Promise<LunaModule[]> {
	const settingsPath = join(source.dir, "settings.gradle.kts");

	if (!existsSync(settingsPath)) {
		throw new Error(`luna workspace not found: ${source.dir}`);
	}

	const settings = await Bun.file(settingsPath).text();
	const names = [...settings.matchAll(/^\s*include\("([^"]+)"\)/gm)].map((match) => match[1]!);

	const velocityExtras = new Set(["luna-pack", "luna-auth", "luna-vault", "luna-glyph"]);
	const neoForgeExtras = new Set(["luna-core-messaging"]);

	return names.map((name) => {
		if (name.endsWith("-api")) {
			return { name, platform: "api" };
		}

		const platform = name.endsWith("-neoforge") || neoForgeExtras.has(name)
			? "neoforge"
			: name.endsWith("-velocity") || velocityExtras.has(name)
				? "velocity"
				: "paper";

		const base = name.endsWith(`-${platform}`) ? name.slice(0, -platform.length - 1) : name;

		return {
			name,
			platform,
			file: `${base}-${platform}-all.jar`,
			poolFile: poolFileFor(base, platform),
		};
	});
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
 * refused — building work in progress is the normal development case.
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
		throw new Error(`gradle wrapper not found: ${wrapper}`);
	}

	const tasks = opts.modules?.length
		? opts.modules.map((module) => `:${module}:${source.task}`)
		: [source.task];

	const started = Date.now();
	const log: string[] = [];

	const proc = Bun.spawn(["sh", wrapper, ...tasks, "--console=plain"], {
		cwd: source.dir,
		stdout: "pipe",
		stderr: "pipe",
	});

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

	await Promise.all([drain(proc.stdout), drain(proc.stderr)]);

	const exitCode = await proc.exited;

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
}

/**
 * Hash every shadow jar the last build left in `output/`, restricted to the
 * platforms this cluster deploys. Modules that were never built are simply absent
 * from the result — the caller reports them as not-built.
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
			sha512: await mr.sha512File(path),
			sizeBytes: info.size,
			builtAt: info.mtime,
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
 * Copy freshly built jars into the shared pool and update their lockfile entries.
 *
 * A jar whose pooled copy already has the same hash is left alone, so syncing is
 * idempotent and does not churn `pooledAt`. Jars with no lockfile entry are
 * registered as `source: "luna"` with no targets — deliberately not deployed
 * anywhere until the operator picks targets with `plugins apply`.
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

	for (const artifact of built) {
		const name = entryNameFor(artifact.poolFile);
		const target = join(pool, artifact.poolFile);
		const pooled = existsSync(target) ? await mr.sha512File(target) : undefined;

		let entry = lock.plugins[name];
		let action: SyncAction = pooled === artifact.sha512 ? "unchanged" : pooled ? "updated" : "pooled";

		if (!entry) {
			const identity = name.match(/^(.+)@(paper|velocity|universal|neoforge)$/);

			entry = {
				file: artifact.poolFile,
				source: "luna",
				loader:
					artifact.platform === "velocity" || artifact.platform === "neoforge"
						? artifact.platform
						: "paper",
				plugin: identity?.[1],
				family: identity?.[2] as PluginEntry["family"],
				autoUpdate: false,
				targets: [],
			};

			lock.plugins[name] = entry;
			action = "registered";
		}

		if (pooled !== artifact.sha512) {
			await copyFile(artifact.path, target);

			// content changed — the cached descriptor and log names are stale
			delete entry.aliases;
			delete entry.meta;
		}

		entry.source = "luna";
		entry.installed = { ...entry.installed, sha512: artifact.sha512, versionNumber: version };

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

		const targets = effectiveTargets(cfg, lock, name);
		const pooledHash = entry.installed?.sha512;
		const drifted: string[] = [];

		for (const target of targets) {
			const inst = insts[target];

			if (!inst) {
				continue;
			}

			const plugDir = join(instanceDir(inst), "plugins");

			// deploy() skips instances with no plugins/ folder, so neither does drift
			if (!existsSync(plugDir)) {
				continue;
			}

			const deployed = join(plugDir, entry.file);

			if (!existsSync(deployed) || (await mr.sha512File(deployed)) !== pooledHash) {
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
			file: entry.file,
			state,
			pooledVersion: entry.installed?.versionNumber,
			builtAt: artifact?.builtAt,
			targets,
			drifted,
		});
	}

	return rows;
}
