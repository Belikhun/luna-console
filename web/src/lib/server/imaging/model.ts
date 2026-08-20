// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The player model, as quads with skin UVs.
 *
 * Everything is in texels, the unit the skin is drawn in: the model is 32 tall,
 * 16 wide across the arms, and stands with its feet at y = 0 and its centre on
 * the y axis. +X is the player's left, +Y is up, +Z is the direction the player
 * faces, so a camera on +Z sees the front.
 *
 * A box's six faces are cut from the skin by the same unwrapped net Minecraft
 * uses, which is why one builder covers every part: give it the net's origin
 * and the box's size and the rects fall out. Overlay parts are the same net one
 * region further along, drawn on a box grown by the vanilla inflation (half a
 * texel per side for the helmet, a quarter for the rest), which is what makes
 * hair and jackets sit outside the skin instead of fighting it for depth.
 */

export interface Vec3 {
	x: number;
	y: number;
	z: number;
}

/** One textured face. Corners run uv(0,0) → (1,0) → (1,1) → (0,1). */
export interface Quad {
	corners: [Vec3, Vec3, Vec3, Vec3];
	/** Source rect in the skin, in texels */
	u: number;
	v: number;
	w: number;
	h: number;
}

export interface BoxSpec {
	/** Minimum corner of the box, before inflation */
	x: number;
	y: number;
	z: number;
	/** Size along X, Y and Z */
	w: number;
	h: number;
	d: number;
	/** Origin of this part's net in the skin */
	u: number;
	v: number;
	/** How far the box grows on every side; the UVs do not change with it */
	inflate?: number;
}

/**
 * The six faces of one box.
 *
 * @param spec where the box is, how big it is, and where its net starts
 * @returns the faces, each with the rect of the skin it shows
 */
export function boxQuads(spec: BoxSpec): Quad[] {
	const grow = spec.inflate ?? 0;

	const x0 = spec.x - grow;
	const y0 = spec.y - grow;
	const z0 = spec.z - grow;
	const x1 = spec.x + spec.w + grow;
	const y1 = spec.y + spec.h + grow;
	const z1 = spec.z + spec.d + grow;

	const { u, v, w, h, d } = spec;

	const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

	return [
		// front (+Z): u runs with +X, v downward
		{
			corners: [at(x0, y1, z1), at(x1, y1, z1), at(x1, y0, z1), at(x0, y0, z1)],
			u: u + d,
			v: v + d,
			w,
			h
		},

		// back (-Z): the net continues past the left face, so u runs with -X
		{
			corners: [at(x1, y1, z0), at(x0, y1, z0), at(x0, y0, z0), at(x1, y0, z0)],
			u: u + d + w + d,
			v: v + d,
			w,
			h
		},

		// the player's right (-X), which faces the viewer's left
		{
			corners: [at(x0, y1, z0), at(x0, y1, z1), at(x0, y0, z1), at(x0, y0, z0)],
			u,
			v: v + d,
			w: d,
			h
		},

		// the player's left (+X)
		{
			corners: [at(x1, y1, z1), at(x1, y1, z0), at(x1, y0, z0), at(x1, y0, z1)],
			u: u + d + w,
			v: v + d,
			w: d,
			h
		},

		// top (+Y): v runs with +Z, so the face's own front edge is the net's bottom
		{
			corners: [at(x0, y1, z0), at(x1, y1, z0), at(x1, y1, z1), at(x0, y1, z1)],
			u: u + d,
			v,
			w,
			h: d
		},

		// bottom (-Y), seen from below: v runs with -Z
		{
			corners: [at(x0, y0, z1), at(x1, y0, z1), at(x1, y0, z0), at(x0, y0, z0)],
			u: u + d + w,
			v,
			w,
			h: d
		}
	];
}

/**
 * Turn a face about a point in the XY plane, which is how an arm leaves the
 * body: the shoulder stays where it is and the hand swings out.
 */
