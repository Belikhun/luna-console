// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The avatar renderer: a small software rasteriser that draws the player model
 * over a transparent background.
 *
 * There is no GPU here and no shading. Faces are drawn with the skin's own
 * colours, because a skin is painted with its lighting already in it and
 * shading it a second time turns hair into mud; what makes the render read as
 * three-dimensional is the perspective and the silhouette. Edges are smoothed
 * by drawing several samples per output pixel and averaging them, which is the
 * one antialiasing that leaves flat texel colours flat.
 *
 * Depth comes from a z-buffer holding inverse depth, and faces are drawn back
 * to front so that a skin's translucent pixels (a visor, a ghost) blend in the
 * right order. Orthographic views are the same code with the camera pushed far
 * enough away that the perspective vanishes, so there is one projection to get
 * right rather than two.
 */

import { bitmap, type Bitmap } from './png';
import { playerQuads, type PartSet, type Quad, type Vec3 } from './model';

/** The renders this service can produce; the URL's first segment. */
export type RenderKind = 'face' | 'front' | 'frontfull' | 'head' | 'bust' | 'full';

export interface RenderMode {
	parts: PartSet;
	/** Height of the visible window, in texels at the pivot's depth */
	window: number;
	/** The model-space height the camera looks at, and turns the model about */
	pivotY: number;
	/**
	 * Nudge of the image plane, as a fraction of the window's height. Framing a
	 * render by moving the pivot would move the camera and change the
	 * perspective with it; sliding the image plane is the same lens pointed the
	 * same way, which is what keeps a mode's framing independent of its angle.
	 */
	shiftY: number;
	/** Canvas width ÷ height */
	aspect: number;
	/** Default angles in degrees */
	yaw: number;
	pitch: number;
	/** Camera distance in texels; the flat views use a distance that flattens */
	distance: number;
	/** Whether this render puts the model on the ground with a shadow */
	shadow: boolean;
	/** Where the ground is, when there is a shadow */
	groundY: number;
	/** Radius of the shadow blob, in texels */
	shadowRadius: number;
	/** Largest height the URL may ask for */
	maxHeight: number;
	/** Whether ?y=/?p=/?r= mean anything here */
	rotatable: boolean;
	/** Degrees the arms hang away from the body */
	armSplay: number;
}

/**
 * Far enough that a 32-texel model shows no measurable convergence, so the flat
 * renders come out of the same projection as the perspective ones.
 */
const FLAT_DISTANCE = 4096;

/** The 8:13 canvas the tall renders use, matching the service being replaced. */
const TALL_ASPECT = 8 / 13;

/**
 * Framing per render.
 *
 * The windows are measured rather than invented: each one frames the model the
 * way vzge.me frames it, so a URL that swaps one host for the other keeps its
 * layout. Face is the head's 8 texels plus a fifth of a texel of air on each
 * side, which is what makes the helmet's outset visible without shrinking the
 * face to make room for it.
 */
export const RENDER_MODES: Record<RenderKind, RenderMode> = {
	face: {
		parts: 'head',
		window: 8.4,
		pivotY: 28,
		shiftY: 0,
		aspect: 1,
		yaw: 0,
		pitch: 0,
		distance: FLAT_DISTANCE,
		shadow: false,
		groundY: 24,
		shadowRadius: 8,
		maxHeight: 512,
		rotatable: false,
		armSplay: 0
	},

	front: {
		parts: 'bust',
		window: 20,
		pivotY: 22.25,
		shiftY: 0,
		aspect: 1,
		yaw: 0,
		pitch: 0,
		distance: FLAT_DISTANCE,
		shadow: false,
		groundY: 0,
		shadowRadius: 10,
		maxHeight: 512,
		rotatable: false,
		armSplay: 0
	},

	frontfull: {
		parts: 'full',
		window: 32.25,
		pivotY: 16,
		shiftY: 0,
		aspect: TALL_ASPECT,
		yaw: 0,
		pitch: 0,
		distance: FLAT_DISTANCE,
		shadow: false,
		groundY: 0,
		shadowRadius: 10,
		maxHeight: 832,
		rotatable: false,
		armSplay: 0
	},

	head: {
		parts: 'head',
		window: 16.346,
		pivotY: 27.5,
		shiftY: -0.0078,
		aspect: 1,
		yaw: -35,
		pitch: -20,
		distance: 32,
		shadow: true,
		groundY: 24,
		shadowRadius: 8.5,
		maxHeight: 512,
		rotatable: true,
		armSplay: 0
	},

	bust: {
		parts: 'bust',
		window: 22.006,
		pivotY: 22,
		shiftY: 0.0429,
		aspect: 1,
		yaw: 20,
		pitch: -20,
		distance: 96,
		shadow: false,
		groundY: 12,
		shadowRadius: 10,
		maxHeight: 512,
		rotatable: true,
		armSplay: 6
	},

	full: {
		parts: 'full',
		window: 34.563,
		pivotY: 16,
		shiftY: 0.0156,
		aspect: TALL_ASPECT,
		yaw: 20,
		pitch: -20,
		distance: 96,
		shadow: true,
		groundY: 0,
		shadowRadius: 6.5,
		maxHeight: 832,
		rotatable: true,
		armSplay: 6
	}
};

