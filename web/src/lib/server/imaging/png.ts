// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * A PNG codec, written out because the avatar renderer needs pixels on the
 * server and nothing in the stack provides them: Bun has no image decoder, and
 * the alternatives are native modules that would have to build inside the
 * published image for two architectures.
 *
 * The scope is deliberately the PNG a skin actually is. Decoding covers every
 * non-interlaced colour type at bit depths 1-16, because a player's skin comes
 * from wherever they made it and palette-with-tRNS files are common; encoding
 * only ever writes 8-bit RGBA, because that is what a render is.
 */

import { deflateSync, inflateSync } from 'node:zlib';

/** An image as the renderer holds it: straight RGBA, 8 bits per channel. */
export interface Bitmap {
	width: number;
	height: number;
	/** `width * height * 4` bytes, row-major, non-premultiplied */
	data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Channels per pixel for each PNG colour type; palette entries are indices. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** A render of 832×832 RGBA is 2.7 MB; anything past this is not a skin. */
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

const CRC_TABLE = (() => {
	const table = new Int32Array(256);

	for (let index = 0; index < 256; index++) {
		let value = index;

		for (let bit = 0; bit < 8; bit++) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}

		table[index] = value;
	}

	return table;
})();

function crc32(bytes: Uint8Array): number {
	let crc = -1;

	for (let index = 0; index < bytes.length; index++) {
		crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
	}

	return (crc ^ -1) >>> 0;
}

/** An empty, fully transparent bitmap. */
export function bitmap(width: number, height: number): Bitmap {
	return { width, height, data: new Uint8Array(width * height * 4) };
}

/**
 * Undo one scanline's filter in place, given the reconstructed line above it.
 *
 * `bpp` is the filter's notion of a pixel: bytes per pixel rounded up, which
 * for sub-byte depths is 1.
 */
function unfilter(type: number, line: Uint8Array, previous: Uint8Array, bpp: number): void {
	switch (type) {
		case 0:
			return;

		case 1:
			for (let index = bpp; index < line.length; index++) {
				line[index] = (line[index]! + line[index - bpp]!) & 0xff;
			}

			return;

		case 2:
			for (let index = 0; index < line.length; index++) {
				line[index] = (line[index]! + previous[index]!) & 0xff;
			}

			return;

		case 3:
			for (let index = 0; index < line.length; index++) {
				const left = index >= bpp ? line[index - bpp]! : 0;

				line[index] = (line[index]! + ((left + previous[index]!) >> 1)) & 0xff;
			}

			return;

		case 4:
			for (let index = 0; index < line.length; index++) {
				const left = index >= bpp ? line[index - bpp]! : 0;
				const up = previous[index]!;
				const upLeft = index >= bpp ? previous[index - bpp]! : 0;

				const estimate = left + up - upLeft;
				const distLeft = Math.abs(estimate - left);
				const distUp = Math.abs(estimate - up);
				const distUpLeft = Math.abs(estimate - upLeft);

				let predictor = upLeft;

				if (distLeft <= distUp && distLeft <= distUpLeft) {
					predictor = left;
				} else if (distUp <= distUpLeft) {
					predictor = up;
				}

				line[index] = (line[index]! + predictor) & 0xff;
			}

			return;

		default:
			throw new Error(`unknown PNG filter type ${type}`);
	}
}

/** Read one sample of `depth` bits from a scanline's bit stream. */
function sample(line: Uint8Array, index: number, depth: number): number {
	if (depth === 8) {
		return line[index]!;
	}

	if (depth === 16) {
		// 16-bit samples are scaled down; the renderer works in 8 bits
		return line[index * 2]!;
	}

	const perByte = 8 / depth;
	const byte = line[Math.floor(index / perByte)]!;
	const shift = 8 - depth * ((index % perByte) + 1);
	const mask = (1 << depth) - 1;

	return (byte >> shift) & mask;
}

