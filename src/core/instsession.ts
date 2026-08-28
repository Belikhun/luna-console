// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Per-instance boot sessions: the current run's log, accumulated once and kept.
 *
 * Everything luna knows about a running instance's addons is read out of its
 * log, and until this module that log was re-derived from the files on every
 * poll: latest.log, walked backwards through rotations until the boot marker
 * appeared. The files are not a stable record - log4j rolls latest.log on size
 * and at midnight, and every roll pushes the boot lines one archive further
 * away - so a long-running server's evidence eventually rotated out of reach
 * and a whole modpack's mods fell back to `unknown`, on a server that had been
 * fine for days.
 *
 * A session inverts that: the daemon that owns the instance reads each log line
 * **once**, on a delta from where the previous read stopped, and keeps what it
 * read. Rotation stops mattering, because by the time a line rotates out of the
 * files it is already in the session; a poll costs one stat plus the bytes
 * actually appended since the last one. The session begins at the boot marker,
 * is replaced when a new marker appears in the delta (run.sh's crash loop
 * restarts the server without telling anybody), is cleared when luna stops the
 * instance, and is persisted under `<root>/.cache/sessions/` so a daemon
 * restart resumes the tail instead of starting over.
 *
 * The lines are the session's first tenant, not its definition: the object is
 * the run-scoped home for whatever else is worth keeping about a running
 * instance (counters, metrics, moments), which is why it carries `startedAt`
 * and a revision rather than being a bare string array.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ClusterConfig, InstanceConfig } from "./types";
import { instanceDir, managedInstances, root } from "./config";
import { traitsOf } from "./software";
import { t } from "../shared/i18n";

/** Boot-phase lines kept in full; a modpack boot is a quarter of this. */
const HEAD_MAX = 8_000;

/** Rolling recent lines kept behind the head once it is full. */
const TAIL_MAX = 4_000;

/** One stored line's length cap; a runaway NBT dump must not own the session. */
const LINE_MAX = 8_192;

/**
 * Seeding caps: how far back the one-time reconstruction walks for a session
 * nobody was accumulating (daemon cold start on an already-running server).
 * Far more generous than a per-poll walk could ever afford, because seeding
 * happens once per boot rather than every eight seconds.
 */
const SEED_ROTATIONS = 24;
const SEED_BYTES = 48 * 1024 * 1024;

/** Bytes read to identify a log file, which is all its first line takes. */
const FIRST_LINE_BYTES = 4_096;

/** Persist when this many lines arrived since the last write, or on time. */
const PERSIST_EVERY_LINES = 500;
const PERSIST_EVERY_MS = 60_000;

/** On-disk format version, so a future shape change invalidates cleanly. */
const STORE_VERSION = 1;

/** Where the tail stopped reading, so the next poll starts exactly there. */
interface Cursor {
	/** latest.log's first line, which is what tells one file from its successor */
	firstLine: string;
	/** byte offset already consumed */
	offset: number;
	/** the unterminated final line carried into the next read */
	remainder: string;
}

interface LiveSession {
	instance: string;
	/** the boot marker line; "" when the boot has not been seen (yet) */
	bootLine: string;
	/**
	 * When accumulation began (epoch ms). The boot time when the marker was seen
	 * arriving; merely "since when luna has been keeping this" for a run that was
	 * already underway when the session was seeded.
	 */
	startedAt: number;
	/** the log's own last write time; staleness checks compare against it */
	updatedAt: number;
	head: string[];
	tail: string[];
	/** lines that fell between head and tail when the tail ring compacted */
	dropped: number;
	/** monotonic revision: total lines ever appended to this session */
	appended: number;
	cursor: Cursor;
	persistedAppended: number;
	persistedAt: number;
}

/** What a caller gets: the current boot as data, never the live object. */
export interface SessionSnapshot {
	/** the boot marker line; "" when the boot has not been seen */
	bootLine: string;
	startedAt: number;
	updatedAt: number;
	lines: string[];
	dropped: number;
	appended: number;
	/** changes iff the view above changed; what a caller keys its own caches on */
	revision: string;
}

const sessions = new Map<string, LiveSession>();

/** Instances whose persisted session was already looked for, hit or miss. */
const loadsAttempted = new Set<string>();

