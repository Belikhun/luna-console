// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * A minimal NBT reader: enough of Mojang's binary format to read `level.dat`.
 *
 * It exists for the same reason `services/zip.ts` does. The only NBT luna ever
 * opens is a world's `level.dat`, a few kilobytes holding a dozen scalars it
 * wants to show an operator before they import a world; pulling in a library to
 * read that would be heavier than the reader itself.
 *
 * Read-only, and deliberately so: luna never writes a world's metadata. It
 * reports what is there and lets the server own the file.
 */

import { gunzipSync, inflateSync } from "node:zlib";
import { t } from "../../shared/i18n";

/** Tag ids, as the format numbers them. */
const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_SHORT = 2;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_FLOAT = 5;
const TAG_DOUBLE = 6;
const TAG_BYTE_ARRAY = 7;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;

/**
 * A ceiling on what this reader will decompress.
 *
 * `level.dat` is kilobytes; anything claiming to be one and expanding past this
 * is either not a `level.dat` or is trying to exhaust the daemon's memory, and
 * both deserve the same refusal.
 */
const MAX_DECOMPRESSED_BYTES = 16 * 1024 * 1024;

/** Nesting past this is a malformed or hostile file, not a world. */
const MAX_DEPTH = 64;

/** A decoded tag value; a compound is a plain object, a list a plain array. */
export type NbtValue =
	| number
	| bigint
	| string
	| Uint8Array
	| Int32Array
	| BigInt64Array
	| NbtValue[]
	| NbtCompound;

/** A `TAG_Compound`, keyed by tag name. */
export interface NbtCompound {
	[key: string]: NbtValue;
}

/** Cursor over the buffer; the parser's whole state. */
interface Cursor {
	buf: Buffer;
	at: number;
}

function need(cursor: Cursor, bytes: number): void {
	if (cursor.at + bytes > cursor.buf.length) {
		throw new Error(t("core.services.nbtTruncated"));
	}
}

function readString(cursor: Cursor): string {
	need(cursor, 2);

	const length = cursor.buf.readUInt16BE(cursor.at);

	cursor.at += 2;

	need(cursor, length);

	// NBT's "modified UTF-8" differs from UTF-8 only for NUL and for characters
	// outside the BMP, neither of which appears in a level.dat's keys or values
	const text = cursor.buf.toString("utf8", cursor.at, cursor.at + length);

	cursor.at += length;

	return text;
}

function readPayload(cursor: Cursor, type: number, depth: number): NbtValue {
	if (depth > MAX_DEPTH) {
		throw new Error(t("core.services.nbtTooDeep"));
	}

	switch (type) {
		case TAG_BYTE: {
			need(cursor, 1);

			const value = cursor.buf.readInt8(cursor.at);

			cursor.at += 1;

			return value;
		}

		case TAG_SHORT: {
			need(cursor, 2);

			const value = cursor.buf.readInt16BE(cursor.at);

			cursor.at += 2;

			return value;
		}

		case TAG_INT: {
			need(cursor, 4);

			const value = cursor.buf.readInt32BE(cursor.at);

			cursor.at += 4;

			return value;
		}

		case TAG_LONG: {
			need(cursor, 8);

			// a bigint, not a number: a world seed uses the full 64 bits and
			// rounding one to a double changes it
			const value = cursor.buf.readBigInt64BE(cursor.at);

			cursor.at += 8;

			return value;
		}

		case TAG_FLOAT: {
			need(cursor, 4);

			const value = cursor.buf.readFloatBE(cursor.at);

			cursor.at += 4;

			return value;
		}

		case TAG_DOUBLE: {
			need(cursor, 8);

			const value = cursor.buf.readDoubleBE(cursor.at);

			cursor.at += 8;

			return value;
		}

		case TAG_BYTE_ARRAY: {
			need(cursor, 4);

			const length = cursor.buf.readInt32BE(cursor.at);

			cursor.at += 4;

			if (length < 0) {
				throw new Error(t("core.services.nbtBadLength"));
			}

			need(cursor, length);

			const value = Uint8Array.from(cursor.buf.subarray(cursor.at, cursor.at + length));

			cursor.at += length;

			return value;
		}

		case TAG_STRING: {
			return readString(cursor);
		}

		case TAG_LIST: {
			need(cursor, 5);

			const itemType = cursor.buf.readUInt8(cursor.at);
			const length = cursor.buf.readInt32BE(cursor.at + 1);

			cursor.at += 5;

			if (length < 0) {
				throw new Error(t("core.services.nbtBadLength"));
			}

			const items: NbtValue[] = [];

			// TAG_End as the item type is how an empty list is written; there are
			// no payloads to read and asking for one would throw
			if (itemType === TAG_END) {
				return items;
			}

			for (let i = 0; i < length; i++) {
				items.push(readPayload(cursor, itemType, depth + 1));
			}

			return items;
		}

		case TAG_COMPOUND: {
			const compound: NbtCompound = {};

			for (;;) {
				need(cursor, 1);

				const entryType = cursor.buf.readUInt8(cursor.at);

				cursor.at += 1;

				if (entryType === TAG_END) {
					break;
				}

				const name = readString(cursor);

				compound[name] = readPayload(cursor, entryType, depth + 1);
			}

			return compound;
		}

		case TAG_INT_ARRAY: {
			need(cursor, 4);

			const length = cursor.buf.readInt32BE(cursor.at);

			cursor.at += 4;

			if (length < 0) {
				throw new Error(t("core.services.nbtBadLength"));
			}

			need(cursor, length * 4);

			const value = new Int32Array(length);

			for (let i = 0; i < length; i++) {
				value[i] = cursor.buf.readInt32BE(cursor.at + i * 4);
			}

			cursor.at += length * 4;

			return value;
		}

		case TAG_LONG_ARRAY: {
			need(cursor, 4);

			const length = cursor.buf.readInt32BE(cursor.at);

			cursor.at += 4;

			if (length < 0) {
				throw new Error(t("core.services.nbtBadLength"));
			}

			need(cursor, length * 8);

			const value = new BigInt64Array(length);

			for (let i = 0; i < length; i++) {
				value[i] = cursor.buf.readBigInt64BE(cursor.at + i * 8);
			}

			cursor.at += length * 8;

			return value;
		}

		default: {
			throw new Error(t("core.services.nbtUnknownTag", { tag: String(type) }));
		}
	}
}

