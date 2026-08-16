// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Replacing an instance's world without ever leaving it half-written.
 *
 * The constraint that shapes all of this is size. `survival`'s world is 29 GB
 * on a volume with 117 GB free, so the obvious safety net - copy the old world
 * aside, write the new one, delete the copy on success - does not fit, and
 * would take minutes per attempt even when it did.
 *
 * What does fit is `rename`, which inside one filesystem is atomic and costs
 * nothing whatever the directory weighs. So a replace stages the incoming world
 * beside the live one, then swaps them with two renames and deletes the loser.
 * The world is only ever "not whole" for the microseconds between those two
 * renames.
 *
 * Surviving a crash in that window is what the journal is for. It is written
 * before each phase and removed only on success, so a daemon that dies
 * mid-swap leaves behind an exact statement of where it was, and the recovery
 * pass either finishes the job or puts the old world back. The same file is the
 * lock: while it exists the instance must not start, because what the server
 * would open is a world in the middle of being replaced.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { diskUsage } from "./cleanup";
import { instanceDir, managedInstances } from "./config";
import { appendJournal } from "./journal";
import { ProgressReporter } from "./progress";
import { extractArchive, listArchive } from "./services/archive";
import type { ClusterConfig, InstanceConfig } from "./types";
import {
	dimensionPath,
	hasWorld,
	layoutOf,
	levelNameOf,
	planWorldImport,
	scanWorldArchive,
	worldDirNames,
} from "./world";
import type { WorldImportPlan, WorldScan } from "./world";
import { t } from "../shared/i18n";

/** Where an incoming world is assembled before the swap. */
export const STAGE_DIR = ".luna-world-stage";

/** Where the outgoing world waits until the swap has committed. */
export const OLD_DIR = ".luna-world-old";

/** The journal, which is also the lock. */
export const JOURNAL_FILE = ".luna-world.json";

/**
 * Headroom demanded on top of the incoming world's own size.
 *
 * A cluster root that fills up does not merely fail the import: `cluster.json`
 * and the lockfile are written to the same volume, so it takes the registry
 * with it. The margin is what keeps a mistimed backup from doing that.
 */
const FREE_SPACE_MARGIN_BYTES = 2 * 1024 * 1024 * 1024;

/** What a world operation is doing to the instance. */
export type WorldOpKind = "replace" | "restore" | "reset";

/**
 * How far a world operation had got.
 *
 * The order matters: it is what the recovery pass compares against to decide
 * between undoing the work and finishing it.
 */
export type WorldOpPhase = "stage" | "retire" | "install" | "discard";

/** The on-disk journal: what is happening, and how to undo or finish it. */
export interface WorldJournal {
	kind: WorldOpKind;
	phase: WorldOpPhase;
	instance: string;
	/** Level name being written, so recovery knows which directories are in play */
	level: string;
	/** Directories under the instance the operation owns */
	dirs: string[];
	startedAt: number;
	/** Who asked for it, for the journal entry recovery writes */
	actor?: string;
	/** Human note for the console: the archive's name, the backup's label */
	source?: string;
}

/** Absolute path of an instance's journal. */
function journalPath(dir: string): string {
	return join(dir, JOURNAL_FILE);
}

/** Read an instance's world journal; undefined when no operation is in flight. */
export async function readJournal(dir: string): Promise<WorldJournal | undefined> {
	const path = journalPath(dir);

	if (!existsSync(path)) {
		return undefined;
	}

	try {
		return (await Bun.file(path).json()) as WorldJournal;
	} catch {
		// an unparseable journal still means an operation was interrupted; report
		// the most conservative thing it could have been rather than nothing,
		// because "no journal" would let the instance start
		return undefined;
	}
}

/** Write the journal, which is what arms the lock. */
async function writeJournal(dir: string, journal: WorldJournal): Promise<void> {
	await Bun.write(journalPath(dir), `${JSON.stringify(journal, null, "\t")}\n`);
}