/** Concurrent polls coalesce onto one extend instead of double-appending. */
const inflight = new Map<string, Promise<SessionSnapshot>>();

/** Where sessions survive a daemon restart; per machine, never mirrored. */
function sessionsDir(): string {
	return join(root(), ".cache", "sessions");
}

function sessionPath(instance: string): string {
	return join(sessionsDir(), `${encodeURIComponent(instance)}.json`);
}

/**
 * The current boot session of one instance, extended by whatever the log grew
 * since the last call. Creates the session (from the persisted copy, else by
 * reconstructing from the files once) when none is live.
 */
export async function currentSession(cfg: ClusterConfig, instance: string): Promise<SessionSnapshot> {
	const running = inflight.get(instance);

	if (running) {
		return await running;
	}

	const work = advance(cfg, instance).finally(() => {
		inflight.delete(instance);
	});

	inflight.set(instance, work);

	return await work;
}

/**
 * Drop an instance's session, live and persisted. Called when luna stops the
 * instance (a shut-down server has no running session) and when it starts one
 * (the new boot must not inherit the old run's lines while the marker is still
 * seconds away from being written).
 */
export async function clearSession(instance: string): Promise<void> {
	sessions.delete(instance);
	loadsAttempted.delete(instance);

	await rm(sessionPath(instance), { force: true });
}

async function advance(cfg: ClusterConfig, instance: string): Promise<SessionSnapshot> {
	const inst = managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name: instance }));
	}

	let session = sessions.get(instance);

	if (!session && !loadsAttempted.has(instance)) {
		loadsAttempted.add(instance);
		session = await loadPersisted(instance);

		if (session) {
			sessions.set(instance, session);
		}
	}

	if (!session) {
		session = await seed(inst, instance);
		sessions.set(instance, session);
		await persist(session, true);

		return snapshotOf(session);
	}

	await extend(session, inst);
	await persist(session, false);

	return snapshotOf(session);
}

function snapshotOf(session: LiveSession): SessionSnapshot {
	// An unterminated final line is committed only once its newline lands (the
	// cursor would otherwise re-read its completion as a second line), but the
	// view still shows it: "Done (12.3s)!" is evidence the instant it appears,
	// not one poll later.
	const partial = session.cursor.remainder.replace(/\r$/, "");

	return {
		bootLine: session.bootLine,
		startedAt: session.startedAt,
		updatedAt: session.updatedAt,
		lines: partial ? [...session.head, ...session.tail, partial] : [...session.head, ...session.tail],
		dropped: session.dropped,
		appended: session.appended,
		revision: `${session.appended}:${session.cursor.remainder.length}`,
	};
}

/**
 * One-time reconstruction from the files, for a run that was already underway:
 * latest.log walked backwards through rotations until the boot marker appears.
 * The same walk every poll used to do, allowed to go much further because it
 * now happens once, then bounded into the session's head and tail.
 */
async function seed(inst: InstanceConfig, instance: string): Promise<LiveSession> {
	const logsDir = join(instanceDir(inst), "logs");
	const latest = join(logsDir, "latest.log");
	const marker = traitsOf(inst.software, inst.mcVersion).bootMarker;

	let text = "";
	let size = 0;
	let writtenAt = Date.now();

	if (existsSync(latest)) {
		const info = await stat(latest);

		size = info.size;
		writtenAt = info.mtimeMs;
		text = await Bun.file(latest).slice(0, size).text();
	}

	const rotations = await rotatedLogs(logsDir);
	let walked = 0;

	while (!marker.test(text) && rotations.length && walked < SEED_ROTATIONS) {
		const file = rotations.pop()!;

		walked += 1;

		try {
			const compressed = await Bun.file(join(logsDir, file)).bytes();

			text = new TextDecoder().decode(Bun.gunzipSync(compressed)) + text;
		} catch {
			// a truncated archive must not take the whole session down
			break;
		}

		if (text.length > SEED_BYTES) {
			break;
		}
	}

	// an unterminated final line stays in the cursor, so the delta completes it
	// instead of the session holding half of it forever
	let remainder = "";

	if (text.length && !text.endsWith("\n")) {
		const cut = text.lastIndexOf("\n") + 1;

		remainder = text.slice(cut);
		text = text.slice(0, cut);
	}

	const lines = text.length ? text.split(/\r?\n/) : [];

	if (lines.length && lines[lines.length - 1] === "") {
		lines.pop();
	}

	// the LAST marker starts the current boot; older boots may sit above it
	let start = -1;

	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (marker.test(lines[index]!)) {
			start = index;

			break;
		}
	}

	const session: LiveSession = {
		instance,
		bootLine: start === -1 ? "" : lines[start]!,
		startedAt: Date.now(),
		updatedAt: writtenAt,
		head: [],
		tail: [],
		dropped: 0,
		appended: 0,
		cursor: {
			firstLine: firstLineOf(text),
			offset: size,
			remainder,
		},
		persistedAppended: 0,
		persistedAt: 0,
	};

	appendLines(session, start === -1 ? lines : lines.slice(start));

	return session;
}

