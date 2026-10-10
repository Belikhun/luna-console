// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * File operations inside an instance directory beyond reading and writing one
 * text file (those stay in `configfiles.ts`, which also knows managed files):
 * stat, find, copy, move, delete and mkdir.
 *
 * Every path goes through `resolveInstancePath`, so nothing here can reach
 * outside the instance, symlinks included. The instance directory itself is
 * never a valid source or target of a destructive operation: deleting or
 * moving "" would take the whole server with it.
 *
 * These run on the daemon that owns the instance (the ops declare `instance`),
 * because the files only exist on that machine's disk.
 */

import { existsSync, lstatSync, statSync, type Stats } from "node:fs";
import { cp, lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";

import type { ClusterConfig } from "./types";
import { t } from "../shared/i18n";
import { resolveInstancePath } from "./configfiles";
import { ProgressReporter } from "./progress";

/** Most entries a find returns. */
export const MAX_FIND_RESULTS = 500;

/** Deepest a find descends below its starting directory. */
export const MAX_FIND_DEPTH = 8;

/** Directories a find never descends into; world region data and caches are huge and never what is wanted. */
const FIND_SKIP = new Set(["region", "entities", "poi", "cache", "libraries", ".git", "node_modules"]);

export interface PathInfo {
	path: string;
	kind: "file" | "dir" | "other";
	size: number;
	modified: number;
}

export interface FindQuery {
	/** Directory to search from, relative to the instance */
	path?: string;
	/** Case-insensitive substring of the file name; `*` matches anything */
	name?: string;
	limit?: number;
	depth?: number;
}

export interface FindResult {
	entries: PathInfo[];
	truncated: boolean;
}

function kindOf(info: Stats): PathInfo["kind"] {
	if (info.isDirectory()) {
		return "dir";
	}

	return info.isFile()
		? "file"
		: "other";
}

/** A destructive target must be something inside the instance, never the instance itself. */
function requireInner(resolved: { path: string; dir: string; rel: string }, given: string): void {
	if (resolved.path === resolved.dir) {
		throw new Error(t("core.instancefiles.rootRefused", { path: given || "/" }));
	}
}

/** Size, kind and modification time of one path, or null when nothing is there. */
export async function statInstancePath(cfg: ClusterConfig, instance: string, relPath: string): Promise<PathInfo | null> {
	const resolved = resolveInstancePath(cfg, instance, relPath);

	if (!existsSync(resolved.path)) {
		return null;
	}

	const info = await stat(resolved.path);

	return { path: resolved.rel, kind: kindOf(info), size: info.size, modified: info.mtimeMs };
}

function nameMatcher(pattern: string | undefined): (name: string) => boolean {
	if (!pattern || pattern === "*") {
		return () => true;
	}

	const escaped = pattern
		.toLowerCase()
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*");
	const regex = new RegExp(pattern.includes("*") ? `^${escaped}$` : escaped);

	return (name) => regex.test(name.toLowerCase());
}

/**
 * Find files and directories by name below a directory, breadth-first, bounded
 * by depth and result count. World data and caches are skipped: a survival
 * world holds tens of thousands of region files nobody searches for by name.
 */
export async function findInstanceFiles(cfg: ClusterConfig, instance: string, query: FindQuery = {}): Promise<FindResult> {
	const start = resolveInstancePath(cfg, instance, query.path ?? "");
	const limit = Math.min(Math.max(1, query.limit ?? 100), MAX_FIND_RESULTS);
	const maxDepth = Math.min(Math.max(0, query.depth ?? 4), MAX_FIND_DEPTH);
	const matches = nameMatcher(query.name);
	const entries: PathInfo[] = [];
	let queue: string[] = [start.path];

	for (let depth = 0; depth <= maxDepth && queue.length > 0; depth++) {
		const next: string[] = [];

		for (const dir of queue) {
			let names: string[];

			try {
				names = await readdir(dir);
			} catch {
				continue;
			}

			for (const name of names.sort()) {
				const full = join(dir, name);
				let info: Stats;

				// lstat, never stat: a symlink to /etc inside the instance must be
				// listed as a link, not walked into
				try {
					info = await lstat(full);
				} catch {
					continue;
				}

				if (matches(name)) {
					if (entries.length >= limit) {
						return { entries, truncated: true };
					}

					entries.push({
						path: relative(start.dir, full).split(sep).join("/"),
						kind: kindOf(info),
						size: info.size,
						modified: info.mtimeMs,
					});
				}

				if (info.isDirectory() && !FIND_SKIP.has(name)) {
					next.push(full);
				}
			}
		}

		queue = next;
	}

	return { entries, truncated: false };
}

/** Create a directory and any missing parents. */
export async function makeInstanceDir(cfg: ClusterConfig, instance: string, relPath: string): Promise<PathInfo> {
	const resolved = resolveInstancePath(cfg, instance, relPath);

	requireInner(resolved, relPath);
	await mkdir(resolved.path, { recursive: true });

	return (await statInstancePath(cfg, instance, resolved.rel))!;
}

export interface TransferOptions {
	/** Replace an existing target instead of refusing */
	overwrite?: boolean;
}

async function prepareTransfer(
	cfg: ClusterConfig,
	instance: string,
	from: string,
	to: string,
	opts: TransferOptions,
): Promise<{ source: string; target: string; sourceRel: string; targetRel: string }> {
	const source = resolveInstancePath(cfg, instance, from);
	const target = resolveInstancePath(cfg, instance, to);

	requireInner(source, from);
	requireInner(target, to);

	if (!existsSync(source.path)) {
		throw new Error(t("core.instancefiles.missing", { path: from }));
	}

	if (target.path === source.path || target.path.startsWith(source.path + sep)) {
		throw new Error(t("core.instancefiles.intoItself", { from, to }));
	}

	if (existsSync(target.path)) {
		if (!opts.overwrite) {
			throw new Error(t("core.instancefiles.exists", { path: to }));
		}

		await rm(target.path, { recursive: true, force: true });
	}

	await mkdir(dirname(target.path), { recursive: true });

	return { source: source.path, target: target.path, sourceRel: source.rel, targetRel: target.rel };
}

/** Copy a file or a directory tree to another path in the same instance. */
export async function copyInstancePath(
	cfg: ClusterConfig,
	instance: string,
	from: string,
	to: string,
	opts: TransferOptions = {},
): Promise<PathInfo> {
	const paths = await prepareTransfer(cfg, instance, from, to, opts);

	// symlinks are copied as links, not followed; a link that points outside the
	// instance must not become a copy of whatever it points at
	await cp(paths.source, paths.target, { recursive: true, verbatimSymlinks: true, errorOnExist: true });

	return (await statInstancePath(cfg, instance, paths.targetRel))!;
}

/** Move or rename a file or directory within the same instance. */
export async function moveInstancePath(
	cfg: ClusterConfig,
	instance: string,
	from: string,
	to: string,
	opts: TransferOptions = {},
): Promise<PathInfo> {
	const paths = await prepareTransfer(cfg, instance, from, to, opts);

	await rename(paths.source, paths.target);

	return (await statInstancePath(cfg, instance, paths.targetRel))!;
}

export interface DeleteOptions {
	/** Required to delete a non-empty directory */
	recursive?: boolean;
}

/**
 * Delete a file or directory. A non-empty directory needs `recursive`, so a
 * caller that meant one file cannot take a folder by mistake. Returns what was
 * there, so the caller can report exactly what it removed.
 */
export async function deleteInstancePath(
	cfg: ClusterConfig,
	instance: string,
	relPath: string,
	opts: DeleteOptions = {},
): Promise<PathInfo> {
	const resolved = resolveInstancePath(cfg, instance, relPath);

	requireInner(resolved, relPath);

	const before = await statInstancePath(cfg, instance, relPath);

	if (!before) {
		throw new Error(t("core.instancefiles.missing", { path: relPath }));
	}

	if (before.kind === "dir" && !opts.recursive && (await readdir(resolved.path)).length > 0) {
		throw new Error(t("core.instancefiles.notEmpty", { path: relPath }));
	}

	await rm(resolved.path, { recursive: before.kind === "dir", force: false });

	return before;
}

//* ===========================================================
//*  Details, and the landing of an uploaded file
//* -----------------------------------------------------------
//*  The console's file manager asks these two of the owning
//*  daemon: what a path holds (a directory's size is a bounded
//*  walk, since a world is hundreds of thousands of files), and
//*  where a staged upload should end up. The bytes themselves
//*  never cross the RPC boundary; they are staged on the primary
//*  by their own streaming endpoint, and a follower pulls the
//*  staged copy itself before placing it.
//* ===========================================================

/** The most entries a details walk counts before it reports a truncated total. */
export const MAX_DETAIL_ENTRIES = 50_000;

export interface PathDetails extends PathInfo {
	name: string;
	/** Content type guessed from the extension; `application/octet-stream` when unknown */
	type: string;
	/** Files below a directory (itself excluded); 1 for a file */
	files: number;
	/** Directories below a directory, itself excluded */
	dirs: number;
	/** Bytes of every file below a directory; the file's own size otherwise */
	totalSize: number;
	/** The walk stopped at {@link MAX_DETAIL_ENTRIES}, so the counts are a floor */
	truncated: boolean;
	/** Whether the path is a symbolic link (the counts then describe the link itself) */
	link: boolean;
}

/**
 * Everything the console's details dialog shows about one path: the stat, a
 * guessed content type and, for a directory, how much sits below it. The walk
 * is bounded, because a survival world is a quarter-million region files and
 * nobody waits for an exact byte count of that.
 */
export async function pathDetails(cfg: ClusterConfig, instance: string, relPath: string): Promise<PathDetails> {
	const resolved = resolveInstancePath(cfg, instance, relPath);

	if (!existsSync(resolved.path) && !isSymlink(resolved.path)) {
		throw new Error(t("core.instancefiles.missing", { path: relPath }));
	}

	const own = await lstat(resolved.path);
	const info = own.isSymbolicLink() ? own : await stat(resolved.path);
	const kind = kindOf(info);
	const base: Omit<PathDetails, "files" | "dirs" | "totalSize" | "truncated"> = {
		path: resolved.rel,
		name: basename(resolved.path) || instance,
		kind,
		size: info.size,
		modified: info.mtimeMs,
		type: kind === "file" ? Bun.file(resolved.path).type.split(";")[0] ?? "application/octet-stream" : "inode/directory",
		link: own.isSymbolicLink(),
	};

	if (kind !== "dir" || own.isSymbolicLink()) {
		return { ...base, files: kind === "file" ? 1 : 0, dirs: 0, totalSize: info.size, truncated: false };
	}

	let files = 0;
	let dirs = 0;
	let totalSize = 0;
	let truncated = false;
	const pending = [resolved.path];

	while (pending.length > 0) {
		const current = pending.pop()!;
		let names: string[];

		try {
			names = await readdir(current);
		} catch {
			continue;
		}

		for (const name of names) {
			if (files + dirs >= MAX_DETAIL_ENTRIES) {
				truncated = true;
				pending.length = 0;
				break;
			}

			const full = join(current, name);
			let child: Stats;

			// lstat, never stat: a link is counted as a link, not walked into
			try {
				child = await lstat(full);
			} catch {
				continue;
			}

			if (child.isDirectory()) {
				dirs += 1;
				pending.push(full);
				continue;
			}

			files += 1;
			totalSize += child.size;
		}
	}

	return { ...base, files, dirs, totalSize, truncated };
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

export interface PlaceUploadOptions {
	/** Replace a file already at the destination instead of refusing */
	overwrite?: boolean;
	/** The byte count the client says it sent; a staged file of another size is refused */
	expectedSize?: number;
}

/**
 * Move a fully staged upload to its place inside an instance. Runs on the
 * daemon that owns the instance, which holds the staged copy by then (the
 * primary received it; a follower pulled it over the link). The destination's
 * parents are created; a directory at the destination is never replaced, since
 * an upload is one file and a folder in its way is not a version of it.
 */
export async function placeUploadedFile(
	cfg: ClusterConfig,
	instance: string,
	stagedPath: string,
	relPath: string,
	opts: PlaceUploadOptions = {},
): Promise<PathInfo> {
	const target = resolveInstancePath(cfg, instance, relPath);

	requireInner(target, relPath);

	if (!existsSync(stagedPath)) {
		throw new Error(t("core.instancefiles.uploadMissing", { path: relPath }));
	}

	const staged = await stat(stagedPath);

	if (opts.expectedSize !== undefined && staged.size !== opts.expectedSize) {
		throw new Error(t("core.instancefiles.uploadIncomplete", {
			path: relPath,
			got: String(staged.size),
			expected: String(opts.expectedSize),
		}));
	}

	if (existsSync(target.path)) {
		const existing = await lstat(target.path);

		if (existing.isDirectory()) {
			throw new Error(t("core.instancefiles.uploadOntoDir", { path: relPath }));
		}

		if (!opts.overwrite) {
			throw new Error(t("core.instancefiles.exists", { path: relPath }));
		}
	}

	await mkdir(dirname(target.path), { recursive: true });
	await moveFile(stagedPath, target.path);

	return (await statInstancePath(cfg, instance, target.rel))!;
}

/** Rename when the two paths share a filesystem, copy and remove when they do not. */
async function moveFile(from: string, to: string): Promise<void> {
	try {
		await rename(from, to);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
			throw err;
		}

		// staged in another mount than the instance; the copy lands beside the
		// target first so a failure mid-way never leaves a truncated file in place
		const temp = `${to}.luna-upload-${randomBytes(4).toString("hex")}`;

		try {
			await cp(from, temp);
			await rename(temp, to);
		} finally {
			await rm(temp, { force: true });
		}

		await rm(from, { force: true });
	}
}

//* ===========================================================
//*  Copying between instances, on one machine or across two
//* -----------------------------------------------------------
//*  The copy runs on the daemon that owns the destination. A
//*  source on the same machine is copied from disk; one held by
//*  another daemon arrives as a tar stream over the cluster's
//*  own HTTP file routes (the hook below), and is unpacked next
//*  to its destination before it is moved into place, so a
//*  transfer that dies halfway leaves nothing half-written.
//* ===========================================================

/** What happens when the destination already exists. */
export type ExistingPolicy = "fail" | "replace" | "merge";

export interface CrossCopyOptions {
	/**
	 * `fail` (default) refuses, `replace` removes the destination first, `merge`
	 * copies into an existing directory, overwriting same-named files and keeping
	 * the rest (what `rsync -a` without `--delete` does).
	 */
	existing?: ExistingPolicy;
	reporter?: ProgressReporter;
}

export interface CrossCopyResult {
	from: { instance: string; path: string };
	to: { instance: string; path: string };
	kind: PathInfo["kind"];
	/** Whether the bytes crossed the cluster link or stayed on one disk */
	route: "local" | "remote";
	/** Bytes received over the link; 0 for a local copy */
	transferred: number;
	/** Files and total size of the destination afterwards (capped walk) */
	files: number;
	size: number;
	existing: ExistingPolicy;
}

/**
 * How a path leaves an instance over HTTP: `tar` for a copy between daemons,
 * `zip` for a download a person opens, `raw` for one file's own bytes (a
 * download, or an image the console previews).
 */
export type ArchiveFormat = "tar" | "zip" | "raw";

/** The content type each format travels under; a raw file carries its own. */
export const ARCHIVE_TYPES: Record<Exclude<ArchiveFormat, "raw">, string> = {
	tar: "application/x-tar",
	zip: "application/zip",
};

/** One file or directory of an instance, packed as a stream. */
export interface InstanceArchive {
	stream: ReadableStream<Uint8Array>;
	kind: PathInfo["kind"];
	/** The top-level entry name inside the archive, or the file's own name */
	name: string;
	format: ArchiveFormat;
	/** What the stream is: the packer's type, or the raw file's guessed one */
	contentType: string;
	/** Known for a raw file only; a packer's output has no length up front */
	size?: number;
	/** Resolves to the packer's exit code once the stream is done; 0 for a raw file */
	exited: Promise<number>;
}

export interface ArchiveOptions {
	format?: ArchiveFormat;
	/**
	 * Pack these entries of the directory at `relPath` rather than the path
	 * itself: a selection downloaded as one zip. Names only, no slashes.
	 */
	names?: string[];
}

/**
 * How the destination's daemon reaches a source on another machine: a response
 * carrying the tar stream (`x-luna-kind`, `x-luna-name` headers), or null when
 * the source instance is this daemon's own. Installed by the daemon, which
 * alone knows who owns what and where the other daemons answer.
 */
export type InstanceArchiveFetcher = (cfg: ClusterConfig, instance: string, relPath: string) => Promise<Response | null>;

let fetchRemoteArchive: InstanceArchiveFetcher | undefined;

/** Install the cross-machine fetcher (the daemon does this at boot). */
export function installInstanceArchiveFetcher(fetcher: InstanceArchiveFetcher): void {
	fetchRemoteArchive = fetcher;
}

/** The most entries the result walk counts before it stops. */
const MAX_COUNTED_ENTRIES = 100_000;

/**
 * Pack one path of an instance as a stream, for another daemon to pull or a
 * browser to download. Symlinks travel as links, never followed, exactly as a
 * local copy keeps them. A `raw` archive is the file's own bytes; a directory
 * cannot be raw. With `names`, the entries named inside the directory are
 * packed together, which is how a multi-selection downloads as one zip, and
 * the directory may then be the instance root since the entries are inside it.
 */
export async function instanceArchive(
	cfg: ClusterConfig,
	instance: string,
	relPath: string,
	opts: ArchiveOptions = {},
): Promise<InstanceArchive> {
	const format = opts.format ?? "tar";
	const resolved = resolveInstancePath(cfg, instance, relPath);
	const names = opts.names?.filter((name) => name !== "") ?? [];

	if (names.length === 0) {
		requireInner(resolved, relPath);
	}

	const info = await statInstancePath(cfg, instance, relPath);

	if (!info) {
		throw new Error(t("core.instancefiles.missingIn", { path: relPath, instance }));
	}

	if (names.length > 0) {
		if (info.kind !== "dir") {
			throw new Error(t("core.instancefiles.namesNeedDir", { path: relPath }));
		}

		if (format === "raw") {
			throw new Error(t("core.instancefiles.rawIsOneFile", { path: relPath }));
		}

		for (const name of names) {
			if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
				throw new Error(t("core.instancefiles.badName", { name }));
			}

			if (!existsSync(join(resolved.path, name))) {
				throw new Error(t("core.instancefiles.missingIn", { path: `${relPath}/${name}`.replace(/^\//, ""), instance }));
			}
		}

		return packEntries(resolved.path, names, basename(resolved.path), format);
	}

	const name = basename(resolved.path);

	if (format === "raw") {
		if (info.kind !== "file") {
			throw new Error(t("core.instancefiles.rawIsOneFile", { path: relPath }));
		}

		const file = Bun.file(resolved.path);

		return {
			stream: file.stream(),
			kind: "file",
			name,
			format,
			contentType: file.type.split(";")[0] || "application/octet-stream",
			size: info.size,
			exited: Promise.resolve(0),
		};
	}

	return packEntries(dirname(resolved.path), [name], name, format);
}

/**
 * The absolute path a raw archive streams from, for a server that wants to
 * serve it with ranges rather than through the archive's own stream.
 */
export function resolveArchivePath(cfg: ClusterConfig, instance: string, relPath: string): string {
	const resolved = resolveInstancePath(cfg, instance, relPath);

	requireInner(resolved, relPath);

	return resolved.path;
}

/** Run tar or zip over `names` inside `dir`, streaming the archive to stdout. */
function packEntries(dir: string, names: string[], name: string, format: Exclude<ArchiveFormat, "raw">): InstanceArchive {
	// `./name` rather than `--`: zip has no end-of-options marker, and a file
	// called `-r` must not become a flag
	const entries = names.map((entry) => `./${entry}`);
	const command = format === "zip"
		? ["zip", "-r", "-q", "-y", "-", ...entries]
		: ["tar", "-C", dir, "-cf", "-", "--", ...entries];
	const proc = Bun.spawn(command, {
		cwd: dir,
		stdout: "pipe",
		stderr: "ignore",
	});

	return {
		stream: proc.stdout,
		kind: names.length === 1 && name === names[0] ? kindOfSync(join(dir, name)) : "dir",
		name,
		format,
		contentType: ARCHIVE_TYPES[format],
		exited: proc.exited,
	};
}

function kindOfSync(path: string): PathInfo["kind"] {
	try {
		return kindOf(statSync(path));
	} catch {
		return "other";
	}
}

/** Count files and bytes under a path, stopping after {@link MAX_COUNTED_ENTRIES}. */
async function measure(path: string): Promise<{ files: number; size: number }> {
	let files = 0;
	let size = 0;
	const pending = [path];

	while (pending.length > 0 && files < MAX_COUNTED_ENTRIES) {
		const current = pending.pop()!;
		const info = await lstat(current);

		if (info.isDirectory()) {
			for (const entry of await readdir(current)) {
				pending.push(join(current, entry));
			}

			continue;
		}

		files += 1;
		size += info.size;
	}

	return { files, size };
}

/** Unpack a tar body into `dir`, reporting bytes as they arrive; resolves to the byte count. */
async function unpack(body: ReadableStream<Uint8Array>, dir: string, progress: ProgressReporter): Promise<number> {
	const proc = Bun.spawn(["tar", "-C", dir, "-xf", "-", "--no-same-owner"], {
		stdin: "pipe",
		stdout: "ignore",
		stderr: "pipe",
	});

	const reader = body.getReader();
	let bytes = 0;
	let reported = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();

			if (done) {
				break;
			}

			bytes += value.byteLength;
			proc.stdin.write(value);
			await proc.stdin.flush();

			if (bytes - reported >= 8 * 1024 * 1024) {
				reported = bytes;
				progress.info(0.5, t("core.instancefiles.crossReceiving", { size: formatSize(bytes) }));
			}
		}
	} finally {
		await proc.stdin.end();
	}

	const code = await proc.exited;

	if (code !== 0) {
		const detail = (await new Response(proc.stderr).text()).trim().split("\n").slice(-2).join(" ");
		throw new Error(t("core.instancefiles.unpackFailed", { error: detail || `tar exited ${code}` }));
	}

	return bytes;
}

function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024) {
		return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
	}

	if (bytes >= 1024 * 1024) {
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	return `${Math.ceil(bytes / 1024)} KB`;
}

/** Move a fully arrived entry to its destination under the existing-path policy. */
async function place(entry: string, target: string, targetRel: string, existing: ExistingPolicy): Promise<void> {
	if (existsSync(target)) {
		if (existing === "fail") {
			throw new Error(t("core.instancefiles.existsCross", { path: targetRel }));
		}

		if (existing === "merge") {
			// same-named files are overwritten, everything else in the destination stays
			await cp(entry, target, { recursive: true, force: true, verbatimSymlinks: true });
			return;
		}

		await rm(target, { recursive: true, force: true });
	}

	await mkdir(dirname(target), { recursive: true });
	await rename(entry, target);
}

/**
 * Copy a file or directory from one instance into another, whether they live
 * on the same machine or not. Runs on the daemon owning `toInstance`; `to`
 * is the destination path itself, or a directory to copy into when it ends
 * with `/`.
 */
export async function copyAcrossInstances(
	cfg: ClusterConfig,
	toInstance: string,
	to: string,
	fromInstance: string,
	from: string,
	opts: CrossCopyOptions = {},
): Promise<CrossCopyResult> {
	const progress = opts.reporter ?? new ProgressReporter("copy");
	const existing = opts.existing ?? "fail";
	const destinationRel = to.endsWith("/")
		? `${to}${basename(from.replace(/\/+$/, ""))}`
		: to;
	const target = resolveInstancePath(cfg, toInstance, destinationRel);

	requireInner(target, destinationRel);

	if (fromInstance === toInstance) {
		const source = resolveInstancePath(cfg, fromInstance, from);

		if (target.path === source.path || target.path.startsWith(source.path + sep)) {
			throw new Error(t("core.instancefiles.intoItself", { from, to: destinationRel }));
		}
	}

	if (existsSync(target.path) && existing === "fail") {
		throw new Error(t("core.instancefiles.existsCross", { path: destinationRel }));
	}

	// staged inside the destination instance, so the final move is a rename on
	// one filesystem rather than a second copy
	const incoming = join(target.dir, `.luna-incoming-${randomBytes(6).toString("hex")}`);

	await mkdir(incoming, { recursive: true });

	try {
		const remote = fetchRemoteArchive
			? await fetchRemoteArchive(cfg, fromInstance, from)
			: null;

		let entry: string;
		let kind: PathInfo["kind"];
		let transferred = 0;

		if (remote) {
			if (!remote.ok || !remote.body) {
				const body = await remote.text().catch(() => "");
				let detail = body.slice(0, 200);

				try {
					detail = JSON.parse(body).error ?? detail;
				} catch {
					// not the daemon's JSON error shape; keep the raw text
				}
				throw new Error(t("core.instancefiles.fetchFailed", { instance: fromInstance, path: from, error: detail || `HTTP ${remote.status}` }));
			}

			progress.info(0.1, t("core.instancefiles.crossFetching", { instance: fromInstance, path: from }));
			transferred = await unpack(remote.body, incoming, progress);
			// header values are ASCII, so the name travels percent-encoded
			entry = join(incoming, decodeURIComponent(remote.headers.get("x-luna-name") ?? encodeURIComponent(basename(from))));
			kind = (remote.headers.get("x-luna-kind") as PathInfo["kind"] | null) ?? "file";
		} else {
			const source = resolveInstancePath(cfg, fromInstance, from);

			requireInner(source, from);

			const info = await statInstancePath(cfg, fromInstance, from);

			if (!info) {
				throw new Error(t("core.instancefiles.missingIn", { path: from, instance: fromInstance }));
			}

			progress.info(0.1, t("core.instancefiles.crossCopying", { instance: fromInstance, path: from }));
			entry = join(incoming, basename(source.path));
			kind = info.kind;
			await cp(source.path, entry, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
		}

		if (!existsSync(entry)) {
			throw new Error(t("core.instancefiles.unpackFailed", { error: "the archive did not hold the expected entry" }));
		}

		await place(entry, target.path, destinationRel, existing);

		const counted = await measure(target.path);

		progress.complete(t("core.instancefiles.crossPlaced", { path: destinationRel, instance: toInstance }));

		return {
			from: { instance: fromInstance, path: from },
			to: { instance: toInstance, path: destinationRel },
			kind,
			route: remote ? "remote" : "local",
			transferred,
			files: counted.files,
			size: counted.size,
			existing,
		};
	} catch (err) {
		progress.error(0, (err as Error).message);
		throw err;
	} finally {
		await rm(incoming, { recursive: true, force: true });
	}
}