export interface RenderOptions {
	/** Output height in pixels */
	height: number;
	/** 3-texel arms */
	slim: boolean;
	/** Degrees, added to the mode's own angle */
	yaw?: number;
	pitch?: number;
	roll?: number;
	helmet?: boolean;
	overlay?: boolean;
	shadow?: boolean;
	/** Trim the transparent margins off the finished render */
	autocrop?: boolean;
}

/** Peak opacity of the ground shadow, matched against the reference service. */
const SHADOW_ALPHA = 0.85;

/**
 * Samples per output pixel along each axis.
 *
 * Four is enough that a diagonal texel edge reads as clean; the cap keeps a
 * full-size tall render from rasterising more than a few million samples, which
 * is the difference between a render costing tens of milliseconds and hundreds.
 */
function supersample(height: number): number {
	return Math.max(2, Math.min(4, Math.floor(1536 / height)));
}

interface Projected {
	x: number;
	y: number;
	/** 1 ÷ depth; larger is nearer */
	iw: number;
	u: number;
	v: number;
}

interface Poly {
	points: [Projected, Projected, Projected, Projected];
	/** Mean inverse depth, for the back-to-front sort */
	depth: number;
	sample: (u: number, v: number) => number;
}

function pack(red: number, green: number, blue: number, alpha: number): number {
	return (red & 0xff) | ((green & 0xff) << 8) | ((blue & 0xff) << 16) | ((alpha & 0xff) << 24);
}

/** Nearest-texel sampling: a skin is art at 64×64, so it is never smoothed. */
function texelSampler(skin: Bitmap): (u: number, v: number) => number {
	return (u, v) => {
		const x = Math.min(skin.width - 1, Math.max(0, Math.floor(u)));
		const y = Math.min(skin.height - 1, Math.max(0, Math.floor(v)));
		const at = (y * skin.width + x) * 4;

		return pack(skin.data[at]!, skin.data[at + 1]!, skin.data[at + 2]!, skin.data[at + 3]!);
	};
}

/**
 * The shadow's own sampler: black, fading out towards the edge of the quad it
 * is drawn on, so the blob has no visible boundary.
 */
function shadowSampler(): (u: number, v: number) => number {
	return (u, v) => {
		const dx = u * 2 - 1;
		const dy = v * 2 - 1;
		const distance = Math.sqrt(dx * dx + dy * dy);

		if (distance >= 1) {
			return 0;
		}

		// flat through the middle and steep at the rim, which is how a soft
		// shadow reads: a linear ramp looks like a smudge
		const falloff = (1 - distance * distance) ** 2;

		return pack(0, 0, 0, Math.round(SHADOW_ALPHA * falloff * 255));
	};
}

function rotate(point: Vec3, yaw: number, pitch: number, roll: number): Vec3 {
	const cosYaw = Math.cos(yaw);
	const sinYaw = Math.sin(yaw);
	const cosPitch = Math.cos(pitch);
	const sinPitch = Math.sin(pitch);
	const cosRoll = Math.cos(roll);
	const sinRoll = Math.sin(roll);

	// yaw turns the model on the spot, pitch tips its top towards the camera,
	// roll spins the finished image plane
	const x1 = point.x * cosYaw - point.z * sinYaw;
	const z1 = point.x * sinYaw + point.z * cosYaw;

	const y2 = point.y * cosPitch + z1 * sinPitch;
	const z2 = -point.y * sinPitch + z1 * cosPitch;

	const x3 = x1 * cosRoll - y2 * sinRoll;
	const y3 = x1 * sinRoll + y2 * cosRoll;

	return { x: x3, y: y3, z: z2 };
}

interface Camera {
	distance: number;
	/** Pixels per texel at the pivot's depth, multiplied by that depth */
	focal: number;
	centreX: number;
	centreY: number;
	pivotY: number;
	yaw: number;
	pitch: number;
	roll: number;
}

