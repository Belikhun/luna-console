// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Versioned world backups: taking them, listing them, putting one back.
 *
 * An archive holds an instance's world directories and nothing else. Not
 * `plugins/`, not `bluemap/` - on `survival` that last one alone is 59 GB of
 * data derived from the world rather than part of it, and a backup that
 * swallowed it would cost twice what it protects.
 *
 * Backups are per machine. The archive sits in `<root>/.backups/<instance>/` on
 * whichever daemon owns the instance, and the index describing them
 * (`backups.json`) sits beside it rather than being mirrored, for the same
 * reason `schedules.json` and `uptime.json` are not mirrored: an index of files
 * that only exist on one machine is only true on that machine.
 *
 * Taking one does not require stopping the server. It does require telling the
 * server to stop writing first, which is what the freeze does; putting one back
 * does require a stopped server, and the op layer enforces that.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { backupsDir, instanceDir, managedInstances, statePath } from "./config";
import { appendJournal } from "./journal";
import { ProgressReporter } from "./progress";
import { createArchive, extractArchive, listArchive } from "./services/archive";
import { getStatus, sendCommand } from "./instances";
import { layoutOf, levelNameOf, readLevelDat, worldDirNames, worldSources } from "./world";
import { installWorldFrom } from "./worldops";
import type { WorldMutationResult } from "./worldops";
import type { ClusterConfig, InstanceConfig } from "./types";
import { t } from "../shared/i18n";

const BACKUP_FILE = "backups.json";

/** Backups kept per instance when nothing says otherwise. */
export const DEFAULT_KEEP_COUNT = 3;

/**
 * How long to wait for the server to confirm it has flushed.
 *
 * Generous, because on a 29 GB world `save-all flush` genuinely takes a while.
 * Running out is not fatal - the backup proceeds and says so - because a
 * slightly stale backup is worth more than no backup.
 */
const FLUSH_TIMEOUT_MS = 120_000;

/** How often the flush wait re-reads the log. */
const FLUSH_POLL_MS = 500;

/** The line every vanilla-derived server prints once its worlds are on disk. */
const SAVED_MARKER = /Saved the game|All dimensions are saved|Saved the world/i;

/** What triggered a backup; a restore's safety copy is not a manual one. */
export type BackupTrigger = "manual" | "schedule" | "pre-replace" | "pre-restore" | "pre-reset";

/** A world archive luna took and can put back. */
export interface BackupEntry {
	id: string;
	instance: string;
	/** Editable name; defaults to the timestamp it was taken at */
	label: string;
	/** Archive file name inside `<root>/.backups/<instance>/` */
	file: string;
	createdAt: number;
	sizeBytes: number;
	fileCount: number;
	/** Level name the world had, which a restore writes back under */
	level: string;
	/** Directories the archive carries, so a restore knows what to retire */
	dirs: string[];
	mcVersion?: string;
	dataVersion?: number;
	trigger: BackupTrigger;
	/** Never pruned by retention while set */
	pinned?: boolean;
	note?: string;
	/** Things that were true when it was taken; a torn hot backup says so here */
	warnings?: string[];
	/** sha256 of the archive, filled in by a verify rather than at write time */
	checksum?: string;
	verifiedAt?: number;
}

/** The backup index for this machine. */
export interface BackupStore {
	backups: BackupEntry[];
	/** Per-instance retention override; absent means {@link DEFAULT_KEEP_COUNT} */
	keep?: Record<string, number>;
}

function backupStorePath(): string {
	return statePath(BACKUP_FILE);
}

/** Read the backup index. */
export async function loadBackups(): Promise<BackupStore> {
	if (!existsSync(backupStorePath())) {
		return { backups: [] };
	}

	const store: BackupStore = await Bun.file(backupStorePath()).json();

	store.backups ??= [];

	return store;
}

/**
 * Persist the backup index.
 *
 * No `notifySave`: this file is not mirrored. It describes archives that exist
 * on this machine's disk, so a follower's copy and the primary's are different
 * true statements rather than one that needs syncing.
 */
export async function saveBackups(store: BackupStore): Promise<void> {
	store.backups.sort((a, b) => b.createdAt - a.createdAt);

	await Bun.write(backupStorePath(), `${JSON.stringify(store, null, "\t")}\n`);
}

/** Directory holding one instance's archives. */
export function instanceBackupsDir(instance: string): string {
	return join(backupsDir(), instance);
}

/** Absolute path of a backup's archive. */
export function backupPath(entry: BackupEntry): string {
	return join(instanceBackupsDir(entry.instance), entry.file);
}

