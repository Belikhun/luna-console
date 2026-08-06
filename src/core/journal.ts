// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The console journal: what luna itself did, as opposed to what a Minecraft
 * server did.
 *
 * `core/logs.ts` reads an *instance's* log, and the daemon's in-memory event log
 * (`daemon/events.ts`) carries state changes for the live views. Neither answers
 * "what has the console been doing", which is the question an operator asks after
 * a failed deploy or an unexplained sign-in; the event log is capped at 200
 * entries and dies with the daemon, and an instance's log knows nothing about the
 * console. So this is a third thing on purpose: an append-only file per month,
 * written by the daemon, the web routes and the CLI alike.
 *
 * The format is NDJSON, one entry per line, under `logs/console/<YYYY-MM>.ndjson`.
 * Appending is a single `appendFile`, so concurrent writers interleave lines
 * rather than corrupting each other, and a month's file can be read, grepped or
 * shipped off the box with no tooling at all.
 *
 * The journal is **per machine**: each daemon writes its own cluster root, and a
 * read returns the file on the machine the read ran on. A follower's journal
 * stays on the follower, where its own `luna` CLI can read it.
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { root } from "./config";

/** Which part of luna wrote the entry. */
export type JournalSource = "daemon" | "web" | "cli" | "auth" | "job" | "scheduler";

export type JournalLevel = "debug" | "info" | "warn" | "error";

/** Every source, in the order the console's filter offers them. */
export const JOURNAL_SOURCES: JournalSource[] = [
	"daemon",
	"web",
	"cli",
	"auth",
	"job",
	"scheduler",
];

/** Every level, weakest first; also the filter's "this level and above" order. */
export const JOURNAL_LEVELS: JournalLevel[] = ["debug", "info", "warn", "error"];

/** How many entries a read returns when the caller does not say. */
export const DEFAULT_JOURNAL_LINES = 300;

/** Upper bound on one read; the console is a viewer, not an exporter. */
export const MAX_JOURNAL_LINES = 5_000;

/**
 * Most of one month's file a single read will look at. A busy month is still only
 * a few megabytes, but a read must not be able to pull an unbounded file into
 * memory just because it was left running for a year.
 */
const MAX_READ_BYTES = 8 * 1024 * 1024;

export interface JournalEntry {
	/** Epoch millis */
	t: number;
	source: JournalSource;
	level: JournalLevel;
	/** The daemon that wrote it; a journal read is per machine, but a shipped file is not */
	machine: string;
	message: string;
	/** Second line: a stack, a failing path, the request that produced it */
	detail?: string;
	/** Console account behind the entry, where one was signed in */
	actor?: string;
}

/**
 * Which machine's name entries are stamped with. Injected by the daemon runtime,
 * exactly as `environment.setProxyHost` is: core cannot read the daemon's
 * identity without importing from `daemon/`, and that is the wrong direction.
 */
let machineName = "";

/** Set the name written into every entry from this process. Never called from core. */
export function setJournalMachine(name: string): void {
	machineName = name;
}

/** Directory holding the monthly journal files. */
export function journalDir(): string {
	return join(root(), "logs", "console");
}

/** `YYYY-MM` of a timestamp; the month a journal file is keyed by. */
function monthKey(at: number): string {
	const date = new Date(at);
	const month = String(date.getMonth() + 1).padStart(2, "0");

	return `${date.getFullYear()}-${month}`;
}

/** Path of the file a timestamp's entry belongs in. */
function journalPath(at: number): string {
	return join(journalDir(), `${monthKey(at)}.ndjson`);
}

export interface JournalInput {
	source: JournalSource;
	level?: JournalLevel;
	message: string;
	detail?: string;
	actor?: string;
}

/**
 * Append one entry. Failures are swallowed: journalling is a side effect of doing
 * something else, and a full disk must not turn a working deploy into a crash.
 */
export async function appendJournal(input: JournalInput): Promise<void> {
	const entry: JournalEntry = {
		t: Date.now(),
		source: input.source,
		level: input.level ?? "info",
		machine: machineName,
		message: input.message,
		detail: input.detail,
		actor: input.actor,
	};

	try {
		await mkdir(journalDir(), { recursive: true });
		await appendFile(journalPath(entry.t), JSON.stringify(entry) + "\n", "utf8");
	} catch {
		// the journal is never the reason a caller fails
	}
}