/**
 * Decode a PNG into straight RGBA.
 *
 * @param bytes the file's contents
 * @returns the decoded bitmap
 * @throws when the file is not a PNG, is interlaced, or uses a combination the
 *         spec forbids
 */
export function decodePng(bytes: Uint8Array): Bitmap {
	for (let index = 0; index < SIGNATURE.length; index++) {
		if (bytes[index] !== SIGNATURE[index]) {
			throw new Error('not a PNG file');
		}
	}

	let width = 0;
	let height = 0;
	let depth = 8;
	let colorType = 6;
	let palette: Uint8Array | undefined;
	let paletteAlpha: Uint8Array | undefined;
	let transparent: number[] | undefined;
	const parts: Uint8Array[] = [];

	let offset = 8;

	while (offset + 8 <= bytes.length) {
		const length =
			(bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
		const type = String.fromCharCode(
			bytes[offset + 4]!,
			bytes[offset + 5]!,
			bytes[offset + 6]!,
			bytes[offset + 7]!
		);
		const start = offset + 8;
		const body = bytes.subarray(start, start + length);

		if (type === 'IHDR') {
			width = (body[0]! << 24) | (body[1]! << 16) | (body[2]! << 8) | body[3]!;
			height = (body[4]! << 24) | (body[5]! << 16) | (body[6]! << 8) | body[7]!;
			depth = body[8]!;
			colorType = body[9]!;

			if (body[12] !== 0) {
				throw new Error('interlaced PNGs are not supported');
			}
		} else if (type === 'PLTE') {
			palette = body.slice();
		} else if (type === 'tRNS') {
			if (colorType === 3) {
				paletteAlpha = body.slice();
			} else {
				transparent = [];

				for (let index = 0; index * 2 + 1 < body.length; index++) {
					transparent.push((body[index * 2]! << 8) | body[index * 2 + 1]!);
				}
			}
		} else if (type === 'IDAT') {
			parts.push(body);
		} else if (type === 'IEND') {
			break;
		}

		offset = start + length + 4;
	}

	if (width <= 0 || height <= 0 || width * height * 4 > MAX_DECODED_BYTES) {
		throw new Error(`unusable PNG dimensions ${width}×${height}`);
	}

	const channels = CHANNELS[colorType];

	if (channels === undefined) {
		throw new Error(`unknown PNG colour type ${colorType}`);
	}

	const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: MAX_DECODED_BYTES });
	const bitsPerPixel = channels * depth;
	const stride = Math.ceil((bitsPerPixel * width) / 8);
	const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));

	const out = bitmap(width, height);
	let previous = new Uint8Array(stride);
	let cursor = 0;

	// sub-byte greyscale scales its sample up to the full 0-255 range
	const grayScale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;

	for (let y = 0; y < height; y++) {
		const filter = raw[cursor]!;
		const line = raw.subarray(cursor + 1, cursor + 1 + stride).slice();

		cursor += 1 + stride;
		unfilter(filter, line, previous, bpp);
		previous = line;

		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 4;

			if (colorType === 3) {
				const index = sample(line, x, depth);
				const entry = index * 3;

				out.data[at] = palette?.[entry] ?? 0;
				out.data[at + 1] = palette?.[entry + 1] ?? 0;
				out.data[at + 2] = palette?.[entry + 2] ?? 0;
				out.data[at + 3] = paletteAlpha?.[index] ?? 255;
				continue;
			}

			if (colorType === 0 || colorType === 4) {
				const gray = Math.round(sample(line, x * channels, depth) * grayScale);
				const alpha = colorType === 4 ? sample(line, x * channels + 1, depth) : 255;

				out.data[at] = gray;
				out.data[at + 1] = gray;
				out.data[at + 2] = gray;
				out.data[at + 3] = colorType === 4 ? alpha : transparent?.[0] === gray ? 0 : 255;
				continue;
			}

			const red = sample(line, x * channels, depth);
			const green = sample(line, x * channels + 1, depth);
			const blue = sample(line, x * channels + 2, depth);

			out.data[at] = red;
			out.data[at + 1] = green;
			out.data[at + 2] = blue;

			if (colorType === 6) {
				out.data[at + 3] = sample(line, x * channels + 3, depth);
			} else {
				const keyed =
					transparent !== undefined &&
					transparent[0] === red &&
					transparent[1] === green &&
					transparent[2] === blue;

				out.data[at + 3] = keyed ? 0 : 255;
			}
		}
	}

	return out;
}