/**
 * Read what the log grew since the cursor, rotation included: when latest.log
 * was rolled, the newest archive still holds the rest of the file the cursor
 * was in, so nothing between two polls is lost. A boot marker inside the delta
 * means the server restarted underneath us (run.sh's crash loop, or an operator
 * in the screen session): the session resets to that boot.
 */
async function extend(session: LiveSession, inst: InstanceConfig): Promise<void> {
	const logsDir = join(instanceDir(inst), "logs");
	const latest = join(logsDir, "latest.log");

	if (!existsSync(latest)) {
		return;
	}

	const info = await stat(latest);
	const firstLine = await readFirstLine(latest);
	const sameFile = firstLine === session.cursor.firstLine && info.size >= session.cursor.offset;

	let chunk = "";

	if (sameFile) {
		if (info.size === session.cursor.offset) {
			return;
		}

		chunk = await Bun.file(latest).slice(session.cursor.offset, info.size).text();
	} else {
		// Rolled. The bytes past the cursor now live in the newest archive; prove
		// it is really the file the cursor was in by its first line before trusting
		// its offsets, because a daemon that was down across several rolls has lost
		// the middle and gluing the wrong remainder on would corrupt the session.
		const rotations = await rotatedLogs(logsDir);
		const newest = rotations[rotations.length - 1];

		if (newest && session.cursor.firstLine) {
			try {
				const compressed = await Bun.file(join(logsDir, newest)).bytes();
				const archived = new TextDecoder().decode(Bun.gunzipSync(compressed));

				if (firstLineOf(archived) === session.cursor.firstLine) {
					chunk = byteSlice(archived, session.cursor.offset);
				}
			} catch {
				// unreadable archive: the remainder is lost, the new file is not
			}
		}

		chunk += await Bun.file(latest).slice(0, info.size).text();
	}

	let text = session.cursor.remainder + chunk;
	let remainder = "";

	if (text.length && !text.endsWith("\n")) {
		const cut = text.lastIndexOf("\n") + 1;

		remainder = text.slice(cut);
		text = text.slice(0, cut);
	}

	const lines = text.length ? text.split(/\r?\n/) : [];

	if (lines.length && lines[lines.length - 1] === "") {
		lines.pop();
	}

	session.cursor.firstLine = firstLine;
	session.cursor.offset = info.size;
	session.cursor.remainder = remainder;

	if (!lines.length) {
		return;
	}

	// the LAST marker in the delta starts the newest boot
	const marker = traitsOf(inst.software, inst.mcVersion).bootMarker;
	let restartAt = -1;

	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (marker.test(lines[index]!)) {
			restartAt = index;

			break;
		}
	}

	if (restartAt !== -1) {
		session.bootLine = lines[restartAt]!;
		session.startedAt = Date.now();
		session.head = [];
		session.tail = [];
		session.dropped = 0;

		appendLines(session, lines.slice(restartAt));
	} else {
		appendLines(session, lines);
	}

	// the log's own write time, not ours: staleness detection compares this
	// against the instance's start time, and a read is not a write
	session.updatedAt = info.mtimeMs;
}

function appendLines(session: LiveSession, lines: string[]): void {
	for (const raw of lines) {
		const line = raw.length > LINE_MAX ? raw.slice(0, LINE_MAX) : raw;

		if (session.head.length < HEAD_MAX) {
			session.head.push(line);
		} else {
			session.tail.push(line);
		}

		session.appended += 1;
	}

	// amortized ring: compact in one slice instead of shifting per line
	if (session.tail.length > TAIL_MAX * 2) {
		session.dropped += session.tail.length - TAIL_MAX;
		session.tail = session.tail.slice(-TAIL_MAX);
	}
}