/** Advance the journal to the next phase. */
async function advance(dir: string, journal: WorldJournal, phase: WorldOpPhase): Promise<WorldJournal> {
	const next = { ...journal, phase };

	await writeJournal(dir, next);

	return next;
}

/** Remove the journal, which is what releases the lock. */
async function clearJournal(dir: string): Promise<void> {
	await rm(journalPath(dir), { force: true });
}

/**
 * The world operation holding an instance, if one is.
 *
 * This is the lock every start is checked against. It is a file rather than
 * daemon memory precisely so that it survives the daemon: a process killed
 * halfway through a swap leaves an instance whose world is not whole, and the
 * one thing that must not happen next is a server opening it.
 */
export async function worldLock(cfg: ClusterConfig, name: string): Promise<WorldJournal | undefined> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		return undefined;
	}

	return await readJournal(instanceDir(inst));
}

/** What a recovery pass did to one instance. */
export interface WorldRecovery {
	instance: string;
	kind: WorldOpKind;
	phase: WorldOpPhase;
	/** `rolled-back` put the old world back; `rolled-forward` kept the new one */
	outcome: "rolled-back" | "rolled-forward" | "cleaned";
	detail: string;
}

/**
 * Finish or undo an interrupted world operation.
 *
 * The decision is per phase, and the cut is at `install`:
 *
 * | phase     | on disk                          | verdict     |
 * |-----------|----------------------------------|-------------|
 * | `stage`   | staging tree partial             | clean up    |
 * | `retire`  | old moved aside, new not yet in  | roll back   |
 * | `install` | new in place, old still present  | roll forward|
 * | `discard` | old part-deleted                 | roll forward|
 *
 * Rolling forward at `install` rather than back is deliberate. By then the new
 * world is already sitting under its real name, which is what the server would
 * open anyway; undoing it would throw away the thing the operator asked for in
 * order to restore something they asked to be rid of.
 */
export async function recoverWorldOp(cfg: ClusterConfig, name: string): Promise<WorldRecovery | undefined> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		return undefined;
	}

	const dir = instanceDir(inst);
	const journal = await readJournal(dir);

	if (!journal) {
		return undefined;
	}

	const stage = join(dir, STAGE_DIR);
	const old = join(dir, OLD_DIR);

	if (journal.phase === "stage") {
		// nothing was moved yet, so the live world is untouched and the partial
		// staging tree is the only thing to get rid of
		await rm(stage, { recursive: true, force: true });
		await clearJournal(dir);

		return {
			instance: name,
			kind: journal.kind,
			phase: journal.phase,
			outcome: "cleaned",
			detail: t("core.worldops.recoveredStage", { name }),
		};
	}

	if (journal.phase === "retire") {
		await restoreRetired(dir, old, journal.dirs);
		await rm(stage, { recursive: true, force: true });
		await clearJournal(dir);

		return {
			instance: name,
			kind: journal.kind,
			phase: journal.phase,
			outcome: "rolled-back",
			detail: t("core.worldops.recoveredRetire", { name }),
		};
	}

	// install or discard: the new world is live, so finish the tidy-up
	await rm(stage, { recursive: true, force: true });
	await rm(old, { recursive: true, force: true });
	await clearJournal(dir);

	return {
		instance: name,
		kind: journal.kind,
		phase: journal.phase,
		outcome: "rolled-forward",
		detail: t("core.worldops.recoveredInstall", { name }),
	};
}

/** Every instance holding a journal, recovered. Run once at daemon start. */
export async function recoverAllWorldOps(cfg: ClusterConfig): Promise<WorldRecovery[]> {
	const out: WorldRecovery[] = [];

	for (const name of Object.keys(managedInstances(cfg))) {
		const recovery = await recoverWorldOp(cfg, name).catch(() => undefined);

		if (recovery) {
			out.push(recovery);
		}
	}

	return out;
}

