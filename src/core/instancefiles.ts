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

import { existsSync, type Stats } from "node:fs";
import { cp, lstat, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type { ClusterConfig } from "./types";
import { t } from "../shared/i18n";
import { resolveInstancePath } from "./configfiles";

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
