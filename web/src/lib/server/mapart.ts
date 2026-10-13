// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Picking the tiles that become a server card's artwork.
 *
 * Both map plugins render the world into a pyramid of tiles, and a coarse one is
 * a top-down picture of a whole region at no cost, which is why the card needs no
 * image pipeline on the server at all. All this has to do is work out *which*
 * tiles, which means reading each map's own geometry.
 *
 * Resolved here rather than in the browser because it takes two reads of the
 * map's own files to learn, and doing that per card per visitor would put the map
 * under the public page's traffic. One resolution per instance, cached, and the
 * browser then fetches four images it can cache hard.
 *
 * The answer is deliberately a list of URLs rather than coordinates: the two
 * providers address their tiles nothing like each other, and a card that has to
 * know which one it is drawing is a card that grows a branch per provider.
 */

import { mapAccess } from '$core/publicsite';
import type { MapProviderId } from '$core/maps';
import { decodePng } from '$lib/server/imaging/png';
import { fetchMapFile, readMapJson } from '$lib/server/mapfile';

/**
 * How far zoomed out the card art is cut from.
 *
 * Deliberately the same number for both providers even though they count zoom
 * differently, because they happen to agree on what it buys: a tile covering a
 * few hundred blocks, which is a region rather than a rooftop.
 */
const ART_LEVEL = 2;

/**
 * How much of a BlueMap frame must be rendered before the card settles for it.
 *
 * Below this the art is mostly empty ground, and the next finer level shows the
 * same spawn area large enough to read.
 */
const MIN_FILL = 0.5;

/** How long a resolved layout is trusted. Worlds do not move. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Where the art for one instance comes from, and what worlds it has. */
export interface MapArt {
	provider: MapProviderId;
	/** Worlds in the map's own menu order, for the page's switcher */
	worlds: string[];
	/**
	 * The world the art was cut from, and the one the embed opens on.
	 *
	 * Carried here so the switcher and the artwork agree about which world is the
	 * primary one; neither provider lists them in an order a page can trust, and
	 * two places deriving that separately is how the switcher ends up opening on
	 * the nether.
	 */
	world: string;
	/** Four tiles, in reading order, forming a 2x2 around spawn */
	tiles: string[];
	/**
	 * Whether a tile is colour over a heightmap and needs its bottom half cropped.
	 *
	 * BlueMap packs both into one PNG; Dynmap's tiles are just pictures.
	 */
	crop: boolean;
}

interface CacheEntry {
	art: MapArt | null;
	at: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Resolve one instance's card art, or null when it has no usable map.
 *
 * Read through the map-file bridge rather than straight off the map server, so a
 * stopped instance still gets its card art out of the rendered files.
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
	const access = await mapAccess(instance);

	if (!access) {
		return null;
	}

	if (access.provider === 'dynmap') {
		return await dynmapArt(instance);
	}

	return await bluemapArt(instance);
}

// -- BlueMap --------------------------------------------------------------------

/**
 * BlueMap's lowres tiles: PNGs that are colour on the top half and a heightmap on
 * the bottom, addressed by map id, LOD and tile coordinates.
 *
 * The overworld is wanted, not whichever map happens to be listed first: the root
 * `settings.json` lists them in no useful order (a real cluster answers
 * `["survival_nether", "survival", "survival_the_end"]`), and a card showing a red
 * cavern for a survival server is a puzzle rather than a picture. Each map's own
 * `sorting` is what BlueMap orders its menu by, so that is what picks the primary
 * one here too.
 */