/** Put back whatever `retire` moved aside, leaving nothing behind. */
async function restoreRetired(dir: string, old: string, dirs: string[]): Promise<void> {
	if (!existsSync(old)) {
		return;
	}

	for (const rel of dirs) {
		const stashed = join(old, rel);

		if (!existsSync(stashed)) {
			continue;
		}

		const live = join(dir, rel);

		// a half-installed directory under the real name is the new world's, not
		// the old one's; it goes rather than blocking the rename
		await rm(live, { recursive: true, force: true });
		await rename(stashed, live);
	}

	await rm(old, { recursive: true, force: true });
}

/** Refuse before starting when the volume cannot hold what is coming. */
async function checkFreeSpace(dir: string, incomingBytes: number): Promise<void> {
	const usage = await diskUsage(dir);

	if (!usage) {
		// df said nothing; that is a missing measurement, not a green light, but
		// refusing every import because df is unavailable is worse than trying
		return;
	}

	const needed = incomingBytes + FREE_SPACE_MARGIN_BYTES;

	if (usage.freeBytes >= needed) {
		return;
	}

	throw new Error(
		t("core.worldops.notEnoughSpace", {
			needed: formatBytes(needed),
			free: formatBytes(usage.freeBytes),
			short: formatBytes(needed - usage.freeBytes),
		}),
	);
}

/** Bytes as an operator reads them; refusals name real numbers. */
export function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = Math.max(0, bytes);
	let unit = 0;

	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}

	return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Confirm two paths are on one filesystem, so the swap really is a rename.
 *
 * Node's `rename` falls back to nothing across devices - it throws EXDEV - so
 * this is not about correctness but about failing early and legibly. It matters
 * because a follower may mount its instances somewhere other than its root.
 */
async function sameFilesystem(a: string, b: string): Promise<boolean> {
	const [statA, statB] = await Promise.all([
		stat(a).catch(() => undefined),
		stat(b).catch(() => undefined),
	]);

	if (!statA || !statB) {
		return true;
	}

	return statA.dev === statB.dev;
}

/** Options shared by everything that swaps a world in. */
export interface WorldMutationOptions {
	/** Recorded in the journal and the audit trail */
	actor?: string;
	/** Human description of where the new world came from */
	source?: string;
	reporter?: ProgressReporter;
}

/** What a completed mutation reports back. */
export interface WorldMutationResult {
	instance: string;
	level: string;
	kind: WorldOpKind;
	/** Directories that now hold the world */
	dirs: string[];
	sizeBytes: number;
	fileCount: number;
}

/**
 * Run the four-phase swap.
 *
 * `fill` is what puts the incoming world into the staging directory; everything
 * after it is identical whether the world came out of an upload, out of a
 * backup, or nowhere at all (a reset stages nothing and installs nothing).
 *
 * The caller is responsible for having checked that the instance is stopped.
 * That is deliberately not done here: this function is the mechanism, and the
 * op layer is where the policy about when it may run lives.
 */
