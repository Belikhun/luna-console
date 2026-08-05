/**
 * Instance config files: browsing an instance directory, editing a file, and
 * turning literal values inside one into environment placeholders that luna
 * re-renders on every start.
 *
 * Two kinds of file live side by side in an instance directory:
 *
 * - **Plain files** are the server's own. Reading and writing one is exactly
 *   that: luna is a text editor over the instance directory and nothing else
 *   remembers the edit.
 * - **Managed files** are luna's. The template (the file's text with `${VAR}`
 *   references in place of the values that vary) is the source of truth in
 *   `configfiles.json`, and the file inside the instance is derived from it
 *   (state invariants: never the other way round). `renderManagedFiles` is what
 *   derives it, and `startInstance` calls it, so a variable change reaches the
 *   server on its next start with nothing else to run.
 *
 * A file becomes managed the moment someone creates a placeholder in it: its
 * current text is adopted as the template, the chosen literal is replaced by
 * `${NAME}`, and that name is set in the environment store at the scope the
 * caller picked. From then on the console edits the *template*, which is why a
 * read reports both texts.
 *
 * Files the server rewrote itself since luna last rendered them are **drift**.
 * Rendering still wins (the template is the source of truth), but the drifted
 * text is kept beside the file as `<name>.luna-drift` first, so a config a
 * plugin regenerated with new keys is never silently thrown away.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { ClusterConfig, PluginsLock } from "./types";
import { t } from "../shared/i18n";
import { instanceDir, managedInstances, notifySave, root } from "./config";
import {
	ENV_NAME_PATTERN,
	loadEnv,
	resolveDetailed,
	resolveVars,
	saveEnv,
	setVariable,
	substitute,
	type EnvScope,
	type EnvironmentStore,
	type ScopeTarget,
} from "./environment";
import type { ProgressReporter } from "./progress";

const STORE_FILE = "configfiles.json";

/** Suffix of the copy kept when a drifted file is about to be overwritten. */
export const DRIFT_SUFFIX = ".luna-drift";

/** Editing cap. Bigger files are browsable and reported, never loaded into an editor. */
export const MAX_EDIT_BYTES = 512 * 1024;

/** How much of a file is sniffed for NUL bytes before calling it binary. */
const SNIFF_BYTES = 8192;

/**
 * Extensions luna offers to edit. The list is an affordance, not a security
 * boundary: a file that passes it is still NUL-sniffed on read, and one that
 * fails it can still be opened by a caller that insists.
 */
const TEXT_EXTENSIONS = new Set([
	"yml", "yaml", "json", "json5", "properties", "toml", "conf", "cfg", "ini",
	"txt", "md", "sh", "bash", "env", "xml", "html", "css", "js", "ts", "csv",
	"tsv", "log", "lang", "mcfunction", "snbt", "mcmeta", "list", "acf", "lock",
]);

/** Directories that are never worth browsing into: pure runtime churn. */
const NOISE_DIRS = new Set(["cache", "libraries", "versions", "crash-reports", "debug"]);

export interface ManagedConfigFile {
	/** The file's text with `${VAR}` references where values vary */
	template: string;
	/** sha256 of the text luna last wrote, which is what makes drift detectable */
	rendered?: string;
	/** ISO 8601 of the last template edit */
	updatedAt?: string;
	description?: string;
}

export interface ConfigFileStore {
	/** instance → path relative to the instance directory → managed file */
	instances: Record<string, Record<string, ManagedConfigFile>>;
}

function storePath(): string {
	return join(root(), STORE_FILE);
}

/** Read the managed-file store, treating a missing file as an empty one. */
export async function loadConfigFiles(): Promise<ConfigFileStore> {
	const path = storePath();

	if (!existsSync(path)) {
		return { instances: {} };
	}

	const store: ConfigFileStore = await Bun.file(path).json();

	store.instances ??= {};

	return store;
}

