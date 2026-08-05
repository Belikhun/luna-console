/**
 * Turning a Minecraft model into the flat quads an inventory slot shows.
 *
 * The client does not draw a hardcoded cube. It renders the item's *model* -
 * every box in it, with that box's own faces, UVs and rotation; through the
 * transform the model itself declares under `display.gui`. That is why a stair
 * is not a cube seen from the same angle (its gui rotation is 135°, not 225°)
 * and why a slab, a torch or an anvil come out the right shape at all.
 *
 * This module does the geometry; the canvas work lives in `MinecraftItem`.
 * It follows the same three steps the client does:
 *
 *   1. take each element's corners in the model's own 0-16 space,
 *   2. push them through the element rotation and then `display.gui`
 *      (translate, then rotate, then scale; the client's own order),
 *   3. project orthographically, since the GUI has no perspective at all.
 *
 * Face brightness is computed from the two lights the client sets up for items
 * in a slot rather than from a per-direction constant, so a rotated element is
 * shaded like the surface it actually is.
 */

import type {
	GuiTransform,
	ModelDirection,
	ModelElement,
	ModelElementRotation,
	ModelGeometry
} from '$shared/mcassets';

type Vec3 = [number, number, number];
type Vec2 = [number, number];
type Bit = 0 | 1;

const DEG = Math.PI / 180;