async function swapWorld(
	inst: InstanceConfig,
	name: string,
	kind: WorldOpKind,
	dirs: string[],
	level: string,
	fill: (stageDir: string, reporter: ProgressReporter) => Promise<void>,
	opts: WorldMutationOptions,
): Promise<WorldMutationResult> {
	const progress = opts.reporter ?? new ProgressReporter(`${kind} ${name}`);
	const dir = instanceDir(inst);
	const stage = join(dir, STAGE_DIR);
	const old = join(dir, OLD_DIR);

	progress.weighOwn(0);

	const staging = progress.child(t("core.worldops.phaseStage"), 8);
	const swapping = progress.child(t("core.worldops.phaseSwap"), 1);
	const cleaning = progress.child(t("core.worldops.phaseDiscard"), 2);

	const existing = await readJournal(dir);

	if (existing) {
		throw new Error(t("core.worldops.alreadyRunning", { name, kind: existing.kind }));
	}

	let journal: WorldJournal = {
		kind,
		phase: "stage",
		instance: name,
		level,
		dirs,
		startedAt: Date.now(),
		actor: opts.actor,
		source: opts.source,
	};

	// the journal goes down before the first byte moves: from here on, a crash
	// is recoverable and the instance is locked
	await writeJournal(dir, journal);

	try {
		await rm(stage, { recursive: true, force: true });
		await rm(old, { recursive: true, force: true });
		await mkdir(stage, { recursive: true });

		await staging.task(
			{ start: t("core.worldops.staging"), done: t("core.worldops.staged") },
			async (reporter) => await fill(stage, reporter),
		);

		if (!(await sameFilesystem(stage, dir))) {
			throw new Error(t("core.worldops.crossDevice", { name }));
		}

		await swapping.task(
			{ start: t("core.worldops.swapping"), done: t("core.worldops.swapped") },
			async () => {
				journal = await advance(dir, journal, "retire");

				await mkdir(old, { recursive: true });

				for (const rel of dirs) {
					const live = join(dir, rel);

					if (existsSync(live)) {
						await rename(live, join(old, rel));
					}
				}

				journal = await advance(dir, journal, "install");

				for (const rel of dirs) {
					const staged = join(stage, rel);

					if (existsSync(staged)) {
						await rename(staged, join(dir, rel));
					}
				}
			},
		);

		journal = await advance(dir, journal, "discard");

		await cleaning.task(
			{ start: t("core.worldops.discarding"), done: t("core.worldops.discarded") },
			async () => {
				await rm(old, { recursive: true, force: true });
				await rm(stage, { recursive: true, force: true });
			},
		);

		await clearJournal(dir);
	} catch (err) {
		// the failing node's message is what says where it broke, so it is
		// reported before the error is allowed to propagate
		progress.say("error", err instanceof Error ? err.message : String(err));

		// recovery reads the journal we left and does exactly what a daemon
		// restart would have done, so a failure and a crash heal the same way
		await recoverFromFailure(dir, journal);

		throw err;
	}

	let sizeBytes = 0;
	let fileCount = 0;

	for (const rel of dirs) {
		const measured = await measure(join(dir, rel));

		sizeBytes += measured.sizeBytes;
		fileCount += measured.fileCount;
	}

	return { instance: name, level, kind, dirs, sizeBytes, fileCount };
}

/** Undo or finish after a failure, using the journal we were keeping. */
async function recoverFromFailure(dir: string, journal: WorldJournal): Promise<void> {
	const stage = join(dir, STAGE_DIR);
	const old = join(dir, OLD_DIR);

	try {
		if (journal.phase === "stage") {
			await rm(stage, { recursive: true, force: true });
		} else if (journal.phase === "retire") {
			await restoreRetired(dir, old, journal.dirs);
			await rm(stage, { recursive: true, force: true });
		} else {
			await rm(stage, { recursive: true, force: true });
			await rm(old, { recursive: true, force: true });
		}

		await clearJournal(dir);
	} catch {
		// the journal deliberately stays when recovery itself fails: an instance
		// that cannot be tidied up automatically must stay locked and visible
		// rather than quietly becoming startable again
	}
}

/** Size and file count of a tree, without walking it twice. */
async function measure(dir: string): Promise<{ sizeBytes: number; fileCount: number }> {
	const out = { sizeBytes: 0, fileCount: 0 };

	if (!existsSync(dir)) {
		return out;
	}

	const stack = [dir];

	while (stack.length > 0) {
		const current = stack.pop()!;
		const items = await readdir(current, { withFileTypes: true }).catch(() => []);

		for (const item of items) {
			if (item.isSymbolicLink()) {
				continue;
			}

			if (item.isDirectory()) {
				stack.push(join(current, item.name));

				continue;
			}

			const info = await stat(join(current, item.name)).catch(() => undefined);

			if (info) {
				out.sizeBytes += info.size;
				out.fileCount++;
			}
		}
	}

	return out;
}