/** Persist the managed-file store, key-sorted to keep diffs small. */
export async function saveConfigFiles(store: ConfigFileStore): Promise<void> {
	const sorted: ConfigFileStore = { instances: {} };

	for (const instance of Object.keys(store.instances).sort()) {
		const files = store.instances[instance]!;

		if (!Object.keys(files).length) {
			continue;
		}

		sorted.instances[instance] = {};

		for (const path of Object.keys(files).sort()) {
			sorted.instances[instance]![path] = files[path]!;
		}
	}

	await Bun.write(storePath(), JSON.stringify(sorted, null, "\t") + "\n");

	await notifySave("configfiles", sorted);
}

/**
 * Resolve a caller-supplied relative path inside an instance, refusing anything
 * that escapes the instance directory. Every read and write goes through this,
 * the path arrives from an HTTP route, so `..`, an absolute path and a symlink
 * pointing outside are all things a client may try.
 */
export function resolveInstancePath(
	cfg: ClusterConfig,
	instance: string,
	relPath: string,
): { dir: string; path: string; rel: string } {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name: instance }));
	}

	const dir = resolve(instanceDir(inst));
	const normalized = (relPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
	const path = resolve(dir, normalized);

	if (path !== dir && !path.startsWith(dir + sep)) {
		throw new Error(t("core.configfiles.pathEscapes", { path: relPath }));
	}

	return { dir, path, rel: relative(dir, path).split(sep).join("/") };
}