/**
 * Decompress an NBT blob if it is compressed, leaving a bare one alone.
 *
 * `level.dat` is gzip in practice, but the format allows zlib and raw, and a
 * hand-made archive occasionally carries one of the others. Sniffing the magic
 * is cheaper than failing on a world that is perfectly valid.
 */
function decompress(raw: Uint8Array): Buffer {
	const head = Buffer.from(raw.subarray(0, 2));

	if (head[0] === 0x1f && head[1] === 0x8b) {
		return Buffer.from(gunzipSync(raw, { maxOutputLength: MAX_DECOMPRESSED_BYTES }));
	}

	// zlib: low nibble 8 (deflate) and the two header bytes a multiple of 31
	if ((head[0]! & 0x0f) === 0x08 && (head[0]! * 256 + head[1]!) % 31 === 0) {
		return Buffer.from(inflateSync(raw, { maxOutputLength: MAX_DECOMPRESSED_BYTES }));
	}

	return Buffer.from(raw);
}

/**
 * Parse an NBT blob, decompressing it first when it needs it.
 *
 * @param raw the file's bytes, gzip/zlib compressed or not
 * @returns the root compound; the root's own tag name is discarded, since
 *   every writer leaves it empty and nothing reads it
 */
export function parseNbt(raw: Uint8Array): NbtCompound {
	const buf = decompress(raw);

	if (buf.length < 3) {
		throw new Error(t("core.services.nbtTruncated"));
	}

	const cursor: Cursor = { buf, at: 0 };
	const rootType = buf.readUInt8(cursor.at);

	cursor.at += 1;

	if (rootType !== TAG_COMPOUND) {
		throw new Error(t("core.services.nbtNotCompound"));
	}

	readString(cursor);

	return readPayload(cursor, TAG_COMPOUND, 0) as NbtCompound;
}

/** Follow a dotted path through nested compounds; undefined when it breaks. */
export function nbtPath(root: NbtCompound, path: string): NbtValue | undefined {
	let node: NbtValue | undefined = root;

	for (const part of path.split(".")) {
		if (node === null || typeof node !== "object" || Array.isArray(node) || ArrayBuffer.isView(node)) {
			return undefined;
		}

		node = (node as NbtCompound)[part];

		if (node === undefined) {
			return undefined;
		}
	}

	return node;
}

/** A path's value as a string, or undefined when it is absent or another type. */
export function nbtString(root: NbtCompound, path: string): string | undefined {
	const value = nbtPath(root, path);

	return typeof value === "string" ? value : undefined;
}

/** A path's value as a number, widening the integer tags; bigints included. */
export function nbtNumber(root: NbtCompound, path: string): number | undefined {
	const value = nbtPath(root, path);

	if (typeof value === "number") {
		return value;
	}

	if (typeof value === "bigint") {
		return Number(value);
	}

	return undefined;
}

/**
 * A path's value as a 64-bit integer.
 *
 * Separate from {@link nbtNumber} because a world seed and a `LastPlayed`
 * timestamp both use the full range, and a double cannot hold one exactly.
 */
export function nbtBigInt(root: NbtCompound, path: string): bigint | undefined {
	const value = nbtPath(root, path);

	if (typeof value === "bigint") {
		return value;
	}

	if (typeof value === "number" && Number.isInteger(value)) {
		return BigInt(value);
	}

	return undefined;
}

/** A path's value as a boolean; NBT has no boolean tag, so a byte stands in. */
export function nbtBoolean(root: NbtCompound, path: string): boolean | undefined {
	const value = nbtPath(root, path);

	if (typeof value === "number") {
		return value !== 0;
	}

	return undefined;
}

/** A path's value as a list of strings, dropping anything that is not one. */
export function nbtStringList(root: NbtCompound, path: string): string[] {
	const value = nbtPath(root, path);

	if (!Array.isArray(value)) {
		return [];
	}

	return value.filter((item): item is string => typeof item === "string");
}