/**
 * Lay an extracted archive out in the staging directory the way the target
 * instance reads it.
 *
 * Extraction puts the archive's own shape on disk; this is the part that turns
 * it into the target's. Every step is a rename inside the staging tree, so
 * converting a 29 GB world between layouts costs nothing.
 */
async function applyPlan(dest: string, extracted: string, plan: WorldImportPlan): Promise<void> {
	const parked = join(dest, "__dims");

	// The dimensions are lifted out to a flat holding area before the overworld
	// moves, and put back afterwards. Doing it in one pass cannot work in both
	// directions: converting *from* nested, a dimension lives inside the
	// overworld's source, so moving the overworld first takes it along and the
	// conversion silently does nothing; converting *to* nested, the dimension's
	// destination is inside the overworld's, so it has to move second. Parking
	// them satisfies both, and every step is still only a rename.
	await mkdir(parked, { recursive: true });

	const dimensions = plan.moves.filter((move) => move.kind !== "overworld");

	for (const move of dimensions) {
		const from = join(extracted, move.from);

		if (!existsSync(from)) {
			continue;
		}

		await rename(from, join(parked, move.kind));
	}

	const overworld = plan.moves.find((move) => move.kind === "overworld");

	if (overworld) {
		const from = overworld.from === "" ? extracted : join(extracted, overworld.from);

		if (existsSync(from)) {
			await mkdir(dirname(join(dest, overworld.to)), { recursive: true });
			await rename(from, join(dest, overworld.to));
		}
	}

	for (const move of dimensions) {
		const from = join(parked, move.kind);

		if (!existsSync(from)) {
			continue;
		}

		const to = join(dest, move.to);

		await mkdir(dirname(to), { recursive: true });
		await rm(to, { recursive: true, force: true });
		await rename(from, to);

		if (!move.copyLevelDat) {
			continue;
		}

		// a Bukkit sibling is a world in its own right and will not load without
		// its own level.dat; the overworld's is the only correct source for it
		const source = join(dest, plan.targetLevel, "level.dat");
		const target = join(dirname(to), "level.dat");

		if (existsSync(source) && !existsSync(target)) {
			await Bun.write(target, Bun.file(source));
		}
	}

	await rm(extracted, { recursive: true, force: true });
	await rm(parked, { recursive: true, force: true });
}

/** Replacing an instance's world with the one inside an archive. */
export interface ReplaceWorldOptions extends WorldMutationOptions {
	/** Level name to install under; defaults to the instance's configured one */
	level?: string;
}

/**
 * Install the world from an archive over whatever the instance has now.
 *
 * @param archivePath a zip already staged on this machine
 * @throws when the archive holds no world, when a member's name would escape
 *   the instance directory, when the world is newer than the server, or when
 *   the volume cannot hold both worlds at once
 */
export async function replaceWorld(
	cfg: ClusterConfig,
	name: string,
	archivePath: string,
	opts: ReplaceWorldOptions = {},
): Promise<WorldMutationResult> {
	const inst = requireWorldInstance(cfg, name);
	const dir = instanceDir(inst);
	const level = opts.level?.trim() || (await levelNameOf(inst));
	const layout = layoutOf(inst);

	const scan = await scanWorldArchive(archivePath);
	const plan = planWorldImport(scan, { level, layout, mcVersion: inst.mcVersion });

	const blocking = plan.findings.filter((finding) => finding.level === "error");

	if (blocking.length > 0) {
		throw new Error(t("core.worldops.planBlocked", { code: blocking[0]!.code }));
	}

	// both worlds coexist between the two renames, so that is the peak
	await checkFreeSpace(dir, scan.totalBytes);

	const listing = await listArchive(archivePath);

	const result = await swapWorld(
		inst,
		name,
		"replace",
		worldDirNames(layout, level),
		level,
		async (stage, reporter) => {
			await materializeWorld(stage, archivePath, plan, listing.fileCount, reporter);
		},
		opts,
	);

	await appendJournal({
		source: "job",
		message: t("core.worldops.auditReplaced", { name, level }),
		detail: t("core.worldops.auditReplacedDetail", {
			source: opts.source ?? t("core.worldops.auditUnnamedSource"),
			size: String(result.sizeBytes),
			files: String(result.fileCount),
		}),
		actor: opts.actor,
	});

	return result;
}