function normalize(vector: Vec3): Vec3 {
	const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;

	return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function dot(left: Vec3, right: Vec3): number {
	return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

/**
 * How bright a surface facing this way comes out, in view space.
 *
 * The three faces a block shows in a slot were measured off Mojang's own
 * inventory icons rather than guessed: against `blue_concrete`, whose texture is
 * a single colour, the top comes back at the texture's full value, the left face
 * at 0.64 of it and the right at 0.40 (and the same numbers reproduce the
 * furnace and crafting-table icons face for face, texture for texture). The
 * client's published two-light term cannot produce that spread, so this is a
 * soft light from up-and-to-the-left over a bright ambient, fitted to hit those
 * three values exactly.
 *
 * Fitting rather than tabulating is what lets a rotated element; a lever, a
 * rail, an open trapdoor; shade continuously instead of snapping to whichever
 * axis it is nearest.
 */
const AMBIENT = 0.6593;
const DIFFUSE = 0.4285;
const LIGHT = normalize([-0.3961, 0.9182, 0]);

function shadeFor(normal: Vec3): number {
	return Math.max(0, Math.min(1, AMBIENT + DIFFUSE * dot(normal, LIGHT)));
}

interface FaceShape {
	/** Outward normal in model space */
	normal: Vec3;
	/**
	 * The four corners, as `[xEnd, yEnd, zEnd, u, v]`: the first three pick the
	 * `from` or `to` end of the box on each axis, the last two pick which corner
	 * of the UV rectangle that vertex carries.
	 */
	corners: Array<[Bit, Bit, Bit, Bit, Bit]>;
}

// Corner order matches the client's own face winding, so a face's UV lands the
// way the model author drew it rather than mirrored or a quarter turn out.
const FACES: Record<ModelDirection, FaceShape> = {
	up: {
		normal: [0, 1, 0],
		corners: [
			[0, 1, 1, 0, 0],
			[1, 1, 1, 1, 0],
			[0, 1, 0, 0, 1],
			[1, 1, 0, 1, 1]
		]
	},
	down: {
		normal: [0, -1, 0],
		corners: [
			[1, 0, 1, 0, 0],
			[0, 0, 1, 1, 0],
			[1, 0, 0, 0, 1],
			[0, 0, 0, 1, 1]
		]
	},
	east: {
		normal: [1, 0, 0],
		corners: [
			[1, 1, 1, 0, 0],
			[1, 0, 1, 0, 1],
			[1, 1, 0, 1, 0],
			[1, 0, 0, 1, 1]
		]
	},
	west: {
		normal: [-1, 0, 0],
		corners: [
			[0, 1, 0, 0, 0],
			[0, 0, 0, 0, 1],
			[0, 1, 1, 1, 0],
			[0, 0, 1, 1, 1]
		]
	},
	north: {
		normal: [0, 0, -1],
		corners: [
			[1, 0, 0, 0, 1],
			[0, 0, 0, 1, 1],
			[1, 1, 0, 0, 0],
			[0, 1, 0, 1, 0]
		]
	},
	south: {
		normal: [0, 0, 1],
		corners: [
			[0, 0, 1, 0, 1],
			[1, 0, 1, 1, 1],
			[0, 1, 1, 0, 0],
			[1, 1, 1, 1, 0]
		]
	}
};

/**
 * The UV a face gets when the model states none: the box's own extent on the
 * two axes the face spans, which is how a half-height element takes the bottom
 * half of its texture without saying so.
 */
function defaultUv(direction: ModelDirection, from: Vec3, to: Vec3): [number, number, number, number] {
	switch (direction) {
		case 'down':
			return [from[0], 16 - to[2], to[0], 16 - from[2]];
		case 'up':
			return [from[0], from[2], to[0], to[2]];
		case 'north':
			return [16 - to[0], 16 - to[1], 16 - from[0], 16 - from[1]];
		case 'south':
			return [from[0], 16 - to[1], to[0], 16 - from[1]];
		case 'west':
			return [from[2], 16 - to[1], to[2], 16 - from[1]];
		case 'east':
			return [16 - to[2], 16 - to[1], 16 - from[2], 16 - from[1]];
	}
}

const UV_CYCLE: Array<[Bit, Bit]> = [
	[0, 0],
	[1, 0],
	[1, 1],
	[0, 1]
];

/** A face's `rotation` turns the texture within the face, in 90° steps. */
function rotateUv(u: Bit, v: Bit, rotation: number | undefined): [Bit, Bit] {
	const steps = ((Math.round((rotation ?? 0) / 90) % 4) + 4) % 4;

	if (steps === 0) {
		return [u, v];
	}

	const index = UV_CYCLE.findIndex(([cu, cv]) => cu === u && cv === v);

	return UV_CYCLE[(index + steps) % 4] ?? [u, v];
}

/** Rotate a model-space point about an element's own origin. */
function applyElementRotation(point: Vec3, rotation: ModelElementRotation): Vec3 {
	const angle = rotation.angle * DEG;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	// `rescale` stretches the element so a 45° face still meets its neighbours -
	// what makes a rail or a lever look continuous instead of pinched
	const scale = rotation.rescale ? 1 / Math.cos(Math.abs(angle)) : 1;

	let x = point[0] - rotation.origin[0];
	let y = point[1] - rotation.origin[1];
	let z = point[2] - rotation.origin[2];

	if (rotation.axis === 'x') {
		const ny = y * cos - z * sin;
		const nz = y * sin + z * cos;
		y = ny * scale;
		z = nz * scale;
	} else if (rotation.axis === 'y') {
		const nx = x * cos + z * sin;
		const nz = -x * sin + z * cos;
		x = nx * scale;
		z = nz * scale;
	} else {
		const nx = x * cos - y * sin;
		const ny = x * sin + y * cos;
		x = nx * scale;
		y = ny * scale;
	}

	return [x + rotation.origin[0], y + rotation.origin[1], z + rotation.origin[2]];
}

/** The same rotation applied to a direction, which takes no origin or rescale. */
function rotateDirection(direction: Vec3, rotation: ModelElementRotation): Vec3 {
	const spun = applyElementRotation(
		[direction[0] + rotation.origin[0], direction[1] + rotation.origin[1], direction[2] + rotation.origin[2]],
		{ ...rotation, rescale: false }
	);

	return normalize([spun[0] - rotation.origin[0], spun[1] - rotation.origin[1], spun[2] - rotation.origin[2]]);
}

type Matrix3 = [number, number, number, number, number, number, number, number, number];

function multiply(left: Matrix3, right: Matrix3): Matrix3 {
	const out = new Array<number>(9).fill(0);

	for (let row = 0; row < 3; row++) {
		for (let column = 0; column < 3; column++) {
			let sum = 0;

			for (let index = 0; index < 3; index++) {
				sum += (left[row * 3 + index] ?? 0) * (right[index * 3 + column] ?? 0);
			}

			out[row * 3 + column] = sum;
		}
	}

	return out as Matrix3;
}

function transform(matrix: Matrix3, vector: Vec3): Vec3 {
	return [
		matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
		matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
		matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2]
	];
}

/**
 * The `display.gui` rotation, composed the way the client composes it: X first,
 * then Y, then Z. A block's is [30, 225, 0], which is what gives the familiar
 * two-to-one diamond on top rather than a true isometric one.
 */
function guiRotationMatrix(degrees: Vec3): Matrix3 {
	const [x, y, z] = degrees.map((value) => value * DEG) as Vec3;

	const rotX: Matrix3 = [1, 0, 0, 0, Math.cos(x), -Math.sin(x), 0, Math.sin(x), Math.cos(x)];
	const rotY: Matrix3 = [Math.cos(y), 0, Math.sin(y), 0, 1, 0, -Math.sin(y), 0, Math.cos(y)];
	const rotZ: Matrix3 = [Math.cos(z), -Math.sin(z), 0, Math.sin(z), Math.cos(z), 0, 0, 0, 1];

	return multiply(multiply(rotX, rotY), rotZ);
}

/** One textured parallelogram, ready for the canvas. */
export interface ItemQuad {
	/** `#key` or a texture path; the caller resolves and loads it */
	texture: string;
	/** The face takes the item's tint colour */
	tinted: boolean;
	/** Where the UV rectangle's top-left corner lands, in slot pixels */
	origin: Vec2;
	/** Screen vector along the UV's u axis */
	u: Vec2;
	/** Screen vector along the UV's v axis */
	v: Vec2;
	/** The source rectangle in the texture's own 0-16 space, always positive */
	uv: [number, number, number, number];
	/** 0-1 brightness multiplier */
	shade: number;
	/** Larger is nearer the viewer; quads are returned far-to-near */
	depth: number;
}

/** An element with no thickness is a plane; both of its sides are meant to show. */
function isSolid(element: ModelElement): boolean {
	return (
		Math.abs(element.to[0] - element.from[0]) > 1e-6
		&& Math.abs(element.to[1] - element.from[1]) > 1e-6
		&& Math.abs(element.to[2] - element.from[2]) > 1e-6
	);
}

/**
 * Project a model into the quads an inventory slot draws, back to front.
 *
 * Coordinates come back in *slot pixels*; the 16×16 box the client gives an
 * item; with the origin at the slot's centre and y pointing down, so the
 * caller only has to scale them to whatever size it is drawing at.
 *
 * @param geometry the model's boxes and its `display.gui` transform
 * @returns every visible face, sorted so painting them in order is correct
 */
export function buildQuads(geometry: ModelGeometry): ItemQuad[] {
	const gui: GuiTransform = geometry.gui;
	const matrix = guiRotationMatrix(gui.rotation);
	const quads: ItemQuad[] = [];

	/** Model space is 0-16 around a block centred on 8; the slot is 16 across. */
	const project = (point: Vec3): { screen: Vec2; depth: number } => {
		const scaled: Vec3 = [
			(point[0] / 16 - 0.5) * gui.scale[0],
			(point[1] / 16 - 0.5) * gui.scale[1],
			(point[2] / 16 - 0.5) * gui.scale[2]
		];

		const rotated = transform(matrix, scaled);

		return {
			// the client flips Y on the way into the slot, so model up is screen up
			screen: [(rotated[0] + gui.translation[0]) * 16, -(rotated[1] + gui.translation[1]) * 16],
			depth: rotated[2] + gui.translation[2]
		};
	};

	for (const element of geometry.elements) {
		const solid = isSolid(element);
		const ends: [Vec3, Vec3] = [element.from, element.to];

		for (const [direction, face] of Object.entries(element.faces) as Array<[ModelDirection, ModelElement['faces'][ModelDirection]]>) {
			if (!face) {
				continue;
			}

			const shape = FACES[direction];
			const normal = element.rotation ? rotateDirection(shape.normal, element.rotation) : shape.normal;
			const viewNormal = transform(matrix, normal);

			// a face pointing away from the viewer is behind the box it belongs to;
			// a plane has no inside, so both of its sides are kept
			if (solid && viewNormal[2] <= 0) {
				continue;
			}

			const uv = face.uv ? [...face.uv] as [number, number, number, number] : defaultUv(direction, element.from, element.to);
			const placed = new Map<string, { screen: Vec2; depth: number }>();
			let depth = 0;

			for (const [xEnd, yEnd, zEnd, u, v] of shape.corners) {
				const point: Vec3 = [ends[xEnd][0], ends[yEnd][1], ends[zEnd][2]];
				const moved = element.rotation ? applyElementRotation(point, element.rotation) : point;
				const projected = project(moved);
				const [ru, rv] = rotateUv(u, v, face.rotation);

				placed.set(`${ru}${rv}`, projected);
				depth += projected.depth / 4;
			}

			const at00 = placed.get('00');
			const at10 = placed.get('10');
			const at01 = placed.get('01');

			if (!at00 || !at10 || !at01) {
				continue;
			}

			let origin: Vec2 = at00.screen;
			let uAxis: Vec2 = [at10.screen[0] - at00.screen[0], at10.screen[1] - at00.screen[1]];
			let vAxis: Vec2 = [at01.screen[0] - at00.screen[0], at01.screen[1] - at00.screen[1]];

			// a model may state its UV backwards to mirror a texture; the source
			// rectangle has to stay positive, so the flip moves into the axes
			if (uv[0] > uv[2]) {
				origin = [origin[0] + uAxis[0], origin[1] + uAxis[1]];
				uAxis = [-uAxis[0], -uAxis[1]];
				[uv[0], uv[2]] = [uv[2], uv[0]];
			}

			if (uv[1] > uv[3]) {
				origin = [origin[0] + vAxis[0], origin[1] + vAxis[1]];
				vAxis = [-vAxis[0], -vAxis[1]];
				[uv[1], uv[3]] = [uv[3], uv[1]];
			}

			quads.push({
				texture: face.texture,
				tinted: face.tinted === true,
				origin,
				u: uAxis,
				v: vAxis,
				uv,
				// a model lit from the front is drawn flat, the way a sprite is
				shade: geometry.guiLight === 'front' ? 1 : shadeFor(viewNormal),
				depth
			});
		}
	}

	return quads.sort((left, right) => left.depth - right.depth);
}

/** Multiply a tint by a face's brightness, so one fill does both. */
export function multiplyColor(shade: number, tint: string | undefined): string {
	const channels = tint ? parseHex(tint) : [255, 255, 255];

	return `rgb(${channels.map((channel) => Math.round(channel * shade)).join(',')})`;
}

function parseHex(value: string): [number, number, number] {
	const clean = value.replace('#', '');
	const full = clean.length === 3 ? clean.split('').map((part) => part + part).join('') : clean;
	const number = Number.parseInt(full.slice(0, 6), 16);

	if (!Number.isFinite(number)) {
		return [255, 255, 255];
	}

	return [(number >> 16) & 0xff, (number >> 8) & 0xff, number & 0xff];
}
