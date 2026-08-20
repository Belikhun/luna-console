// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Turning whatever a player's skin file happens to be into the 64×64 texture
 * the renderer can sample, by the same steps the vanilla client performs:
 * a 64×32 skin is unfolded into the modern layout, translucency is taken off
 * the base layers, and an overlay that is opaque everywhere is erased.
 *
 * That last step is why old skins do not render with a black box for hair:
 * before the second layer existed, the hat region was whatever the author left
 * in the file, and one that is opaque everywhere is a background, not a
 * hairstyle.
 *
 * Order matters here. Arm width is read from pixels the opaque pass would
 * overwrite, so the model is decided first; and the pass then only touches the
 * rects that model actually draws, so a slim skin keeps the empty columns that
 * say it is slim.
 */

import { bitmap, type Bitmap } from './png';

/** One rect of the skin, in texels. */
interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface ProcessedSkin {
	/** Always 64×64, RGBA, base layers opaque */
	image: Bitmap;
	/** 3-texel arms */
	slim: boolean;
	/** The source file was a 64×32 legacy skin */
	legacy: boolean;
}

/**
 * The rects the client forces opaque: for each part, its two end faces and the
 * band of four side faces. Arms are narrower on the slim model, so their rects
 * are built rather than listed.
 */
function baseRegions(slim: boolean): Rect[] {
	const arm = slim ? 3 : 4;

	return [
		// head
		{ x: 8, y: 0, w: 16, h: 8 },
		{ x: 0, y: 8, w: 32, h: 8 },

		// body
		{ x: 20, y: 16, w: 16, h: 4 },
		{ x: 16, y: 20, w: 24, h: 12 },

		// right arm
		{ x: 44, y: 16, w: arm * 2, h: 4 },
		{ x: 40, y: 20, w: arm * 2 + 8, h: 12 },

		// right leg
		{ x: 4, y: 16, w: 8, h: 4 },
		{ x: 0, y: 20, w: 16, h: 12 },

		// left arm
		{ x: 36, y: 48, w: arm * 2, h: 4 },
		{ x: 32, y: 52, w: arm * 2 + 8, h: 12 },

		// left leg
		{ x: 20, y: 48, w: 8, h: 4 },
		{ x: 16, y: 52, w: 16, h: 12 }
	];
}

/** The overlay rects, each erased on its own when it turns out to be opaque. */
const OVERLAY_REGIONS: Rect[] = [
	{ x: 32, y: 0, w: 32, h: 16 },
	{ x: 16, y: 32, w: 24, h: 16 },
	{ x: 40, y: 32, w: 16, h: 16 },
	{ x: 0, y: 32, w: 16, h: 16 },
	{ x: 0, y: 48, w: 16, h: 16 },
	{ x: 48, y: 48, w: 16, h: 16 }
];

/**
 * Where each face of a legacy right limb lands on the modern left limb.
 *
 * Mirroring a limb swaps its side faces, so the copy is per face rather than
 * one flipped block: the right limb's outer side becomes the left limb's inner
 * side, and every face is reversed along X.
 */
const LEGACY_LIMBS: { from: Rect; to: Rect }[] = [
	// right arm → left arm
	{ from: { x: 44, y: 16, w: 4, h: 4 }, to: { x: 36, y: 48, w: 4, h: 4 } },
	{ from: { x: 48, y: 16, w: 4, h: 4 }, to: { x: 40, y: 48, w: 4, h: 4 } },
	{ from: { x: 40, y: 20, w: 4, h: 12 }, to: { x: 40, y: 52, w: 4, h: 12 } },
	{ from: { x: 44, y: 20, w: 4, h: 12 }, to: { x: 36, y: 52, w: 4, h: 12 } },
	{ from: { x: 48, y: 20, w: 4, h: 12 }, to: { x: 32, y: 52, w: 4, h: 12 } },
	{ from: { x: 52, y: 20, w: 4, h: 12 }, to: { x: 44, y: 52, w: 4, h: 12 } },

	// right leg → left leg
	{ from: { x: 4, y: 16, w: 4, h: 4 }, to: { x: 20, y: 48, w: 4, h: 4 } },
	{ from: { x: 8, y: 16, w: 4, h: 4 }, to: { x: 24, y: 48, w: 4, h: 4 } },
	{ from: { x: 0, y: 20, w: 4, h: 12 }, to: { x: 24, y: 52, w: 4, h: 12 } },
	{ from: { x: 4, y: 20, w: 4, h: 12 }, to: { x: 20, y: 52, w: 4, h: 12 } },
	{ from: { x: 8, y: 20, w: 4, h: 12 }, to: { x: 16, y: 52, w: 4, h: 12 } },
	{ from: { x: 12, y: 20, w: 4, h: 12 }, to: { x: 28, y: 52, w: 4, h: 12 } }
];

function pixelAt(image: Bitmap, x: number, y: number): number {
	return (y * image.width + x) * 4;
}

/** Copy a rect from `source` into `target`, reversed along X. */
function copyMirrored(source: Bitmap, target: Bitmap, from: Rect, to: Rect): void {
	for (let y = 0; y < from.h; y++) {
		for (let x = 0; x < from.w; x++) {
			const read = pixelAt(source, from.x + from.w - 1 - x, from.y + y);
			const write = pixelAt(target, to.x + x, to.y + y);

			target.data[write] = source.data[read]!;
			target.data[write + 1] = source.data[read + 1]!;
			target.data[write + 2] = source.data[read + 2]!;
			target.data[write + 3] = source.data[read + 3]!;
		}
	}
}

