/**
 * A minimal zip32 reader: the central directory, and one entry at a time.
 *
 * It exists because the things luna needs to look inside — a resource pack, a
 * Minecraft client jar — are read for a handful of small files each, and pulling
 * in an archive library to do that would be heavier than the reader itself.
 * Zip64 archives are rejected rather than half-read.
 */

import { inflateRawSync } from "node:zlib";

/** End-of-central-directory signature, and the largest tail it can hide in. */
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MAX_TAIL = 66_000;

const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_FIXED = 30;

/** A zip32 field this size means "see the zip64 record", which we do not read. */
const ZIP64_MARKER = 0xffffffff;

/** One file inside a pack zip, as its central-directory record describes it. */
export interface ZipEntry {
	name: string;
	compressedBytes: number;
	uncompressedBytes: number;
	/** 0 = stored, 8 = deflate; anything else we cannot decompress */
	method: number;
	localHeaderOffset: number;
}

/** Every entry of a zip, read from the central directory alone. */
export async function readZipEntries(path: string): Promise<ZipEntry[]> {
	const file = Bun.file(path);
	const size = file.size;

	if (size < 22) {
		throw new Error("not a zip file (too short)");
	}

	const tailSize = Math.min(size, EOCD_MAX_TAIL);
	const tail = Buffer.from(await file.slice(size - tailSize, size).arrayBuffer());

	let eocd = -1;

	for (let at = tail.length - 22; at >= 0; at--) {
		if (tail.readUInt32LE(at) === EOCD_SIGNATURE) {
			eocd = at;

			break;
		}
	}

	if (eocd < 0) {
		throw new Error("not a zip file (no end-of-central-directory record)");
	}

	const count = tail.readUInt16LE(eocd + 10);
	const directorySize = tail.readUInt32LE(eocd + 12);
	const directoryOffset = tail.readUInt32LE(eocd + 16);

	if (directoryOffset === ZIP64_MARKER || directorySize === ZIP64_MARKER) {
		throw new Error("zip64 archives are not supported");
	}

	const directory = Buffer.from(
		await file.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer(),
	);

	const entries: ZipEntry[] = [];
	let at = 0;

	while (at + 46 <= directory.length && entries.length < count) {
		if (directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
			break;
		}

		const nameLength = directory.readUInt16LE(at + 28);
		const extraLength = directory.readUInt16LE(at + 30);
		const commentLength = directory.readUInt16LE(at + 32);

		entries.push({
			name: directory.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
			method: directory.readUInt16LE(at + 10),
			compressedBytes: directory.readUInt32LE(at + 20),
			uncompressedBytes: directory.readUInt32LE(at + 24),
			localHeaderOffset: directory.readUInt32LE(at + 42),
		});

		at += 46 + nameLength + extraLength + commentLength;
	}

	return entries;
}

/**
 * Read one entry's bytes. The local header is re-read rather than trusted from
 * the central directory: only it knows how long *this* copy's name and extra
 * fields are, and the payload starts after them.
 */
export async function readZipEntry(
	path: string,
	entry: ZipEntry,
	limitBytes = 8 * 1024 * 1024,
): Promise<Buffer | undefined> {
	if (entry.uncompressedBytes > limitBytes) {
		return undefined;
	}

	if (entry.method !== 0 && entry.method !== 8) {
		return undefined;
	}

	const file = Bun.file(path);
	const header = Buffer.from(
		await file
			.slice(entry.localHeaderOffset, entry.localHeaderOffset + LOCAL_HEADER_FIXED)
			.arrayBuffer(),
	);

	if (header.length < LOCAL_HEADER_FIXED) {
		return undefined;
	}

	const start =
		entry.localHeaderOffset +
		LOCAL_HEADER_FIXED +
		header.readUInt16LE(26) +
		header.readUInt16LE(28);

	const raw = Buffer.from(await file.slice(start, start + entry.compressedBytes).arrayBuffer());

	return entry.method === 0 ? raw : inflateRawSync(raw);
}