/** Backups for one instance, or every instance, newest first. */
export async function listBackups(instance?: string): Promise<BackupEntry[]> {
	const store = await loadBackups();
	const rows = instance ? store.backups.filter((entry) => entry.instance === instance) : store.backups;

	return [...rows].sort((a, b) => b.createdAt - a.createdAt);
}

/** One backup by id. */
export async function getBackup(id: string): Promise<BackupEntry | undefined> {
	return (await loadBackups()).backups.find((entry) => entry.id === id);
}

/** How many backups this instance keeps. */
export function keepCountFor(store: BackupStore, instance: string): number {
	return store.keep?.[instance] ?? DEFAULT_KEEP_COUNT;
}

/** Set an instance's retention; below one is refused, since zero deletes all. */
export async function setKeepCount(instance: string, keep: number): Promise<number> {
	if (!Number.isInteger(keep) || keep < 1) {
		throw new Error(t("core.backups.badKeepCount"));
	}

	const store = await loadBackups();

	store.keep ??= {};
	store.keep[instance] = keep;

	await saveBackups(store);

	return keep;
}

/** A timestamp in the shape a file name and a default label both want. */
function stamp(at: number): string {
	return new Date(at).toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

/**
 * Ask the server to stop writing its world, and wait until it has finished.
 *
 * Minecraft rewrites region files in place, so an archive taken while the
 * server is saving can capture a chunk half-written - a corruption that only
 * surfaces on restore, potentially months later. `save-off` stops new writes
 * and `save-all flush` pushes what is buffered to disk.
 *
 * Returns what the caller should record as a warning: an empty list when the
 * freeze was confirmed, and a reason when it was not. Failing to confirm is
 * deliberately not fatal.
 */
async function freeze(cfg: ClusterConfig, name: string, inst: InstanceConfig): Promise<string[]> {
	const logPath = join(instanceDir(inst), "logs", "latest.log");
	const before = await stat(logPath)
		.then((info) => info.size)
		.catch(() => 0);

	if (!(await sendCommand(cfg, name, "save-off"))) {
		return ["freeze-no-session"];
	}

	await sendCommand(cfg, name, "save-all flush");

	const deadline = Date.now() + FLUSH_TIMEOUT_MS;

	while (Date.now() < deadline) {
		await Bun.sleep(FLUSH_POLL_MS);

		const info = await stat(logPath).catch(() => undefined);

		if (!info || info.size <= before) {
			continue;
		}

		const tail = await Bun.file(logPath)
			.slice(before, info.size)
			.text()
			.catch(() => "");

		if (SAVED_MARKER.test(tail)) {
			return [];
		}
	}

	// out of time, not out of options: the archive is still worth taking, and
	// the entry carries the fact that the flush was never confirmed
	return ["flush-not-confirmed"];
}

/** Let the server write again. Called on every path, including failure. */
async function thaw(cfg: ClusterConfig, name: string): Promise<void> {
	await sendCommand(cfg, name, "save-on").catch(() => false);
}

export interface CreateBackupOptions {
	label?: string;
	note?: string;
	trigger?: BackupTrigger;
	actor?: string;
	/** Skip the console freeze; only correct when the instance is already stopped */
	skipFreeze?: boolean;
	reporter?: ProgressReporter;
}

/**
 * Archive an instance's world.
 *
 * Safe to run against a live server: saving is frozen for the duration and
 * thawed afterwards whatever happens, including when the archive fails.
 *
 * @throws when the instance has no world, or when nothing has generated one yet
 */
export async function createBackup(
	cfg: ClusterConfig,
	name: string,
	opts: CreateBackupOptions = {},
): Promise<BackupEntry> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const progress = opts.reporter ?? new ProgressReporter(`backup ${name}`);

	progress.weighOwn(0);

	const preparing = progress.child(t("core.backups.phasePrepare"), 1);
	const archiving = progress.child(t("core.backups.phaseArchive"), 8);
	const finishing = progress.child(t("core.backups.phaseFinish"), 1);

	const dir = instanceDir(inst);
	const level = await levelNameOf(inst);
	const layout = layoutOf(inst);
	const at = Date.now();

	const sources = await preparing.task(
		{ start: t("core.backups.scanning"), done: t("core.backups.scanned") },
		async () => await worldSources(dir, layout, level),
	);

	if (sources.length === 0) {
		throw new Error(t("core.backups.noWorldYet", { name }));
	}

	const warnings: string[] = [];

	// a stopped world is already consistent, so there is nothing to freeze and
	// nothing to warn about; asking a server that is not there to save-off would
	// only stamp the archive with a flush nobody needed
	const running = !opts.skipFreeze && (await getStatus(cfg, name)).state !== "stopped";

	if (running) {
		warnings.push(...(await freeze(cfg, name, inst)));
	}

	const target = instanceBackupsDir(name);

	await mkdir(target, { recursive: true });

	const file = `${stamp(at)}.zip`;
	const partial = join(target, `${file}.part`);
	const final = join(target, file);

	// written to a .part and renamed, so an interrupted backup can never be
	// mistaken for a complete one by the index or by a human reading the folder
	await rm(partial, { force: true });

	let created;

	try {
		created = await archiving.task(
			{ start: t("core.backups.archiving"), done: t("core.backups.archived") },
			async (reporter) =>
				await createArchive({ dest: partial, baseDir: dir, sources, reporter }),
		);
	} catch (err) {
		await rm(partial, { force: true });

		throw err;
	} finally {
		if (running) {
			await thaw(cfg, name);
		}
	}

	await rename(partial, final);

	const levelDat = await readLevelDat(join(dir, level, "level.dat")).catch(() => undefined);

	const entry: BackupEntry = {
		id: `${name}-${stamp(at)}`,
		instance: name,
		label: opts.label?.trim() || stamp(at),
		file,
		createdAt: at,
		sizeBytes: created.sizeBytes,
		fileCount: created.fileCount,
		level,
		dirs: worldDirNames(layout, level),
		mcVersion: levelDat?.mcVersion,
		dataVersion: levelDat?.dataVersion,
		trigger: opts.trigger ?? "manual",
		note: opts.note?.trim() || undefined,
		warnings: warnings.length > 0 ? warnings : undefined,
	};

	await finishing.task(
		{ start: t("core.backups.recording"), done: t("core.backups.recorded") },
		async () => {
			const store = await loadBackups();

			store.backups.push(entry);

			await saveBackups(store);
			await pruneBackups(name);
		},
	);

	await appendJournal({
		source: "job",
		message: t("core.backups.auditCreated", { name, label: entry.label }),
		detail: t("core.backups.auditCreatedDetail", {
			size: String(entry.sizeBytes),
			files: String(entry.fileCount),
		}),
		actor: opts.actor,
	});

	return entry;
}