async function persist(session: LiveSession, force: boolean): Promise<void> {
	const now = Date.now();
	const due =
		force ||
		session.appended - session.persistedAppended >= PERSIST_EVERY_LINES ||
		(session.appended !== session.persistedAppended && now - session.persistedAt >= PERSIST_EVERY_MS);

	if (!due) {
		return;
	}

	try {
		await mkdir(sessionsDir(), { recursive: true });
		await Bun.write(
			sessionPath(session.instance),
			JSON.stringify({
				version: STORE_VERSION,
				instance: session.instance,
				bootLine: session.bootLine,
				startedAt: session.startedAt,
				updatedAt: session.updatedAt,
				head: session.head,
				tail: session.tail,
				dropped: session.dropped,
				appended: session.appended,
				cursor: session.cursor,
			}),
		);

		session.persistedAppended = session.appended;
		session.persistedAt = now;
	} catch {
		// a session that cannot be persisted still works; it just reseeds next boot
	}
}

async function loadPersisted(instance: string): Promise<LiveSession | undefined> {
	const path = sessionPath(instance);

	if (!existsSync(path)) {
		return undefined;
	}

	try {
		const raw = await Bun.file(path).json();

		if (raw?.version !== STORE_VERSION || raw?.instance !== instance) {
			return undefined;
		}

		return {
			instance,
			bootLine: String(raw.bootLine ?? ""),
			startedAt: Number(raw.startedAt) || Date.now(),
			updatedAt: Number(raw.updatedAt) || Date.now(),
			head: asLines(raw.head),
			tail: asLines(raw.tail),
			dropped: Number(raw.dropped) || 0,
			appended: Number(raw.appended) || 0,
			cursor: {
				firstLine: String(raw.cursor?.firstLine ?? ""),
				offset: Number(raw.cursor?.offset) || 0,
				remainder: String(raw.cursor?.remainder ?? ""),
			},
			persistedAppended: Number(raw.appended) || 0,
			persistedAt: Date.now(),
		};
	} catch {
		// a corrupt store file is a reseed, not an outage
		return undefined;
	}
}

function asLines(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.map((line) => String(line));
}

function firstLineOf(text: string): string {
	const end = text.indexOf("\n");

	return end === -1 ? text : text.slice(0, end).replace(/\r$/, "");
}

async function readFirstLine(path: string): Promise<string> {
	try {
		const head = await Bun.file(path).slice(0, FIRST_LINE_BYTES).text();

		return firstLineOf(head);
	} catch {
		return "";
	}
}

/**
 * The archived remainder past a byte offset. The cursor counts bytes (that is
 * what `stat` and `slice` speak), while a decompressed archive arrives as a
 * string, so the offset has to be applied in byte space.
 */
function byteSlice(text: string, offset: number): string {
	const bytes = new TextEncoder().encode(text);

	if (offset >= bytes.length) {
		return "";
	}

	return new TextDecoder().decode(bytes.subarray(offset));
}

/**
 * Rotated log files of an instance, oldest first.
 *
 * Ordered by when each archive was written, never by the index in its name:
 * the two log4j strategies in this cluster number in opposite directions.
 * Paper's counts upward, so its highest index is newest; Forge's uses the
 * min-index strategy, renaming every archive up a slot on each roll, so its
 * `-1` is always the newest. The roll itself is what stamps the file, and a
 * rename preserves that stamp, so mtime tells the truth for both.
 */
export async function rotatedLogs(logsDir: string): Promise<string[]> {
	if (!existsSync(logsDir)) {
		return [];
	}

	const files = (await readdir(logsDir)).filter((file) =>
		/^\d{4}-\d{2}-\d{2}-\d+\.log\.gz$/.test(file),
	);

	const stamped: Array<{ file: string; mtime: number }> = [];

	for (const file of files) {
		try {
			stamped.push({ file, mtime: (await stat(join(logsDir, file))).mtimeMs });
		} catch {
			// raced away between the listing and the stat; it was about to be pruned
		}
	}

	return stamped.sort((a, b) => a.mtime - b.mtime).map((entry) => entry.file);
}
