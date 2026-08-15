// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Picking the tiles that become a server card's artwork.
 *
 * BlueMap renders the world into lowres tiles: PNGs that are colour on the top
 * half and a heightmap on the bottom. Cropping to the top half in CSS turns one
 * of them into a top-down picture of the world at no cost, which is why the
 * card needs no image pipeline on the server at all. All this has to do is work
 * out *which* tiles, which means reading the map's own geometry.
 *
 * Resolved here rather than in the browser because it takes two requests to the
 * map server to learn, and doing that per card per visitor would put the map
 * server under the public page's traffic. One resolution per instance, cached,
 * and the browser then fetches four PNGs it can cache hard.
 */

import { mapEndpoint } from '$core/publicsite';

/** Zoom level the card art is cut from; 1 is finest, 3 coarsest. */
const ART_LOD = 2;

/** How long a resolved layout is trusted. Worlds do not move. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Where the art for one instance comes from, and what worlds it has. */
export interface MapArt {
	/** BlueMap map id of the primary world, e.g. "survival" */
	map: string;
	lod: number;
	/** Four tiles, in reading order, forming a 2x2 around spawn */
	tiles: Array<{ x: number; z: number }>;
	/**
	 * Every world, in BlueMap's own menu order.
	 *
	 * Carried here so the page's world switcher and the card's artwork agree
	 * about which world is the primary one; the root `settings.json` lists them
	 * in no useful order, and two places deriving that separately is how the
	 * switcher ends up opening on the nether.
	 */
	worlds: string[];
}

interface CacheEntry {
	art: MapArt | null;
	at: number;
}

const cache = new Map<string, CacheEntry>();

async function readJson(origin: string, path: string): Promise<any | null> {
	try {
		const response = await fetch(`http://${origin}/${path}`, {
			signal: AbortSignal.timeout(5000)
		});

		return response.ok ? await response.json() : null;
	} catch {
		return null;
	}
}

/**
 * Resolve one instance's card art, or null when it has no usable map.
 *
 * The overworld is wanted, not whichever map happens to be listed first: the
 * root `settings.json` lists them in no useful order (a real cluster answers
 * `["survival_nether", "survival", "survival_the_end"]`), and a card showing a
 * red cavern for a survival server is a puzzle rather than a picture. Each
 * map's own `sorting` is what BlueMap orders its menu by, so that is what picks
 * the primary one here too.
 */
export async function resolveMapArt(instance: string): Promise<MapArt | null> {
	const hit = cache.get(instance);

	if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
		return hit.art;
	}

	const art = await resolve(instance);

	cache.set(instance, { art, at: Date.now() });

	return art;
}

async function resolve(instance: string): Promise<MapArt | null> {
	const endpoint = await mapEndpoint(instance);

	if (!endpoint) {
		return null;
	}

	const root = await readJson(endpoint.origin, 'settings.json');
	const maps: unknown = root?.maps;

	if (!Array.isArray(maps) || !maps.length) {
		return null;
	}

	const loaded = await Promise.all(
		maps.map(async (id) => ({
			id: String(id),
			settings: await readJson(endpoint.origin, `maps/${String(id)}/settings.json`)
		}))
	);

	const usable = loaded.filter((entry) => entry.settings);

	if (!usable.length) {
		return null;
	}

	// lowest `sorting` first, name as the tie-break so the pick is stable
	usable.sort(
		(left, right) =>
			(Number(left.settings.sorting) || 0) - (Number(right.settings.sorting) || 0) ||
			left.id.localeCompare(right.id)
	);

	const map = usable[0]!.id;
	const settings = usable[0]!.settings;

	const tileSize = Number(settings?.lowres?.tileSize?.[0]) || 500;
	const lodFactor = Number(settings?.lowres?.lodFactor) || 5;
	const lodCount = Number(settings?.lowres?.lodCount) || 3;
	const lod = Math.min(ART_LOD, Math.max(1, lodCount));

	// each step out multiplies the blocks a tile covers by the lod factor
	const span = tileSize * Math.pow(lodFactor, lod - 1);

	const startX = Number(settings?.startPos?.[0]) || 0;
	const startZ = Number(settings?.startPos?.[1]) || 0;

	const tileX = Math.floor(startX / span);
	const tileZ = Math.floor(startZ / span);

	// the 2x2 whose inner corner is spawn's own tile boundary, so the frame is
	// centred on the part of the world people actually built in
	const tiles = [
		{ x: tileX - 1, z: tileZ - 1 },
		{ x: tileX, z: tileZ - 1 },
		{ x: tileX - 1, z: tileZ },
		{ x: tileX, z: tileZ }
	];

	return { map, lod, tiles, worlds: usable.map((entry) => entry.id) };
}
