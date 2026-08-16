// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Reading, extracting and writing the zip archives a world travels in.
 *
 * Separate from `services/zip.ts`, which stays what it is: a zip32
 * central-directory reader for pulling a handful of small members out of a jar
 * or a resource pack. A world is a different size class. `survival` alone is
 * 29 GB across 26,256 files, so its archive is past the 4 GB mark where zip32
 * stops and zip64 begins - which that reader rejects outright - and its region
 * files are individually larger than the 8 MB it will inflate into memory.
 *
 * So this shells out, which is what the project already does whenever the tool
 * that wrote a format is the cheapest correct way to read it (`unzip -p` in
 * `core/archive.ts`, `tar -xzf` in `core/runtimes.ts`). Both binaries are built
 * with ZIP64_SUPPORT and LARGE_FILE_SUPPORT, they stream rather than buffer,
 * and they are decades more tested on malformed input than anything that would
 * be written here.
 */

import { mkdir, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ProgressReporter } from "../progress";
import { t } from "../../shared/i18n";

/**
 * Suffixes stored rather than deflated.
 *
 * Region files hold zlib-compressed chunks already: measured on this cluster, a
 * 9 MB `.mca` gives back 54 KB to `gzip -1`, which is 0.6% for minutes of CPU
 * across a whole world. `.dat` is gzipped NBT for the same reason, and the rest
 * are containers that carry their own compression.
 */
const STORED_SUFFIXES = [".mca", ".mcc", ".mcr", ".dat", ".dat_old", ".gz", ".zip", ".jar", ".png"];

/** Deflate level. Low on purpose: what is left after `-n` barely compresses. */
const DEFLATE_LEVEL = "1";

/** Progress is reported every this many files, not every file. */
const REPORT_EVERY = 250;

/** Files a world carries that must never enter an archive. */
const NEVER_ARCHIVE = new Set(["session.lock"]);

/** One member of an archive, as `unzip -l` describes it. */
export interface ArchiveEntry {
	/** Slash-separated path inside the archive; a directory keeps its trailing slash */
	name: string;
	/** Uncompressed size; zero for a directory entry */
	sizeBytes: number;
	/** Whether the entry is a directory record rather than a file */
	directory: boolean;
}

/** What a listing adds up to. */
export interface ArchiveListing {
	entries: ArchiveEntry[];
	totalBytes: number;
	fileCount: number;
}

/**
 * `unzip -l`'s body lines: size, ISO date, HH:MM, then exactly three spaces and
 * the name. Anchored on the date so a name containing runs of spaces survives.
 */
const LIST_LINE = /^\s*(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s{3}(.*)$/;

/** A name holding a control character; see `listArchive` for why that is fatal. */
const CONTROL_CHARS = /[\x00-\x1f]/;

/** `unzip`'s per-member lines: "  inflating: x" and "extracting: x" (stored). */
const EXTRACT_LINE = /^\s*(?:inflating|extracting):\s/;

/** `zip`'s per-member line: "  adding: x (deflated 4%)". */
const ADD_LINE = /^\s*adding:\s/;

/**
 * Count the lines of a subprocess's output that match, reporting as it goes.
 *
 * Shared by extract and create because both tools narrate one line per member
 * and both are counted against a total the caller already knows. The stream is
 * consumed line by line rather than buffered: a world produces tens of
 * thousands of these, and holding them all to count them afterwards would both
 * waste the memory and delay every report to the end.
 *
 * `onTick` fires every {@link REPORT_EVERY} matches, not every match; a report
 * per file would spend more time rendering progress than doing the work.
 */
async function countLines(
	stream: ReadableStream<Uint8Array>,
	pattern: RegExp,
	onTick: (count: number) => void,
): Promise<number> {
	const decoder = new TextDecoder();
	let carry = "";
	let count = 0;

	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
		carry += decoder.decode(chunk, { stream: true });

		const lines = carry.split("\n");

		carry = lines.pop() ?? "";

		for (const line of lines) {
			if (!pattern.test(line)) {
				continue;
			}

			count++;

			if (count % REPORT_EVERY === 0) {
				onTick(count);
			}
		}
	}

	return count;
}

/**
 * Every member of an archive, with its uncompressed size.
 *
 * Uses `unzip -l` rather than the in-house reader because this must work on
 * zip64, which is every archive of a real survival world.
 *
 * @throws when the archive cannot be read, or when a member's name contains a
 *   control character. That last one is not paranoia about content: the listing
 *   is newline-delimited text, so a name holding a newline would desynchronise
 *   the parse and silently mis-attribute every size after it.
 */