async function bluemapArt(instance: string): Promise<MapArt | null> {
	const root = (await readMapJson(instance, 'settings.json')) as { maps?: unknown } | null;
	const maps: unknown = root?.maps;

	if (!Array.isArray(maps) || !maps.length) {
		return null;
	}

	const loaded = await Promise.all(
		maps.map(async (id) => ({
			id: String(id),
			settings: (await readMapJson(instance, `maps/${String(id)}/settings.json`)) as any
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

	const startX = Number(settings?.startPos?.[0]) || 0;
	const startZ = Number(settings?.startPos?.[1]) || 0;

	// coarsest first; a level whose frame is mostly unrendered gives way to the
	// next finer one, since a world with a few hundred blocks explored is a small
	// patch in a dark square at the region scale
	let tiles: string[] = [];

	for (let lod = Math.min(ART_LEVEL, Math.max(1, lodCount)); lod >= 1; lod--) {
		// each step out multiplies the blocks a tile covers by the lod factor
		const span = tileSize * Math.pow(lodFactor, lod - 1);

		// the 2x2 whose inner corner is the tile boundary nearest spawn, so the
		// frame is centred on the part of the world people actually built in
		const tileX = Math.round(startX / span);
		const tileZ = Math.round(startZ / span);

		const corners = [
			{ x: tileX - 1, z: tileZ - 1 },
			{ x: tileX, z: tileZ - 1 },
			{ x: tileX - 1, z: tileZ },
			{ x: tileX, z: tileZ }
		];

		tiles = corners.map((tile) => `maps/${map}/tiles/${lod}/x${tile.x}/z${tile.z}.png`);

		if (lod === 1) {
			break;
		}

		const fill = await frameFill(instance, tiles);

		if (fill >= MIN_FILL) {
			break;
		}
	}

	return {
		provider: 'bluemap',
		worlds: usable.map((entry) => entry.id),
		world: map,
		tiles,
		crop: true
	};
}

/**
 * The share of a BlueMap frame's colour that is rendered, from 0 to 1.
 *
 * Unrendered ground is transparent in a lowres tile, and a tile with nothing in
 * it is not written at all, so a missing tile counts as empty.
 */
async function frameFill(instance: string, tiles: string[]): Promise<number> {
	const fills = await Promise.all(tiles.map((tile) => tileFill(instance, tile)));
	const total = fills.reduce((sum, fill) => sum + fill, 0);

	return total / tiles.length;
}

async function tileFill(instance: string, tile: string): Promise<number> {
	const file = await fetchMapFile(instance, tile);

	if (!file || file.status !== 200 || !file.body) {
		void file?.body?.cancel();

		return 0;
	}

	try {
		const image = decodePng(new Uint8Array(await new Response(file.body).arrayBuffer()));

		// only the top half is colour; the bottom is the heightmap the card crops
		const rows = Math.floor(image.height / 2);
		let opaque = 0;

		for (let index = 3; index < rows * image.width * 4; index += 4) {
			if (image.data[index]! > 0) {
				opaque++;
			}
		}

		return opaque / (rows * image.width || 1);
	} catch {
		return 0;
	}
}

// -- Dynmap ---------------------------------------------------------------------

/** One of Dynmap's map descriptors; the fields its own tile math reads. */
interface DynmapMap {
	name: string;
	prefix: string;
	worldtomap: number[];
	tilescale?: number;
	'image-format'?: string;
}

interface DynmapWorld {
	name: string;
	center?: { x: number; y: number; z: number };
	maps?: DynmapMap[];
}

/**
 * Dynmap's tiles, addressed the way its own client addresses them.
 *
 * The naming is reproduced from `hdmap.js`/`dynmaputils.js` rather than guessed:
 * a tile is `<prefix>/<x>>>5_<y>>>5/<zoom><x>_<y>.<fmt>`, the y axis is inverted
 * for an HD map, and a zoom-out level multiplies the coordinates by 2^level and
 * prefixes that many `z`s. The world position comes through the map's own
 * `worldtomap` matrix, so a rotated or flat perspective lands on the right tile
 * without this having to know which perspective it is.
 *
 * The first world is the overworld: Dynmap carries no sort key, and its own
 * webapp opens on the first entry too, so following it keeps the card and the
 * embed showing the same place.
 */
async function dynmapArt(instance: string): Promise<MapArt | null> {
	const config = (await readMapJson(instance, 'standalone/dynmap_config.json')) as {
		worlds?: DynmapWorld[];
		defaultmap?: string;
	} | null;

	const worlds = config?.worlds?.filter((world) => world?.name && world.maps?.length);

	if (!worlds?.length) {
		return null;
	}

	const world = worlds[0]!;
	const maps = world.maps!;
	const map = maps.find((entry) => entry.name === config?.defaultmap) ?? maps[0]!;

	const scale = 1 << ART_LEVEL;
	const size = 128 << (map.tilescale ?? 0);
	const format = map['image-format'] || 'png';

	const centre = world.center ?? { x: 0, y: 64, z: 0 };
	const matrix = map.worldtomap ?? [];

	// the projection Dynmap's own client uses, reduced to the one point wanted
	const lat = at(matrix, 3) * centre.x + at(matrix, 4) * centre.y + at(matrix, 5) * centre.z;
	const lng = at(matrix, 0) * centre.x + at(matrix, 1) * centre.y + at(matrix, 2) * centre.z;

	// L.CRS.Simple over a native-zoom tile grid: lng is the x pixel outright, and
	// the y axis counts down from the middle of the map
	const tileX = Math.floor(lng / size) >> ART_LEVEL;
	const tileY = Math.floor((size - lat) / size) >> ART_LEVEL;

	const corners = [
		{ x: tileX - 1, y: tileY - 1 },
		{ x: tileX, y: tileY - 1 },
		{ x: tileX - 1, y: tileY },
		{ x: tileX, y: tileY }
	];

	return {
		provider: 'dynmap',
		worlds: worlds.map((entry) => entry.name),
		world: world.name,
		tiles: corners.map((tile) => {
			const x = scale * tile.x;
			// HD maps count y upwards, tiles downwards
			const y = -(scale * tile.y);
			const zoom = 'z'.repeat(ART_LEVEL) + (ART_LEVEL ? '_' : '');

			return `tiles/${world.name}/${map.prefix}/${x >> 5}_${y >> 5}/${zoom}${x}_${y}.${format}`;
		}),
		crop: false
	};
}

/** One coefficient of a projection matrix, or zero when the map omitted it. */
function at(matrix: number[], index: number): number {
	return Number(matrix[index]) || 0;
}