/**
 * Drop the oldest backups past an instance's keep count.
 *
 * Only ever called after a *successful* create, so a failed backup can never
 * cost the operator a good one. Pinned entries are skipped entirely and do not
 * count toward the limit either: pinning means "this one survives retention",
 * and having it push out three unpinned ones would be the opposite.
 */
export async function pruneBackups(instance: string): Promise<BackupEntry[]> {
	const store = await loadBackups();
	const keep = keepCountFor(store, instance);

	const rows = store.backups
		.filter((entry) => entry.instance === instance && !entry.pinned)
		.sort((a, b) => b.createdAt - a.createdAt);

	const doomed = rows.slice(keep);

	if (doomed.length === 0) {
		return [];
	}

	for (const entry of doomed) {
		await rm(backupPath(entry), { force: true });
	}

	const gone = new Set(doomed.map((entry) => entry.id));

	store.backups = store.backups.filter((entry) => !gone.has(entry.id));

	await saveBackups(store);

	return doomed;
}

/** Rename a backup, or change its note. */
export async function updateBackup(
	id: string,
	patch: { label?: string; note?: string; pinned?: boolean },
): Promise<BackupEntry> {
	const store = await loadBackups();
	const entry = store.backups.find((row) => row.id === id);

	if (!entry) {
		throw new Error(t("core.backups.unknown", { id }));
	}

	if (patch.label !== undefined) {
		const label = patch.label.trim();

		if (!label) {
			throw new Error(t("core.backups.emptyLabel"));
		}

		entry.label = label;
	}

	if (patch.note !== undefined) {
		entry.note = patch.note.trim() || undefined;
	}

	if (patch.pinned !== undefined) {
		entry.pinned = patch.pinned || undefined;
	}

	await saveBackups(store);

	return entry;
}

/** Delete a backup and its archive. Idempotent. */
export async function deleteBackup(id: string, actor?: string): Promise<BackupEntry | undefined> {
	const store = await loadBackups();
	const entry = store.backups.find((row) => row.id === id);

	if (!entry) {
		return undefined;
	}

	await rm(backupPath(entry), { force: true });

	store.backups = store.backups.filter((row) => row.id !== id);

	await saveBackups(store);

	await appendJournal({
		source: "job",
		message: t("core.backups.auditDeleted", { name: entry.instance, label: entry.label }),
		actor,
	});

	return entry;
}

/**
 * Re-read an archive and record that it is intact.
 *
 * A checksum over 29 GB is not something a request waits for, so this is a job
 * like the rest. What it proves is that the central directory still lists every
 * member and the file has not been truncated underneath us.
 */