function chunk(type: string, body: Uint8Array): Buffer {
	const out = Buffer.alloc(body.length + 12);

	out.writeUInt32BE(body.length, 0);
	out.write(type, 4, 'ascii');
	Buffer.from(body).copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);

	return out;
}

/**
 * Pick the filter that makes a scanline cheapest to compress, by the sum of
 * absolute differences heuristic the spec's own guide recommends. Renders are
 * flat colour over large areas, so this reliably beats writing every row
 * unfiltered.
 */
function filterRow(line: Uint8Array, previous: Uint8Array, bpp: number): { type: number; bytes: Uint8Array } {
	const candidates: { type: number; bytes: Uint8Array }[] = [];
	const length = line.length;

	const none = line.slice();
	const sub = new Uint8Array(length);
	const up = new Uint8Array(length);
	const paeth = new Uint8Array(length);

	for (let index = 0; index < length; index++) {
		const left = index >= bpp ? line[index - bpp]! : 0;
		const above = previous[index]!;
		const aboveLeft = index >= bpp ? previous[index - bpp]! : 0;

		sub[index] = (line[index]! - left) & 0xff;
		up[index] = (line[index]! - above) & 0xff;

		const estimate = left + above - aboveLeft;
		const distLeft = Math.abs(estimate - left);
		const distUp = Math.abs(estimate - above);
		const distUpLeft = Math.abs(estimate - aboveLeft);

		let predictor = aboveLeft;

		if (distLeft <= distUp && distLeft <= distUpLeft) {
			predictor = left;
		} else if (distUp <= distUpLeft) {
			predictor = above;
		}

		paeth[index] = (line[index]! - predictor) & 0xff;
	}

	candidates.push({ type: 0, bytes: none });
	candidates.push({ type: 1, bytes: sub });
	candidates.push({ type: 2, bytes: up });
	candidates.push({ type: 4, bytes: paeth });

	let best = candidates[0]!;
	let bestScore = Number.POSITIVE_INFINITY;

	for (const candidate of candidates) {
		let score = 0;

		for (let index = 0; index < length; index++) {
			const value = candidate.bytes[index]!;

			score += value < 128 ? value : 256 - value;
		}

		if (score < bestScore) {
			bestScore = score;
			best = candidate;
		}
	}

	return best;
}

/**
 * Encode a bitmap as an 8-bit RGBA PNG.
 *
 * @param image the pixels to write
 * @returns the complete file
 */
export function encodePng(image: Bitmap): Buffer {
	const stride = image.width * 4;
	const raw = Buffer.alloc((stride + 1) * image.height);

	// typed as the loose view, since each row after the first is a subarray of
	// the caller's buffer rather than one we allocated
	let previous: Uint8Array<ArrayBufferLike> = new Uint8Array(stride);

	for (let y = 0; y < image.height; y++) {
		const line = image.data.subarray(y * stride, (y + 1) * stride);
		const chosen = filterRow(line, previous, 4);

		raw[y * (stride + 1)] = chosen.type;
		Buffer.from(chosen.bytes).copy(raw, y * (stride + 1) + 1);
		previous = line;
	}

	const header = Buffer.alloc(13);

	header.writeUInt32BE(image.width, 0);
	header.writeUInt32BE(image.height, 4);
	header[8] = 8;
	header[9] = 6;

	return Buffer.concat([
		Buffer.from(SIGNATURE),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw, { level: 6 })),
		chunk('IEND', new Uint8Array(0))
	]);
}