function project(camera: Camera, point: Vec3, u: number, v: number): Projected {
	const turned = rotate(
		{ x: point.x, y: point.y - camera.pivotY, z: point.z },
		camera.yaw,
		camera.pitch,
		camera.roll
	);

	const depth = camera.distance - turned.z;
	const iw = 1 / depth;

	return {
		x: camera.centreX + camera.focal * turned.x * iw,
		y: camera.centreY - camera.focal * turned.y * iw,
		iw,
		u,
		v
	};
}

/** Signed area of a projected quad; positive means we are looking at its front. */
function facing(points: Projected[]): number {
	let sum = 0;

	for (let index = 0; index < points.length; index++) {
		const a = points[index]!;
		const b = points[(index + 1) % points.length]!;

		sum += a.x * b.y - b.x * a.y;
	}

	return sum;
}

interface Target {
	width: number;
	height: number;
	/** Premultiplied RGBA, so blending is one multiply-add */
	colour: Float32Array;
	depth: Float32Array;
}

/**
 * Fill one triangle, testing depth per sample and writing it only for fully
 * opaque texels, so a translucent pixel cannot hide what is behind it.
 */
function triangle(
	target: Target,
	a: Projected,
	b: Projected,
	c: Projected,
	sample: (u: number, v: number) => number,
	writeDepth: boolean
): void {
	const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
	const maxX = Math.min(target.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
	const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
	const maxY = Math.min(target.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));

	if (minX > maxX || minY > maxY) {
		return;
	}

	const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

	if (area === 0) {
		return;
	}

	for (let y = minY; y <= maxY; y++) {
		const py = y + 0.5;

		for (let x = minX; x <= maxX; x++) {
			const px = x + 0.5;

			// barycentric weights, each named for the vertex it belongs to
			const weightC = ((b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x)) / area;
			const weightA = ((c.x - b.x) * (py - b.y) - (c.y - b.y) * (px - b.x)) / area;
			const weightB = 1 - weightC - weightA;

			if (weightA < 0 || weightB < 0 || weightC < 0) {
				continue;
			}

			const iw = weightA * a.iw + weightB * b.iw + weightC * c.iw;
			const index = y * target.width + x;

			if (iw <= target.depth[index]!) {
				continue;
			}

			const u = (weightA * a.u * a.iw + weightB * b.u * b.iw + weightC * c.u * c.iw) / iw;
			const v = (weightA * a.v * a.iw + weightB * b.v * b.iw + weightC * c.v * c.iw) / iw;

			const texel = sample(u, v);
			const alpha = ((texel >>> 24) & 0xff) / 255;

			if (alpha <= 0) {
				continue;
			}

			const at = index * 4;
			const keep = 1 - alpha;

			target.colour[at] = (texel & 0xff) * alpha + target.colour[at]! * keep;
			target.colour[at + 1] = ((texel >>> 8) & 0xff) * alpha + target.colour[at + 1]! * keep;
			target.colour[at + 2] = ((texel >>> 16) & 0xff) * alpha + target.colour[at + 2]! * keep;
			target.colour[at + 3] = alpha + target.colour[at + 3]! * keep;

			if (writeDepth && alpha >= 0.99) {
				target.depth[index] = iw;
			}
		}
	}
}

function drawPoly(target: Target, poly: Poly, writeDepth: boolean): void {
	const [p0, p1, p2, p3] = poly.points;

	triangle(target, p0, p1, p2, poly.sample, writeDepth);
	triangle(target, p0, p2, p3, poly.sample, writeDepth);
}

/** Average the samples of each output pixel and undo the premultiplication. */
function resolve(target: Target, factor: number): Bitmap {
	const out = bitmap(target.width / factor, target.height / factor);
	const samples = factor * factor;

	for (let y = 0; y < out.height; y++) {
		for (let x = 0; x < out.width; x++) {
			let red = 0;
			let green = 0;
			let blue = 0;
			let alpha = 0;

			for (let sy = 0; sy < factor; sy++) {
				for (let sx = 0; sx < factor; sx++) {
					const at = ((y * factor + sy) * target.width + x * factor + sx) * 4;

					red += target.colour[at]!;
					green += target.colour[at + 1]!;
					blue += target.colour[at + 2]!;
					alpha += target.colour[at + 3]!;
				}
			}

			const write = (y * out.width + x) * 4;
			const coverage = alpha / samples;

			if (coverage <= 0) {
				continue;
			}

			out.data[write] = Math.min(255, Math.round(red / samples / coverage));
			out.data[write + 1] = Math.min(255, Math.round(green / samples / coverage));
			out.data[write + 2] = Math.min(255, Math.round(blue / samples / coverage));
			out.data[write + 3] = Math.min(255, Math.round(coverage * 255));
		}
	}

	return out;
}