export async function listArchive(path: string): Promise<ArchiveListing> {
	const proc = Bun.spawn(["unzip", "-l", "--", path], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const [text, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);

	const code = await proc.exited;

	// 1 is "completed with warnings", which a perfectly listable archive can
	// produce; anything above it means the listing is not trustworthy
	if (code > 1) {
		throw new Error(
			t("core.services.archiveListFailed", { detail: stderr.trim().split("\n")[0] ?? String(code) }),
		);
	}

	const entries: ArchiveEntry[] = [];
	let totalBytes = 0;
	let fileCount = 0;

	for (const line of text.split("\n")) {
		const match = LIST_LINE.exec(line);

		if (!match) {
			continue;
		}

		const name = match[2] ?? "";

		if (CONTROL_CHARS.test(name)) {
			throw new Error(t("core.services.archiveBadName"));
		}

		const sizeBytes = Number(match[1]);
		const directory = name.endsWith("/");

		entries.push({ name, sizeBytes, directory });

		if (!directory) {
			totalBytes += sizeBytes;
			fileCount++;
		}
	}

	if (entries.length === 0) {
		throw new Error(t("core.services.archiveEmpty"));
	}

	return { entries, totalBytes, fileCount };
}

export interface ExtractOptions {
	archive: string;
	/** Directory the archive's own paths are resolved against; created if absent */
	dest: string;
	/** Members to expect, for the progress denominator; from a prior listing */
	expectedFiles: number;
	reporter?: ProgressReporter;
}

/**
 * Extract a whole archive into a directory, reporting progress as it runs.
 *
 * Everything comes out, and the caller rearranges afterwards with renames. The
 * alternative - passing the wanted members as arguments - does not survive a
 * world: 26,000 paths is far past `ARG_MAX`, and a rename inside one filesystem
 * costs nothing next to a second extraction pass.
 *
 * The caller is expected to have validated the member names first
 * (`core/world.ts` refuses absolute paths and `..` segments before anything
 * reaches here). `unzip` sanitises those itself, but a refusal the operator can
 * read beats a silent strip.
 */
export async function extractArchive(opts: ExtractOptions): Promise<number> {
	await mkdir(opts.dest, { recursive: true });

	// deliberately not -q: the per-file lines are the only honest source of
	// progress here. A timer against an elapsed guess would draw a bar that
	// means nothing, which is the spinner-that-says-nothing this project forbids
	const proc = Bun.spawn(["unzip", "-o", "-d", opts.dest, "--", opts.archive], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const total = Math.max(1, opts.expectedFiles);
	const done = await countLines(proc.stdout, EXTRACT_LINE, (count) => {
		opts.reporter?.report(
			Math.min(1, count / total),
			"info",
			t("core.services.archiveExtracting", { done: count, total }),
		);
	});

	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;

	if (code > 1) {
		throw new Error(
			t("core.services.archiveExtractFailed", { detail: stderr.trim().split("\n")[0] ?? String(code) }),
		);
	}

	opts.reporter?.complete(t("core.services.archiveExtracted", { count: done }));

	return done;
}

/** One file destined for an archive, relative to the base directory. */
export interface ArchiveSource {
	/** Slash-separated path relative to `baseDir`, and the name inside the zip */
	rel: string;
	sizeBytes: number;
}

/**
 * Every file under a directory, depth-first, as archive-relative paths.
 *
 * Symlinks are not followed. A world holding a symlink out of the instance
 * would otherwise pull whatever it points at into the archive, which is both a
 * disclosure and a way to make a 29 GB backup into a 300 GB one.
 */
export async function walkFiles(baseDir: string, prefix = ""): Promise<ArchiveSource[]> {
	const out: ArchiveSource[] = [];
	const dir = prefix ? join(baseDir, prefix) : baseDir;

	let items;

	try {
		items = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}

	for (const item of items) {
		const rel = prefix ? `${prefix}/${item.name}` : item.name;

		if (item.isSymbolicLink()) {
			continue;
		}

		if (item.isDirectory()) {
			out.push(...(await walkFiles(baseDir, rel)));

			continue;
		}

		if (!item.isFile() || NEVER_ARCHIVE.has(item.name)) {
			continue;
		}

		const info = await stat(join(baseDir, rel)).catch(() => undefined);

		if (!info) {
			continue;
		}

		out.push({ rel, sizeBytes: info.size });
	}

	return out;
}

export interface CreateOptions {
	/** Archive to write; must not already exist, since `zip` would append to it */
	dest: string;
	/** Directory the sources are relative to, and the archive's own root */
	baseDir: string;
	sources: ArchiveSource[];
	reporter?: ProgressReporter;
}

export interface CreateResult {
	sizeBytes: number;
	fileCount: number;
}

/**
 * Write a zip of the given files, reporting progress per file as it goes.
 *
 * The file list is fed on stdin (`zip -@`) rather than letting `zip -r` walk
 * the tree. That is what gives an exact denominator for progress, keeps the
 * exclusions in one place in TypeScript instead of split across shell globs,
 * and means the archive holds precisely what the caller enumerated.
 */
export async function createArchive(opts: CreateOptions): Promise<CreateResult> {
	if (opts.sources.length === 0) {
		throw new Error(t("core.services.archiveNothingToAdd"));
	}

	const proc = Bun.spawn(
		["zip", `-${DEFLATE_LEVEL}`, "-X", "-n", STORED_SUFFIXES.join(":"), "-@", opts.dest],
		{
			cwd: opts.baseDir,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	const writer = proc.stdin;

	for (const source of opts.sources) {
		writer.write(`${source.rel}\n`);
	}

	await writer.end();

	const total = opts.sources.length;
	const added = await countLines(proc.stdout, ADD_LINE, (count) => {
		opts.reporter?.report(count / total, "info", t("core.services.archiveAdding", { done: count, total }));
	});

	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;

	if (code !== 0) {
		throw new Error(
			t("core.services.archiveCreateFailed", { detail: stderr.trim().split("\n")[0] ?? String(code) }),
		);
	}

	const info = await stat(opts.dest);

	opts.reporter?.complete(t("core.services.archiveWrote", { count: total }));

	return { sizeBytes: info.size, fileCount: total };
}

/** A path's own size on disk, following nothing; zero when it is not there. */
export async function fileSize(path: string): Promise<number> {
	const info = await stat(path).catch(() => undefined);

	return info?.size ?? 0;
}

/** Archive-relative form of a path under a base directory. */
export function archiveRel(baseDir: string, path: string): string {
	return relative(baseDir, path).split(sep).join("/");
}