/** Lowercase extension of a path, without the dot ("" when it has none). */
function extensionOf(path: string): string {
	const base = path.slice(path.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");

	return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Whether a name looks like text luna should offer to edit. */
export function looksEditable(path: string, size: number): boolean {
	if (size > MAX_EDIT_BYTES) {
		return false;
	}

	const ext = extensionOf(path);

	// dotfiles and extension-less files in a server directory are config far more
	// often than not (.luna-env, eula.txt's neighbours, banned-ips)
	return ext === "" || TEXT_EXTENSIONS.has(ext);
}

/** Whether the first chunk of a file holds a NUL byte, i.e. it is not text. */
async function looksBinary(path: string): Promise<boolean> {
	const bytes = new Uint8Array(await Bun.file(path).slice(0, SNIFF_BYTES).arrayBuffer());

	return bytes.includes(0);
}

function sha256(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export interface DirEntry {
	name: string;
	/** Path relative to the instance directory, `/`-separated */
	path: string;
	kind: "dir" | "file";
	size: number;
	/** Epoch millis of the last modification */
	modified: number;
	/** Small enough and text enough for the editor to open */
	editable: boolean;
	/** Rendered from a luna template on every start */
	managed: boolean;
	/** Managed, and the file on disk no longer matches what luna wrote */
	drifted: boolean;
	/** A directory whose contents are runtime churn rather than config */
	noise: boolean;
}

/**
 * One level of an instance's directory tree. Listing is deliberately shallow:
 * a world directory holds hundreds of thousands of region files, so nothing
 * here ever recurses on its own.
 */
export async function browseInstance(
	cfg: ClusterConfig,
	instance: string,
	relPath = "",
): Promise<{ path: string; entries: DirEntry[] }> {
	const { path, rel } = resolveInstancePath(cfg, instance, relPath);

	if (!existsSync(path)) {
		throw new Error(t("core.configfiles.noSuchDir", { path: rel || "." }));
	}

	const store = await loadConfigFiles();
	const managed = store.instances[instance] ?? {};
	const entries: DirEntry[] = [];

	for (const item of await readdir(path, { withFileTypes: true })) {
		const childRel = rel ? `${rel}/${item.name}` : item.name;
		const childPath = join(path, item.name);

		let size = 0;
		let modified = 0;

		try {
			const info = await stat(childPath);

			size = info.size;
			modified = info.mtimeMs;
		} catch {
			// vanished between readdir and stat (a log rotating, a temp file); list
			// it with what we know rather than failing the whole listing
		}

		const isDir = item.isDirectory();
		const entry = managed[childRel];

		entries.push({
			name: item.name,
			path: childRel,
			kind: isDir ? "dir" : "file",
			size,
			modified,
			editable: !isDir && looksEditable(childRel, size),
			managed: !isDir && !!entry,
			drifted: !isDir && !!entry && (await isDrifted(childPath, entry)),
			noise: isDir && NOISE_DIRS.has(item.name),
		});
	}

	entries.sort((a, b) => {
		if (a.kind !== b.kind) {
			return a.kind === "dir" ? -1 : 1;
		}

		return a.name.localeCompare(b.name);
	});

	return { path: rel, entries };
}

/** Whether a managed file's disk content diverged from what luna last wrote. */
async function isDrifted(path: string, entry: ManagedConfigFile): Promise<boolean> {
	if (!entry.rendered || !existsSync(path)) {
		return false;
	}

	try {
		return sha256(await Bun.file(path).text()) !== entry.rendered;
	} catch {
		return false;
	}
}

export interface FileContent {
	/** Path relative to the instance directory */
	path: string;
	/** What is on disk right now */
	text: string;
	size: number;
	modified: number;
	/** Rendered from a template on every start */
	managed: boolean;
	/** The template, when managed; this is what an editor should edit */
	template?: string;
	/** Disk content diverged from what luna last wrote */
	drifted: boolean;
	/** `${VAR}` names the template references */
	placeholders: string[];
	/** Referenced names the instance cannot resolve; rendering would leave them literal */
	missing: string[];
	description?: string;
}

/**
 * Read one file for the editor: the disk text, and the template when the file is
 * managed. A file too large or too binary to edit is refused here rather than
 * half-loaded, because the editor has no way to write back what it truncated.
 */
export async function readInstanceFile(
	cfg: ClusterConfig,
	instance: string,
	relPath: string,
): Promise<FileContent> {
	const { path, rel } = resolveInstancePath(cfg, instance, relPath);
	const store = await loadConfigFiles();
	const entry = store.instances[instance]?.[rel];

	if (!existsSync(path)) {
		// a managed file that has not been rendered yet is a real state: the
		// template exists, the instance has never started with it
		if (!entry) {
			throw new Error(t("core.configfiles.noSuchFile", { path: rel }));
		}

		return {
			path: rel,
			text: "",
			size: 0,
			modified: 0,
			managed: true,
			template: entry.template,
			drifted: false,
			...(await placeholderStatus(cfg, instance, entry.template)),
			...(entry.description ? { description: entry.description } : {}),
		};
	}

	const info = await stat(path);

	if (info.isDirectory()) {
		throw new Error(t("core.configfiles.isDirectory", { path: rel }));
	}

	if (info.size > MAX_EDIT_BYTES) {
		throw new Error(
			t("core.configfiles.tooLargeEdit", {
				path: rel,
				size: Math.round(info.size / 1024),
				cap: MAX_EDIT_BYTES / 1024,
			}),
		);
	}

	if (await looksBinary(path)) {
		throw new Error(t("core.configfiles.notText", { path: rel }));
	}

	const text = await Bun.file(path).text();
	const template = entry?.template;

	return {
		path: rel,
		text,
		size: info.size,
		modified: info.mtimeMs,
		managed: !!entry,
		...(template !== undefined ? { template } : {}),
		drifted: entry ? await isDrifted(path, entry) : false,
		...(await placeholderStatus(cfg, instance, template ?? text)),
		...(entry?.description ? { description: entry.description } : {}),
	};
}

/** The `${VAR}` names a body references, split into resolvable and missing. */
async function placeholderStatus(
	cfg: ClusterConfig,
	instance: string,
	body: string,
): Promise<{ placeholders: string[]; missing: string[] }> {
	const names = [...new Set([...body.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]!))];

	if (!names.length) {
		return { placeholders: [], missing: [] };
	}

	const vars = await resolveVars(cfg, await loadEnv(), instance);

	return {
		placeholders: names.sort(),
		missing: names.filter((name) => vars[name] === undefined).sort(),
	};
}

export interface WriteResult {
	path: string;
	managed: boolean;
	/** What landed on disk after the write */
	rendered: string;
	/** Names the body referenced that the instance cannot resolve */
	missing: string[];
}

/**
 * Write a file. For a plain file the text goes to disk verbatim; for a managed
 * one the text *is* the new template, and what lands on disk is its render, so
 * the editor never has to know which of the two it is holding.
 *
 * Refuses a managed write whose template references undefined variables: writing
 * it would put a literal `${NAME}` into a config the server then fails to parse.
 */
export async function writeInstanceFile(
	cfg: ClusterConfig,
	instance: string,
	relPath: string,
	text: string,
	opts: { description?: string } = {},
): Promise<WriteResult> {
	const { path, rel } = resolveInstancePath(cfg, instance, relPath);
	const store = await loadConfigFiles();
	const entry = store.instances[instance]?.[rel];

	await mkdir(dirname(path), { recursive: true });

	if (!entry) {
		await Bun.write(path, text);

		return { path: rel, managed: false, rendered: text, missing: [] };
	}

	const result = substitute(text, await resolveVars(cfg, await loadEnv(), instance));

	if (result.missing.length) {
		throw new Error(
			t("core.configfiles.undefinedVars", { path: rel, names: result.missing.join(", ") }),
		);
	}

	entry.template = text;
	entry.rendered = sha256(result.text);
	entry.updatedAt = new Date().toISOString();

	if (opts.description !== undefined) {
		entry.description = opts.description || undefined;
	}

	await Bun.write(path, result.text);
	await saveConfigFiles(store);

	return { path: rel, managed: true, rendered: result.text, missing: [] };
}

/**
 * Take a file under management, adopting its current text as the template. The
 * file must exist: a template is a description of a real config, and adopting a
 * blank one would write an empty file over the server's own on the next start.
 */
export async function manageFile(
	cfg: ClusterConfig,
	instance: string,
	relPath: string,
	opts: { description?: string } = {},
): Promise<ManagedConfigFile> {
	const { path, rel } = resolveInstancePath(cfg, instance, relPath);

	if (!existsSync(path)) {
		throw new Error(t("core.configfiles.noSuchFile", { path: rel }));
	}

	if ((await stat(path)).size > MAX_EDIT_BYTES) {
		throw new Error(t("core.configfiles.tooLargeTemplate", { path: rel }));
	}

	const store = await loadConfigFiles();
	const text = await Bun.file(path).text();

	store.instances[instance] ??= {};

	const entry: ManagedConfigFile = {
		template: text,
		rendered: sha256(text),
		updatedAt: new Date().toISOString(),
		...(opts.description ? { description: opts.description } : {}),
	};

	store.instances[instance]![rel] = entry;

	await saveConfigFiles(store);

	return entry;
}

/**
 * Stop managing a file, leaving whatever is on disk exactly where it is. The
 * server keeps the last render; luna simply stops re-deriving it.
 */
export async function unmanageFile(
	cfg: ClusterConfig,
	instance: string,
	relPath: string,
): Promise<boolean> {
	const { rel } = resolveInstancePath(cfg, instance, relPath);
	const store = await loadConfigFiles();

	if (!store.instances[instance]?.[rel]) {
		return false;
	}

	delete store.instances[instance]![rel];

	await saveConfigFiles(store);

	return true;
}

/**
 * Re-adopt a drifted file: the server's current text replaces the template,
 * keeping the `${VAR}` placeholders that still match their resolved values, so
 * a config a plugin regenerated with new keys can be pulled back under
 * management without losing the parameterization it already had.
 */
export async function readoptFile(
	cfg: ClusterConfig,
	instance: string,
	relPath: string,
): Promise<{ path: string; kept: string[] }> {
	const { path, rel } = resolveInstancePath(cfg, instance, relPath);
	const store = await loadConfigFiles();
	const entry = store.instances[instance]?.[rel];

	if (!entry) {
		throw new Error(t("core.configfiles.notManaged", { path: rel }));
	}

	if (!existsSync(path)) {
		throw new Error(t("core.configfiles.noSuchFile", { path: rel }));
	}

	const vars = await resolveVars(cfg, await loadEnv(), instance);
	const names = [
		...new Set([...entry.template.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]!)),
	];

	let template = await Bun.file(path).text();
	const kept: string[] = [];

	// longest value first: a short value that happens to be a substring of a
	// longer one must not claim the longer one's text
	const byLength = names
		.filter((name) => vars[name] !== undefined && vars[name] !== "")
		.sort((a, b) => vars[b]!.length - vars[a]!.length);

	for (const name of byLength) {
		const replaced = replaceAllLiteral(template, vars[name]!, `\${${name}}`);

		if (replaced.count > 0) {
			template = replaced.text;
			kept.push(name);
		}
	}

	entry.template = template;
	entry.rendered = sha256(await Bun.file(path).text());
	entry.updatedAt = new Date().toISOString();

	await saveConfigFiles(store);

	return { path: rel, kept: kept.sort() };
}

/** Replace every literal occurrence of `needle`, reporting how many there were. */
function replaceAllLiteral(
	text: string,
	needle: string,
	replacement: string,
): { text: string; count: number } {
	if (!needle) {
		return { text, count: 0 };
	}

	const parts = text.split(needle);

	return { text: parts.join(replacement), count: parts.length - 1 };
}

export interface PlaceholderResult {
	path: string;
	name: string;
	/** How many occurrences the template now references the variable at */
	replaced: number;
	scope: EnvScope;
	/** The template after the substitution */
	template: string;
	/** What the file looks like once rendered */
	rendered: string;
	/**
	 * True when rendering changed the file's bytes; only possible with `force`,
	 * because a placeholder that silently rewrites a config is refused otherwise.
	 */
	changedFile: boolean;
}

/** A variable's value at one specific scope, or undefined when unset there. */
function valueAtScope(
	store: EnvironmentStore,
	name: string,
	scope: ScopeTarget,
): string | undefined {
	if (scope.instance !== undefined) {
		return store.instances[scope.instance]?.[name];
	}

	if (scope.machine !== undefined) {
		return store.machines[scope.machine]?.[name];
	}

	return store.variables[name]?.value;
}

/**
 * Turn a literal value inside a config file into an environment placeholder: the
 * file is taken under management if it is not already, occurrences of the literal
 * become `${NAME}` in the template, the name is set in the environment store at
 * the requested scope, and the render is written back.
 *
 * The point is that the file on disk stays byte-identical; the value simply
 * moves into the environment. Two things can break that promise, and both are
 * refused rather than done quietly (`force` overrides either):
 *
 * - the name already holds a **different** value at the target scope, so reusing
 *   it would change every other file that references it;
 * - the name resolves, for *this* instance, to something other than the literal
 *   (a narrower scope already overrides it), so the render would rewrite the file.
 *
 * Nothing is written until every check has passed, so a refusal leaves neither a
 * half-managed file nor a stray variable behind.
 */
export async function createPlaceholder(
	cfg: ClusterConfig,
	instance: string,
	relPath: string,
	opts: ScopeTarget & {
		name: string;
		/** The literal this placeholder replaces */
		value?: string;
		/** Replace every occurrence rather than only the first */
		all?: boolean;
		/** Character offset of the exact occurrence to replace, when the caller has
		 *  one; an editor selection does. Without it, `all` decides between every
		 *  occurrence and the first, which is ambiguous for a value as common as a
		 *  username that also appears inside unrelated strings. */
		at?: number;
		secret?: boolean;
		description?: string;
		/** Accept a value or file change the checks would otherwise refuse */
		force?: boolean;
	},
): Promise<PlaceholderResult> {
	const { path, rel } = resolveInstancePath(cfg, instance, relPath);
	const name = opts.name.trim();

	if (!ENV_NAME_PATTERN.test(name)) {
		throw new Error(t("core.configfiles.badVarName"));
	}

	if (name.startsWith("LUNA_")) {
		throw new Error(t("core.configfiles.lunaReserved"));
	}

	const value = opts.value ?? "";

	if (!value) {
		throw new Error(t("core.configfiles.needsValue"));
	}

	if (opts.instance !== undefined && opts.machine !== undefined) {
		throw new Error(t("core.configfiles.scopeConflict"));
	}

	const env = await loadEnv();
	const store = await loadConfigFiles();
	const existingEntry = store.instances[instance]?.[rel];

	if (!existingEntry && !existsSync(path)) {
		throw new Error(t("core.configfiles.noSuchFile", { path: rel }));
	}

	// the template to edit: the managed one, or the file as it stands today
	const source = existingEntry?.template ?? (await Bun.file(path).text());
	const before = existsSync(path) ? await Bun.file(path).text() : "";

	const scopeTarget: ScopeTarget = {
		...(opts.instance !== undefined ? { instance: opts.instance } : {}),
		...(opts.machine !== undefined ? { machine: opts.machine } : {}),
	};

	const scope: EnvScope =
		opts.instance !== undefined ? "instance" : opts.machine !== undefined ? "machine" : "global";

	const already = valueAtScope(env, name, scopeTarget);

	if (already !== undefined && already !== value && !opts.force) {
		throw new Error(t("core.configfiles.nameTaken", { name, scope, value: already }));
	}

	const token = `\${${name}}`;
	const swapped =
		opts.at !== undefined
			? replaceLiteralAt(source, value, token, opts.at)
			: opts.all
				? replaceAllLiteral(source, value, token)
				: replaceFirstLiteral(source, value, token);

	if (swapped.count === 0) {
		throw new Error(
			opts.at !== undefined
				? t("core.configfiles.valueNotAtOffset", { path: rel, value, offset: opts.at })
				: t("core.configfiles.valueNotFound", { path: rel, value }),
		);
	}

	setVariable(env, name, value, {
		...scopeTarget,
		...(opts.secret ? { secret: true } : {}),
		...(opts.description ? { description: opts.description } : {}),
	});

	const result = substitute(swapped.text, await resolveVars(cfg, env, instance));

	if (result.missing.length) {
		throw new Error(t("core.configfiles.unresolved", { names: result.missing.join(", ") }));
	}

	const changedFile = result.text !== before;

	if (changedFile && !opts.force) {
		const resolvedNow = (await resolveVars(cfg, env, instance))[name];

		throw new Error(
			t("core.configfiles.narrowerScope", {
				name,
				resolved: resolvedNow ?? "",
				instance,
				value,
				path: rel,
			}),
		);
	}

	// every check passed; from here on the writes go through
	if (!existingEntry) {
		await manageFile(cfg, instance, rel);
	}

	const fresh = await loadConfigFiles();
	const entry = fresh.instances[instance]![rel]!;

	entry.template = swapped.text;
	entry.rendered = sha256(result.text);
	entry.updatedAt = new Date().toISOString();

	await saveEnv(env);
	await Bun.write(path, result.text);
	await saveConfigFiles(fresh);

	return {
		path: rel,
		name,
		replaced: swapped.count,
		scope,
		template: entry.template,
		rendered: result.text,
		changedFile,
	};
}

/**
 * Replace the occurrence of `needle` that starts exactly at `at`. Nothing is
 * replaced when the text there is something else, which is what makes a stale
 * editor selection a refusal rather than a wrong edit somewhere else in the file.
 */
function replaceLiteralAt(
	text: string,
	needle: string,
	replacement: string,
	at: number,
): { text: string; count: number } {
	if (at < 0 || !text.startsWith(needle, at)) {
		return { text, count: 0 };
	}

	return {
		text: text.slice(0, at) + replacement + text.slice(at + needle.length),
		count: 1,
	};
}

/** Replace the first literal occurrence of `needle`. */
function replaceFirstLiteral(
	text: string,
	needle: string,
	replacement: string,
): { text: string; count: number } {
	const at = text.indexOf(needle);

	if (at < 0) {
		return { text, count: 0 };
	}

	return {
		text: text.slice(0, at) + replacement + text.slice(at + needle.length),
		count: 1,
	};
}

export interface RenderResult {
	instance: string;
	path: string;
	outcome: "written" | "unchanged" | "missing-var" | "drift-preserved";
	detail?: string;
}

/**
 * Render every managed file of one instance from its template. Called by
 * `startInstance`, so the values an operator changed in the console are on disk
 * before the JVM reads them, and safe to call at any other time: a file whose
 * render already matches is left alone, mtime included.
 *
 * A file the server rewrote since luna last rendered it is copied aside as
 * `<name>.luna-drift` before being overwritten, and reported: the template stays
 * the source of truth, but a plugin's regenerated config is never lost to it.
 */
export async function renderManagedFiles(
	cfg: ClusterConfig,
	instance: string,
	reporter?: ProgressReporter,
): Promise<RenderResult[]> {
	const store = await loadConfigFiles();
	const files = store.instances[instance] ?? {};
	const paths = Object.keys(files).sort();

	if (!paths.length) {
		reporter?.complete(t("core.configfiles.noneManaged"));

		return [];
	}

	reporter?.expect(paths.length);

	const env = await loadEnv();
	const vars = await resolveVars(cfg, env, instance);
	const results: RenderResult[] = [];
	let touched = false;

	for (const rel of paths) {
		const entry = files[rel]!;
		const node = reporter?.child(rel, 1);
		const { path } = resolveInstancePath(cfg, instance, rel);
		const result = substitute(entry.template, vars);

		if (result.missing.length) {
			const detail = t("core.configfiles.undefinedDetail", { names: result.missing.join(", ") });

			// a half-substituted config is worse than an untouched one; leave the
			// file alone and let the failing node say why
			node?.warn(1, detail);
			results.push({ instance, path: rel, outcome: "missing-var", detail });

			continue;
		}

		const current = existsSync(path) ? await Bun.file(path).text() : undefined;

		if (current === result.text) {
			node?.complete(t("core.configfiles.upToDate"));
			results.push({ instance, path: rel, outcome: "unchanged" });

			continue;
		}

		const drifted =
			current !== undefined && !!entry.rendered && sha256(current) !== entry.rendered;

		if (drifted) {
			await Bun.write(path + DRIFT_SUFFIX, current!);
		}

		await mkdir(dirname(path), { recursive: true });
		await Bun.write(path, result.text);

		entry.rendered = sha256(result.text);
		touched = true;

		if (drifted) {
			node?.warn(1, t("core.configfiles.driftKept", { path: `${rel}${DRIFT_SUFFIX}` }));
			results.push({
				instance,
				path: rel,
				outcome: "drift-preserved",
				detail: t("core.configfiles.overwrittenDetail", { path: `${rel}${DRIFT_SUFFIX}` }),
			});

			continue;
		}

		node?.complete(t("core.configfiles.rendered"));
		results.push({ instance, path: rel, outcome: "written" });
	}

	if (touched) {
		await saveConfigFiles(store);
	}

	reporter?.complete(t("core.configfiles.managedCount", { count: paths.length }));

	return results;
}

export interface ManagedFileRow {
	instance: string;
	path: string;
	/** `${VAR}` names the template references */
	placeholders: string[];
	/** Referenced names the instance cannot resolve */
	missing: string[];
	drifted: boolean;
	/** The rendered file is not on disk at all yet */
	absent: boolean;
	updatedAt?: string;
	description?: string;
}

/**
 * Every managed file, for the console's overview: which variables each one
 * depends on, whether the instance can resolve them, and whether the file on
 * disk still matches. `instance` narrows to one.
 */
export async function managedFileReport(
	cfg: ClusterConfig,
	instance?: string,
): Promise<ManagedFileRow[]> {
	const store = await loadConfigFiles();
	const rows: ManagedFileRow[] = [];
	const known = managedInstances(cfg);

	for (const [name, files] of Object.entries(store.instances)) {
		if (instance && name !== instance) {
			continue;
		}

		// an instance deleted out from under its templates: report the files rather
		// than throwing, so the console can offer to drop them
		const resolvable = !!known[name];
		const vars = resolvable ? await resolveVars(cfg, await loadEnv(), name) : {};

		for (const [rel, entry] of Object.entries(files)) {
			const names = [
				...new Set([...entry.template.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]!)),
			].sort();

			const path = resolvable ? resolveInstancePath(cfg, name, rel).path : undefined;

			rows.push({
				instance: name,
				path: rel,
				placeholders: names,
				missing: resolvable ? names.filter((varName) => vars[varName] === undefined) : names,
				drifted: path ? await isDrifted(path, entry) : false,
				absent: !path || !existsSync(path),
				...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
				...(entry.description ? { description: entry.description } : {}),
			});
		}
	}

	return rows.sort(
		(a, b) => a.instance.localeCompare(b.instance) || a.path.localeCompare(b.path),
	);
}