function swing(quads: Quad[], pivotX: number, pivotY: number, degrees: number): Quad[] {
	const angle = (degrees * Math.PI) / 180;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);

	return quads.map((quad) => ({
		...quad,
		corners: quad.corners.map((corner) => {
			const dx = corner.x - pivotX;
			const dy = corner.y - pivotY;

			return {
				x: pivotX + dx * cos - dy * sin,
				y: pivotY + dx * sin + dy * cos,
				z: corner.z
			};
		}) as [Vec3, Vec3, Vec3, Vec3]
	}));
}

/** How much of the player a render draws. */
export type PartSet = 'head' | 'bust' | 'full';

export interface ModelOptions {
	/** 3-texel arms, and the half-texel drop that comes with them */
	slim: boolean;
	/**
	 * Degrees each arm hangs away from the body, turning on its shoulder.
	 * The flat views leave it at zero; the three-dimensional ones open the arms
	 * a little, which is what stops a hand from merging into a trouser leg once
	 * the model is turned.
	 */
	armSplay?: number;
	/** Draw the jacket, sleeves and trousers */
	overlay: boolean;
	/** Draw the head's second layer */
	helmet: boolean;
	parts: PartSet;
}

/**
 * The whole model as one flat list of faces.
 *
 * Base parts come first and overlays after their own part rather than in a
 * trailing group: the renderer sorts by depth before drawing, and keeping a
 * part with its overlay makes the list readable next to the skin's net.
 *
 * @param opts which parts to include and which model to use
 * @returns every face to draw, in no particular order
 */
export function playerQuads(opts: ModelOptions): Quad[] {
	const quads: Quad[] = [];
	const armWidth = opts.slim ? 3 : 4;

	// vanilla hangs slim arms half a texel lower than wide ones
	const armY = opts.slim ? 11.5 : 12;

	quads.push(...boxQuads({ x: -4, y: 24, z: -4, w: 8, h: 8, d: 8, u: 0, v: 0 }));

	if (opts.helmet) {
		quads.push(...boxQuads({ x: -4, y: 24, z: -4, w: 8, h: 8, d: 8, u: 32, v: 0, inflate: 0.5 }));
	}

	if (opts.parts === 'head') {
		return quads;
	}

	quads.push(...boxQuads({ x: -4, y: 12, z: -2, w: 8, h: 12, d: 4, u: 16, v: 16 }));

	const splay = opts.armSplay ?? 0;

	quads.push(
		...swing(
			boxQuads({ x: -4 - armWidth, y: armY, z: -2, w: armWidth, h: 12, d: 4, u: 40, v: 16 }),
			-4,
			24,
			-splay
		)
	);

	quads.push(
		...swing(
			boxQuads({ x: 4, y: armY, z: -2, w: armWidth, h: 12, d: 4, u: 32, v: 48 }),
			4,
			24,
			splay
		)
	);

	if (opts.overlay) {
		quads.push(
			...boxQuads({ x: -4, y: 12, z: -2, w: 8, h: 12, d: 4, u: 16, v: 32, inflate: 0.25 })
		);

		quads.push(
			...swing(
				boxQuads({
					x: -4 - armWidth,
					y: armY,
					z: -2,
					w: armWidth,
					h: 12,
					d: 4,
					u: 40,
					v: 32,
					inflate: 0.25
				}),
				-4,
				24,
				-splay
			)
		);

		quads.push(
			...swing(
				boxQuads({
					x: 4,
					y: armY,
					z: -2,
					w: armWidth,
					h: 12,
					d: 4,
					u: 48,
					v: 48,
					inflate: 0.25
				}),
				4,
				24,
				splay
			)
		);
	}

	if (opts.parts === 'bust') {
		return quads;
	}

	quads.push(...boxQuads({ x: -4, y: 0, z: -2, w: 4, h: 12, d: 4, u: 0, v: 16 }));
	quads.push(...boxQuads({ x: 0, y: 0, z: -2, w: 4, h: 12, d: 4, u: 16, v: 48 }));

	if (opts.overlay) {
		quads.push(
			...boxQuads({ x: -4, y: 0, z: -2, w: 4, h: 12, d: 4, u: 0, v: 32, inflate: 0.25 })
		);

		quads.push(...boxQuads({ x: 0, y: 0, z: -2, w: 4, h: 12, d: 4, u: 0, v: 48, inflate: 0.25 }));
	}

	return quads;
}