/** Cut the transparent margins off a finished render. */
function trim(image: Bitmap): Bitmap {
	let minX = image.width;
	let minY = image.height;
	let maxX = -1;
	let maxY = -1;

	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < image.width; x++) {
			if (image.data[(y * image.width + x) * 4 + 3]! > 0) {
				minX = Math.min(minX, x);
				maxX = Math.max(maxX, x);
				minY = Math.min(minY, y);
				maxY = Math.max(maxY, y);
			}
		}
	}

	if (maxX < 0) {
		return image;
	}

	const out = bitmap(maxX - minX + 1, maxY - minY + 1);

	for (let y = 0; y < out.height; y++) {
		const from = ((y + minY) * image.width + minX) * 4;

		out.data.set(image.data.subarray(from, from + out.width * 4), y * out.width * 4);
	}

	return out;
}

/** The ground quad the shadow is painted on. */
function shadowQuad(mode: RenderMode): Quad {
	const radius = mode.shadowRadius;
	const y = mode.groundY;

	return {
		corners: [
			{ x: -radius, y, z: -radius },
			{ x: radius, y, z: -radius },
			{ x: radius, y, z: radius },
			{ x: -radius, y, z: radius }
		],
		u: 0,
		v: 0,
		w: 1,
		h: 1
	};
}

/**
 * Draw one avatar.
 *
 * @param kind which render to produce
 * @param skin the processed 64×64 skin
 * @param opts output height, model width, angles and what to leave out
 * @returns the finished image, `opts.height` tall unless it was cropped
 */
export function renderAvatar(kind: RenderKind, skin: Bitmap, opts: RenderOptions): Bitmap {
	const mode = RENDER_MODES[kind];
	const factor = supersample(opts.height);

	const height = opts.height;
	const width = Math.round(height * mode.aspect);

	const target: Target = {
		width: width * factor,
		height: height * factor,
		colour: new Float32Array(width * factor * height * factor * 4),
		depth: new Float32Array(width * factor * height * factor)
	};

	const radians = Math.PI / 180;
	const camera: Camera = {
		distance: mode.distance,
		focal: (target.height / mode.window) * mode.distance,
		centreX: target.width / 2,
		centreY: target.height / 2 + mode.shiftY * target.height,
		pivotY: mode.pivotY,
		yaw: (mode.yaw + (mode.rotatable ? (opts.yaw ?? 0) : 0)) * radians,
		pitch: (mode.pitch + (mode.rotatable ? (opts.pitch ?? 0) : 0)) * radians,
		roll: (mode.rotatable ? (opts.roll ?? 0) : 0) * radians
	};

	if (mode.shadow && opts.shadow !== false) {
		const quad = shadowQuad(mode);
		const points = quad.corners.map((corner, index) =>
			project(camera, corner, index === 1 || index === 2 ? 1 : 0, index >= 2 ? 1 : 0)
		) as [Projected, Projected, Projected, Projected];

		// the ground is under everything, so it neither tests nor writes depth
		drawPoly(target, { points, depth: 0, sample: shadowSampler() }, false);
	}

	const sample = texelSampler(skin);
	const quads = playerQuads({
		slim: opts.slim,
		armSplay: mode.armSplay,
		overlay: opts.overlay !== false,
		helmet: opts.helmet !== false,
		parts: mode.parts
	});

	const polys: Poly[] = [];

	for (const quad of quads) {
		const points = [
			project(camera, quad.corners[0], quad.u, quad.v),
			project(camera, quad.corners[1], quad.u + quad.w, quad.v),
			project(camera, quad.corners[2], quad.u + quad.w, quad.v + quad.h),
			project(camera, quad.corners[3], quad.u, quad.v + quad.h)
		] as [Projected, Projected, Projected, Projected];

		if (facing(points) <= 0) {
			continue;
		}

		const depth = (points[0].iw + points[1].iw + points[2].iw + points[3].iw) / 4;

		polys.push({ points, depth, sample });
	}

	// back to front, so a translucent texel blends over what it covers
	polys.sort((left, right) => left.depth - right.depth);

	for (const poly of polys) {
		drawPoly(target, poly, true);
	}

	const image = resolve(target, factor);

	return opts.autocrop ? trim(image) : image;
}