export interface JournalQuery {
	/** Newest N entries after filtering; capped at MAX_JOURNAL_LINES */
	limit?: number;
	/** Only these sources; every source when absent or empty */
	sources?: JournalSource[];
	/** This level and above, by JOURNAL_LEVELS order */
	minLevel?: JournalLevel;
	/** Only entries at or after this epoch millis */
	since?: number;
	/** Substring match over the message, detail and actor */
	search?: string;
}

export interface JournalPage {
	entries: JournalEntry[];
	/** Monthly files present, newest month first, with their sizes */
	files: Array<{ file: string; sizeBytes: number }>;
	/** True when the filter matched more than `limit`, so the view is a tail */
	truncated: boolean;
}

function parseLine(line: string): JournalEntry | undefined {
	if (!line.trim()) {
		return undefined;
	}

	try {
		const entry = JSON.parse(line) as JournalEntry;

		// hand-appended or half-written lines are dropped rather than rendered as
		// an entry with no timestamp, which sorts to 1970 and looks like data loss
		if (typeof entry.t !== "number" || typeof entry.message !== "string") {
			return undefined;
		}

		return entry;
	} catch {
		return undefined;
	}
}

/** Read the tail of one monthly file, bounded by MAX_READ_BYTES. */
async function readMonth(path: string): Promise<JournalEntry[]> {
	const info = await stat(path);
	const file = Bun.file(path);
	const text =
		info.size > MAX_READ_BYTES
			? await file.slice(info.size - MAX_READ_BYTES).text()
			: await file.text();

	const entries: JournalEntry[] = [];

	for (const line of text.split("\n")) {
		const entry = parseLine(line);

		if (entry) {
			entries.push(entry);
		}
	}

	return entries;
}

function passes(entry: JournalEntry, query: JournalQuery, minRank: number): boolean {
	if (query.sources?.length && !query.sources.includes(entry.source)) {
		return false;
	}

	if (JOURNAL_LEVELS.indexOf(entry.level) < minRank) {
		return false;
	}

	if (query.since !== undefined && entry.t < query.since) {
		return false;
	}

	if (query.search) {
		const needle = query.search.toLowerCase();
		const haystack = `${entry.message} ${entry.detail ?? ""} ${entry.actor ?? ""}`.toLowerCase();

		if (!haystack.includes(needle)) {
			return false;
		}
	}

	return true;
}

/**
 * Read the journal, newest entry first. Months are read from the newest backwards
 * and the walk stops as soon as the limit is met, so a filter that matches
 * yesterday's entries never touches last year's file.
 */
export async function readJournal(query: JournalQuery = {}): Promise<JournalPage> {
	const dir = journalDir();
	const wanted = Math.min(Math.max(1, query.limit ?? DEFAULT_JOURNAL_LINES), MAX_JOURNAL_LINES);
	const minRank = Math.max(0, JOURNAL_LEVELS.indexOf(query.minLevel ?? "debug"));

	if (!existsSync(dir)) {
		return { entries: [], files: [], truncated: false };
	}

	const names = (await readdir(dir)).filter((name) => name.endsWith(".ndjson")).sort().reverse();
	const files: JournalPage["files"] = [];
	const entries: JournalEntry[] = [];
	let truncated = false;

	for (const name of names) {
		const path = join(dir, name);
		const info = await stat(path);

		files.push({ file: name, sizeBytes: info.size });

		// the file list is part of the answer, so the walk keeps stat-ing months it
		// no longer needs to read
		if (entries.length >= wanted) {
			truncated = true;

			continue;
		}

		const month = await readMonth(path);

		for (let i = month.length - 1; i >= 0; i--) {
			const entry = month[i]!;

			if (!passes(entry, query, minRank)) {
				continue;
			}

			if (entries.length >= wanted) {
				truncated = true;

				break;
			}

			entries.push(entry);
		}
	}

	return { entries, files, truncated };
}
