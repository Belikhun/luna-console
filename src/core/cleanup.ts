import { readdir, rm, stat, mkdir, appendFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";

import type { ClusterConfig } from "./types";
import { centralLogsDir, instanceDir, managedInstances } from "./config";

export interface JunkItem {
	instance: string;
	kind: "cache" | "old-version" | "crash-report" | "leftover";
	path: string;
	bytes: number;
}

export interface LogMove {
	instance: string;
	file: string;
	month: string; // "2026-07"
	bytes: number;
}

export interface CleanupPlan {
	junk: JunkItem[];
	logs: LogMove[];
	totalBytes: number;
	notes: string[];
}

/** Filesystem usage for the volume a path lives on. */
export interface DiskUsage {
	totalBytes: number;
	usedBytes: number;
	freeBytes: number;
	mount: string;
}

/**
 * Read filesystem usage for the volume holding `path`, via `df`. Returns null
 * when df is unavailable or its output cannot be parsed — callers treat disk
 * usage as informational and simply omit it.
 */
export async function diskUsage(path: string): Promise<DiskUsage | null> {
	try {
		const proc = Bun.spawn(["df", "-P", "-B1", path], { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(proc.stdout).text();

		await proc.exited;

		const line = text.trim().split("\n")[1];

		if (!line) {
			return null;
		}

		// filesystem 1B-blocks used available capacity mounted-on
		const cols = line.trim().split(/\s+/);
		const totalBytes = Number(cols[1]);
		const usedBytes = Number(cols[2]);
		const freeBytes = Number(cols[3]);

		if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
			return null;
		}

		return { totalBytes, usedBytes, freeBytes, mount: cols[5] ?? path };
	} catch {
		return null;
	}
}

/** Recursive size of a file or directory. Unreadable paths count as zero. */
async function pathSize(path: string): Promise<number> {
	try {
		const entry = await stat(path);

		if (!entry.isDirectory()) {
			return entry.size;
		}

		let total = 0;

		for (const child of await readdir(path)) {
			total += await pathSize(join(path, child));
		}

		return total;
	} catch {
		return 0;
	}
}

const CRASH_REPORT_MAX_AGE_DAYS = 30;

/**
 * Survey every managed instance for reclaimable files and rotated logs, without
 * touching anything. The plan it returns is what `execute` acts on, so the CLI
 * and the console can both show exactly what a cleanup would do first.
 */
export async function buildPlan(cfg: ClusterConfig): Promise<CleanupPlan> {
	const plan: CleanupPlan = { junk: [], logs: [], totalBytes: 0, notes: [] };
	const insts = managedInstances(cfg);

	for (const [name, inst] of Object.entries(insts)) {
		const dir = instanceDir(inst);

		// cache/ — keep the current version's vanilla jar (avoids a re-download on
		// next boot), everything else is safe to delete
		const cache = join(dir, "cache");

		if (existsSync(cache)) {
			const keepJar = inst.mcVersion
				? new RegExp(`(^|_)${inst.mcVersion.replace(/\./g, "\\.")}\\.jar$`)
				: undefined;

			for (const entry of await readdir(cache)) {
				if (keepJar?.test(entry)) {
					continue;
				}

				const path = join(cache, entry);

				plan.junk.push({
					instance: name,
					kind: "cache",
					path,
					bytes: await pathSize(path),
				});
			}
		}

		// versions/ — keep only the entry for the current MC version
		const versions = join(dir, "versions");

		if (existsSync(versions) && inst.mcVersion) {
			for (const entry of await readdir(versions)) {
				if (entry === inst.mcVersion) {
					continue;
				}

				const path = join(versions, entry);

				plan.junk.push({
					instance: name,
					kind: "old-version",
					path,
					bytes: await pathSize(path),
				});
			}
		}

		// crash-reports older than 30 days
		const crash = join(dir, "crash-reports");

		if (existsSync(crash)) {
			const cutoff = Date.now() - CRASH_REPORT_MAX_AGE_DAYS * 86400_000;

			for (const entry of await readdir(crash)) {
				const path = join(crash, entry);
				const info = await stat(path).catch(() => undefined);

				if (info && info.mtimeMs < cutoff) {
					plan.junk.push({
						instance: name,
						kind: "crash-report",
						path,
						bytes: info.size,
					});
				}
			}
		}

		// leftover windows scripts and hotspot error logs
		for (const leftover of ["start.cmd", "start21"]) {
			const path = join(dir, leftover);

			if (existsSync(path)) {
				plan.junk.push({
					instance: name,
					kind: "leftover",
					path,
					bytes: await pathSize(path),
				});
			}
		}

		const dirEntries = await readdir(dir).catch(() => [] as string[]);

		for (const entry of dirEntries.filter((file) => file.startsWith("hs_err_"))) {
			const path = join(dir, entry);

			plan.junk.push({
				instance: name,
				kind: "leftover",
				path,
				bytes: await pathSize(path),
			});
		}

		// rotated logs → central archive, merged per month
		const logs = join(dir, "logs");

		if (existsSync(logs)) {
			for (const entry of await readdir(logs)) {
				if (!entry.endsWith(".gz")) {
					continue;
				}

				const stamp = entry.match(/^(\d{4})-(\d{2})-\d{2}/);
				const month = stamp ? `${stamp[1]}-${stamp[2]}` : "undated";
				const path = join(logs, entry);

				plan.logs.push({
					instance: name,
					file: path,
					month,
					bytes: await pathSize(path),
				});
			}
		}
	}

	plan.notes.push("libraries/ folders are left untouched (shared jars are needed at runtime).");
	plan.totalBytes = plan.junk.reduce((total, item) => total + item.bytes, 0);

	return plan;
}

export interface CleanupResult {
	deleted: number;
	freedBytes: number;
	archivedLogs: number;
	archives: string[];
}

/** Execute a plan: delete junk, merge rotated logs into logs/<instance>/<YYYY-MM>.log.gz (gzip members concatenate legally). */
export async function execute(plan: CleanupPlan): Promise<CleanupResult> {
	let deleted = 0;
	let freed = 0;

	for (const item of plan.junk) {
		await rm(item.path, { recursive: true, force: true });

		deleted++;
		freed += item.bytes;
	}

	const byDest = new Map<string, LogMove[]>();

	for (const move of plan.logs) {
		const key = `${move.instance}/${move.month}`;

		if (!byDest.has(key)) {
			byDest.set(key, []);
		}

		byDest.get(key)!.push(move);
	}

	const archives = new Set<string>();
	let archived = 0;

	for (const [key, moves] of byDest) {
		const [instance, month] = key.split("/") as [string, string];
		const destDir = join(centralLogsDir(), instance);

		await mkdir(destDir, { recursive: true });

		const dest = join(destDir, `${month}.log.gz`);

		moves.sort((a, b) => basename(a.file).localeCompare(basename(b.file)));

		for (const move of moves) {
			const data = await Bun.file(move.file).arrayBuffer();

			await appendFile(dest, new Uint8Array(data));
			await unlink(move.file);

			archived++;
		}

		archives.add(dest);
	}

	return {
		deleted,
		freedBytes: freed,
		archivedLogs: archived,
		archives: [...archives].sort(),
	};
}