export async function verifyBackup(id: string, reporter?: ProgressReporter): Promise<BackupEntry> {
	const store = await loadBackups();
	const entry = store.backups.find((row) => row.id === id);

	if (!entry) {
		throw new Error(t("core.backups.unknown", { id }));
	}

	const progress = reporter ?? new ProgressReporter(`verify ${entry.label}`);
	const path = backupPath(entry);

	if (!existsSync(path)) {
		throw new Error(t("core.backups.archiveMissing", { file: entry.file }));
	}

	await progress.task(
		{ start: t("core.backups.verifying", { label: entry.label }), done: t("core.backups.verified") },
		async () => {
			const listing = await listArchive(path);

			if (listing.fileCount !== entry.fileCount) {
				throw new Error(
					t("core.backups.verifyCountMismatch", {
						expected: String(entry.fileCount),
						found: String(listing.fileCount),
					}),
				);
			}

			const hasher = new Bun.CryptoHasher("sha256");
			const stream = Bun.file(path).stream();

			for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
				hasher.update(chunk);
			}

			entry.checksum = hasher.digest("hex");
			entry.verifiedAt = Date.now();
		},
	);

	await saveBackups(store);

	return entry;
}

export interface RestoreOptions {
	/** Archive the current world first; on by default at every call site */
	backupFirst?: boolean;
	actor?: string;
	reporter?: ProgressReporter;
}

/**
 * Put a backup back, replacing whatever the instance has now.
 *
 * Runs through the same swap protocol a replace does, so it is fail-safe in
 * exactly the same way and there is only one implementation of the dangerous
 * part. The archive is already in the target's own layout - luna wrote it - so
 * no layout conversion happens here.
 *
 * @throws when the backup or its archive is gone, or when the instance is not
 *   the one the archive came from
 */
export async function restoreBackup(
	cfg: ClusterConfig,
	id: string,
	opts: RestoreOptions = {},
): Promise<WorldMutationResult> {
	const entry = await getBackup(id);

	if (!entry) {
		throw new Error(t("core.backups.unknown", { id }));
	}

	const path = backupPath(entry);

	if (!existsSync(path)) {
		throw new Error(t("core.backups.archiveMissing", { file: entry.file }));
	}

	const name = entry.instance;
	const progress = opts.reporter ?? new ProgressReporter(`restore ${name}`);

	progress.weighOwn(0);

	// created unconditionally and settled when unused: the progress mirror pairs
	// a daemon's tree with the client's by position, so a phase that sometimes
	// does not exist would misalign every phase after it
	const safety = progress.child(t("core.backups.phaseSafetyCopy"), 4);
	const restoring = progress.child(t("core.backups.phaseRestore"), 8);

	if (opts.backupFirst) {
		await createBackup(cfg, name, {
			label: t("core.backups.beforeRestoreLabel", { label: entry.label }),
			trigger: "pre-restore",
			actor: opts.actor,
			reporter: safety,
		}).catch((err) => {
			// a safety copy that cannot be taken must stop the restore: proceeding
			// would destroy the current world with nothing to go back to
			throw new Error(t("core.backups.safetyCopyFailed", { detail: String(err) }));
		});
	} else {
		safety.settle();
	}

	const listing = await listArchive(path);

	const result = await installWorldFrom(
		cfg,
		name,
		async (stage, reporter) => {
			await extractArchive({
				archive: path,
				dest: stage,
				expectedFiles: listing.fileCount,
				reporter,
			});
		},
		"restore",
		{
			actor: opts.actor,
			source: entry.label,
			reporter: restoring,
		},
	);

	await appendJournal({
		source: "job",
		message: t("core.backups.auditRestored", { name, label: entry.label }),
		actor: opts.actor,
	});

	return result;
}

/** Archives on disk with no index entry, and entries with no archive. */
export interface BackupDrift {
	orphanFiles: string[];
	missingArchives: string[];
}

/**
 * Reconcile the index against the directory.
 *
 * Both directions happen in practice: an operator deletes an archive by hand,
 * or a crash leaves one the index never learned about. Reporting it beats
 * silently trusting either side.
 */
export async function backupDrift(instance: string): Promise<BackupDrift> {
	const dir = instanceBackupsDir(instance);
	const entries = await listBackups(instance);
	const known = new Set(entries.map((entry) => entry.file));

	const present = existsSync(dir)
		? (await readdir(dir)).filter((file) => file.toLowerCase().endsWith(".zip"))
		: [];

	return {
		orphanFiles: present.filter((file) => !known.has(file)).sort(),
		missingArchives: entries.filter((entry) => !present.includes(entry.file)).map((entry) => entry.file),
	};
}