/** One place a variable is referenced from. */
export interface VariableReference {
	kind: "managed-file" | "plugin-template";
	instance?: string;
	/** Relative path of the config file the reference lives in */
	file: string;
	/** How many times the reference appears (managed files) */
	count?: number;
	/** Lockfile entry the plugin-owned template belongs to */
	plugin?: string;
	/** The key whose value references it, for a `set` op */
	key?: string;
}

/** What one instance resolves a variable to, and from which scope. */
export interface VariableConsumer {
	instance: string;
	value: string;
	scope: EnvScope;
	/** Machine the instance belongs to, presented by key ("" = the primary) */
	machine: string;
}

export interface VariableUsage {
	name: string;
	/** True when no scope defines it; every reference below would fail to render */
	undefinedEverywhere: boolean;
	references: VariableReference[];
	consumers: VariableConsumer[];
}

/**
 * Everywhere a variable is used: the managed config files whose templates
 * reference it, the plugin-owned config templates that do, and what each
 * instance actually resolves it to.
 *
 * This is what makes an environment value safe to change: the console can say
 * "12 files across 8 instances read this" before an operator edits a database
 * password, rather than after.
 */
export async function variableUsage(
	cfg: ClusterConfig,
	lock: PluginsLock,
	name: string,
): Promise<VariableUsage> {
	const token = `\${${name}}`;
	const store = await loadConfigFiles();
	const env = await loadEnv();
	const references: VariableReference[] = [];

	for (const [instance, files] of Object.entries(store.instances)) {
		for (const [rel, entry] of Object.entries(files)) {
			const count = entry.template.split(token).length - 1;

			if (count > 0) {
				references.push({ kind: "managed-file", instance, file: rel, count });
			}
		}
	}

	// the plugin-owned half: `config` ops on a lockfile entry, which apply to every
	// instance the entry targets rather than to one file on one machine
	for (const [key, entry] of Object.entries(lock.plugins)) {
		for (const op of entry.config ?? []) {
			if (op.write?.includes(token)) {
				references.push({ kind: "plugin-template", plugin: key, file: op.file });
			}

			for (const [opKey, raw] of Object.entries(op.set ?? {})) {
				if (raw.includes(token)) {
					references.push({ kind: "plugin-template", plugin: key, file: op.file, key: opKey });
				}
			}
		}
	}

	const consumers: VariableConsumer[] = [];

	for (const [instance, inst] of Object.entries(managedInstances(cfg))) {
		const resolved = (await resolveDetailed(cfg, env, instance)).find(
			(entry) => entry.name === name,
		);

		if (resolved) {
			consumers.push({
				instance,
				value: resolved.value,
				scope: resolved.scope,
				machine: inst.daemon ?? "",
			});
		}
	}

	references.sort(
		(a, b) =>
			(a.instance ?? a.plugin ?? "").localeCompare(b.instance ?? b.plugin ?? "") ||
			a.file.localeCompare(b.file),
	);

	return {
		name,
		undefinedEverywhere: consumers.length === 0,
		references,
		consumers: consumers.sort((a, b) => a.instance.localeCompare(b.instance)),
	};
}

/** Drop the drift copy luna kept beside a file. */
export async function discardDrift(
	cfg: ClusterConfig,
	instance: string,
	relPath: string,
): Promise<boolean> {
	const { path } = resolveInstancePath(cfg, instance, relPath);
	const drift = path + DRIFT_SUFFIX;

	if (!existsSync(drift)) {
		return false;
	}

	await rm(drift, { force: true });

	return true;
}

/** Every managed path of one instance, for callers that only need the keys. */
export function managedPathsOf(store: ConfigFileStore, instance: string): string[] {
	return Object.keys(store.instances[instance] ?? {}).sort();
}

/** Forget every managed file of an instance (called when the instance is deleted). */
export async function forgetInstance(instance: string): Promise<number> {
	const store = await loadConfigFiles();
	const count = Object.keys(store.instances[instance] ?? {}).length;

	if (!count) {
		return 0;
	}

	delete store.instances[instance];

	await saveConfigFiles(store);

	return count;
}

/** Re-export for callers that hold a store and want the environment's own types. */
export type { EnvironmentStore };