/**
 * Extract an archive into a directory and lay it out the way the plan says.
 *
 * The one implementation of "put this world here", shared by a replace (whose
 * destination is the staging directory, so the swap can move it into place) and
 * by provisioning (whose destination is the brand new instance directory, where
 * there is no existing world to protect and therefore no swap to do).
 */
export async function materializeWorld(
	dest: string,
	archivePath: string,
	plan: WorldImportPlan,
	expectedFiles: number,
	reporter?: ProgressReporter,
): Promise<void> {
	const extracted = join(dest, "__archive");

	await extractArchive({ archive: archivePath, dest: extracted, expectedFiles, reporter });
	await applyPlan(dest, extracted, plan);
}

/** Wipe an instance's world so the server generates a fresh one on next start. */
export async function resetWorld(
	cfg: ClusterConfig,
	name: string,
	opts: WorldMutationOptions = {},
): Promise<WorldMutationResult> {
	const inst = requireWorldInstance(cfg, name);
	const level = await levelNameOf(inst);
	const layout = layoutOf(inst);

	// the same protocol with nothing staged: the directories are retired and
	// never replaced, so a crash mid-reset still puts the old world back
	const result = await swapWorld(
		inst,
		name,
		"reset",
		worldDirNames(layout, level),
		level,
		async () => {},
		opts,
	);

	await appendJournal({
		source: "job",
		message: t("core.worldops.auditReset", { name, level }),
		detail: t("core.worldops.auditResetDetail", { dirs: result.dirs.join(", ") }),
		actor: opts.actor,
	});

	return result;
}

/**
 * Install an already-extracted directory tree as the instance's world.
 *
 * Used by a restore, whose source is a luna archive and therefore already in
 * the target's own layout; it needs the swap and the journal but none of the
 * layout conversion a foreign zip needs.
 */
export async function installWorldFrom(
	cfg: ClusterConfig,
	name: string,
	fill: (stageDir: string, reporter: ProgressReporter) => Promise<void>,
	kind: WorldOpKind,
	opts: WorldMutationOptions = {},
): Promise<WorldMutationResult> {
	const inst = requireWorldInstance(cfg, name);
	const level = await levelNameOf(inst);
	const layout = layoutOf(inst);

	return await swapWorld(inst, name, kind, worldDirNames(layout, level), level, fill, opts);
}

/** The instance, if it exists and has a world at all. */
function requireWorldInstance(cfg: ClusterConfig, name: string): InstanceConfig {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	if (!hasWorld(inst)) {
		throw new Error(t("core.world.noWorld", { name }));
	}

	return inst;
}

/** Free space on the volume an instance's world lives on, for a pre-flight view. */
export async function worldFreeSpace(cfg: ClusterConfig, name: string): Promise<number | undefined> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		return undefined;
	}

	return (await diskUsage(instanceDir(inst)))?.freeBytes;
}

/** Where a dimension of this instance's world sits; re-exported for the ops layer. */
export function instanceDimensionPath(inst: InstanceConfig, level: string, kind: "overworld" | "nether" | "end"): string {
	return dimensionPath(layoutOf(inst), level, kind);
}

/** Whether a scan's world is worth warning about before it is installed. */
export function scanWarnings(scan: WorldScan): string[] {
	return scan.findings.filter((finding) => finding.level !== "info").map((finding) => finding.code);
}