function copyRegion(source: Bitmap, target: Bitmap, from: Rect, toX: number, toY: number): void {
	for (let y = 0; y < from.h; y++) {
		for (let x = 0; x < from.w; x++) {
			const read = pixelAt(source, from.x + x, from.y + y);
			const write = pixelAt(target, toX + x, toY + y);

			target.data[write] = source.data[read]!;
			target.data[write + 1] = source.data[read + 1]!;
			target.data[write + 2] = source.data[read + 2]!;
			target.data[write + 3] = source.data[read + 3]!;
		}
	}
}

/** Whether every pixel of a rect is fully opaque. */
function fullyOpaque(image: Bitmap, rect: Rect): boolean {
	for (let y = rect.y; y < rect.y + rect.h; y++) {
		for (let x = rect.x; x < rect.x + rect.w; x++) {
			if (image.data[pixelAt(image, x, y) + 3] !== 255) {
				return false;
			}
		}
	}

	return true;
}

function clearRegion(image: Bitmap, rect: Rect): void {
	for (let y = rect.y; y < rect.y + rect.h; y++) {
		for (let x = rect.x; x < rect.x + rect.w; x++) {
			image.data[pixelAt(image, x, y) + 3] = 0;
		}
	}
}

function makeOpaque(image: Bitmap, rect: Rect): void {
	for (let y = rect.y; y < rect.y + rect.h; y++) {
		for (let x = rect.x; x < rect.x + rect.w; x++) {
			image.data[pixelAt(image, x, y) + 3] = 255;
		}
	}
}

/**
 * Scale a skin down to 64 texels wide.
 *
 * HD skins exist (128×128 and up, from mods and from resource packs) and the
 * renderer samples one texture size, so an oversized skin is box-filtered onto
 * the vanilla grid rather than rejected.
 */
function downscale(source: Bitmap, factor: number): Bitmap {
	const out = bitmap(Math.round(source.width / factor), Math.round(source.height / factor));

	for (let y = 0; y < out.height; y++) {
		for (let x = 0; x < out.width; x++) {
			let red = 0;
			let green = 0;
			let blue = 0;
			let alpha = 0;
			let samples = 0;

			for (let sy = 0; sy < factor; sy++) {
				for (let sx = 0; sx < factor; sx++) {
					const read = pixelAt(source, x * factor + sx, y * factor + sy);
					const weight = source.data[read + 3]!;

					red += source.data[read]! * weight;
					green += source.data[read + 1]! * weight;
					blue += source.data[read + 2]! * weight;
					alpha += weight;
					samples++;
				}
			}

			const write = pixelAt(out, x, y);

			// weighting colour by alpha keeps transparent pixels from bleeding
			out.data[write] = alpha > 0 ? Math.round(red / alpha) : 0;
			out.data[write + 1] = alpha > 0 ? Math.round(green / alpha) : 0;
			out.data[write + 2] = alpha > 0 ? Math.round(blue / alpha) : 0;
			out.data[write + 3] = Math.round(alpha / samples);
		}
	}

	return out;
}

/** A skin file scaled and unfolded to 64×64, with nothing else done to it. */
function normalise(source: Bitmap): { image: Bitmap; legacy: boolean } {
	let working = source;

	if (working.width > 64 && working.width % 64 === 0) {
		working = downscale(working, working.width / 64);
	}

	if (working.width !== 64 || (working.height !== 64 && working.height !== 32)) {
		throw new Error(`not a skin: ${source.width}×${source.height}`);
	}

	const legacy = working.height === 32;
	const image = bitmap(64, 64);

	copyRegion(working, image, { x: 0, y: 0, w: 64, h: working.height }, 0, 0);

	if (legacy) {
		for (const limb of LEGACY_LIMBS) {
			copyMirrored(working, image, limb.from, limb.to);
		}
	}

	return { image, legacy };
}

/**
 * Process a skin file the way the client would.
 *
 * @param source the decoded skin, any supported size
 * @param model `slim` or `wide` when the profile says so; otherwise the arm
 *              width is read off the skin itself
 * @returns the 64×64 texture, and which model it is drawn for
 * @throws when the file is not shaped like a skin at all
 */
export function processSkin(source: Bitmap, model?: 'slim' | 'wide'): ProcessedSkin {
	const { image, legacy } = normalise(source);

	// before the opaque pass, which would overwrite the columns it reads
	const slim = model === undefined ? !legacy && slimByPixels(image) : model === 'slim';

	for (const region of baseRegions(slim)) {
		makeOpaque(image, region);
	}

	for (const region of OVERLAY_REGIONS) {
		if (fullyOpaque(image, region)) {
			clearRegion(image, region);
		}
	}

	return { image, slim, legacy };
}

/**
 * Which model a skin file is drawn for, without processing it.
 *
 * @param source the decoded skin file
 * @returns whether it has 3-texel arms
 */
export function skinModel(source: Bitmap): boolean {
	const { image, legacy } = normalise(source);

	return !legacy && slimByPixels(image);
}

/**
 * Guess the arm width from the skin.
 *
 * A wide arm's net fills its whole block; a slim one leaves two columns of the
 * end faces and of the back face unused, so transparency in all four of them
 * means 3-texel arms. Legacy skins have no such columns to read, and are always
 * wide.
 */
function slimByPixels(image: Bitmap): boolean {
	const probes = [
		[50, 16],
		[54, 20],
		[42, 48],
		[46, 52]
	];

	for (const probe of probes) {
		if (image.data[pixelAt(image, probe[0]!, probe[1]!) + 3] !== 0) {
			return false;
		}
	}

	return true;
}
