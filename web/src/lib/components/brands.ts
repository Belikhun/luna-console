// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Brand marks for the addon providers, inlined as path data so the console
 * stays self-contained (no CDN, no network on render) and the glyphs take
 * `currentColor` like every other icon.
 *
 * Sources; the projects' own artwork, used to name the service they link to:
 *   modrinth, curseforge  simple-icons (CC0 icon set)
 *   hangar                HangarMC/Hangar, frontend/app/assets/hangar-icon.svg
 *   smithed               Smithed-MC/smithed, src/images/logo_box.svg (plate dropped)
 *   luna                  our own favicon artwork (the ring dropped, see below)
 */

/** One shape of a mark: its path data and the transform its source placed it under. */
export interface BrandPath {
	d: string;
	transform?: string;
}

/** One monochrome mark: its own coordinate system and the shapes inside it. */
export interface BrandMark {
	viewBox: string;
	/** applied to the whole group; some sources ship flipped coordinates */
	transform?: string;
	/** a bare `d` when the shape needs no placing, otherwise `d` + its transform */
	paths: Array<string | BrandPath>;
}

/**
 * Tint for each addon source, as a token reference so the value lives in
 * `app.scss` with the rest of the palette (the comment there records which are
 * the providers' published primaries and which had to be lifted for contrast).
 * Every screen that names a source reads this, so the word "Modrinth" is the
 * same colour in a table cell, an info grid and a link.
 */
export const SOURCE_COLORS: Record<string, string> = {
	modrinth: 'var(--src-modrinth)',
	curseforge: 'var(--src-curseforge)',
	hangar: 'var(--src-hangar)',
	smithed: 'var(--src-smithed)',
	luna: 'var(--src-luna)',
	manual: 'var(--src-manual)',
};

/** A source's tint, falling back to the surrounding colour for an unknown one. */
export function sourceColor(source: string | null | undefined): string {
	return SOURCE_COLORS[source ?? ''] ?? 'currentColor';
}

/**
 * The two sources that are not providers, named twice: `short` for a table cell,
 * where the column is the width of a word, and `long` for an info grid, which
 * has the room to say what actually happened. Providers keep the one name they
 * publish (`ADDON_PROVIDERS`).
 */
export const SOURCE_LABELS: Record<string, { short: string; long: string }> = {
	luna: { short: 'Luna', long: 'In-house build' },
	manual: { short: 'Manual', long: 'Uploaded by hand' },
};

/**
 * The crescent and its three stars, one path each, kept under the group
 * transforms the artwork ships rather than re-baked into a single coordinate
 * space; the crescent is rotated ~10°, so flattening it by hand is how the moon
 * ends up subtly wrong. Everything is in the artwork's own coordinates, which
 * `LUNA_ARTWORK_ORIGIN` brings back to the 233×233 canvas.
 */
const LUNA_GLYPH: BrandPath[] = [
	{
		d: 'M47.744,0A47.744,47.744,0,1,0,80.81,82.172a4.47,4.47,0,0,0-3.45-7.684c-.914.075-1.828.112-2.76.112A34.32,34.32,0,0,1,59.326,9.549a4.479,4.479,0,0,0-1.007-8.374A48.358,48.358,0,0,0,47.744,0Z',
		transform: 'matrix(0.985, -0.174, 0.174, 0.985, 7728.386, -913.873)'
	},
	{
		d: 'M43.6-277.439c-.514.472-1.227,2.16-3.869,9.154-1.793,4.718-3.334,8.661-3.429,8.755s-4.037,1.646-8.766,3.439c-9.992,3.8-10.286,3.995-9.542,6.26.377,1.122.713,1.279,9.688,4.624,4.572,1.709,8.409,3.167,8.525,3.24s1.688,4.037,3.492,8.818c3.5,9.279,3.523,9.332,4.771,9.667,2.181.587,2.464.136,6.165-9.867,1.688-4.561,3.177-8.388,3.313-8.525s4.058-1.667,8.724-3.418c9.563-3.575,9.646-3.628,9.646-5.41-.01-1.835.608-1.5-9.982-5.515-4.6-1.751-8.4-3.208-8.441-3.25s-1.552-4.005-3.355-8.829c-3.083-8.22-3.324-8.8-3.995-9.248A2.315,2.315,0,0,0,43.6-277.439Z',
		transform: 'translate(7775.869 -643.677)'
	},
	{
		d: 'M31.722-277.705c-.278.255-.663,1.168-2.092,4.948-.969,2.551-1.8,4.682-1.853,4.733s-2.182.89-4.738,1.859c-5.4,2.052-5.56,2.16-5.158,3.384.2.607.385.692,5.237,2.5,2.471.924,4.546,1.712,4.608,1.751s.913,2.182,1.887,4.767c1.893,5.016,1.9,5.045,2.579,5.226,1.179.317,1.332.074,3.333-5.334.913-2.466,1.717-4.534,1.791-4.608s2.194-.9,4.716-1.848c5.169-1.933,5.215-1.961,5.215-2.925-.006-.992.329-.811-5.4-2.981-2.488-.947-4.54-1.734-4.563-1.757s-.839-2.165-1.814-4.772c-1.666-4.444-1.8-4.755-2.16-5A1.251,1.251,0,0,0,31.722-277.705Z',
		transform: 'translate(7808.159 -686.303)'
	},
	{
		d: 'M26.1-277.832a13.56,13.56,0,0,0-1.251,2.959c-.58,1.525-1.078,2.8-1.108,2.831s-1.305.532-2.834,1.112c-3.23,1.227-3.325,1.292-3.085,2.024.122.363.231.414,3.132,1.495,1.478.553,2.719,1.024,2.756,1.047s.546,1.305,1.129,2.851c1.132,3,1.139,3.017,1.542,3.125.705.19.8.044,1.993-3.19.546-1.475,1.027-2.712,1.071-2.756s1.312-.539,2.82-1.105c3.091-1.156,3.119-1.173,3.119-1.749,0-.593.2-.485-3.227-1.783-1.488-.566-2.715-1.037-2.729-1.051s-.5-1.295-1.085-2.854c-1-2.658-1.075-2.844-1.292-2.99A.748.748,0,0,0,26.1-277.832Z',
		transform: 'translate(7821.627 -597.814)'
	},
];

/** What the artwork's coordinates need to land on the 233×233 canvas. */
const LUNA_ARTWORK_ORIGIN = 'translate(-7686 1009)';

/**
 * The ring the artwork draws around the glyph, as a filled annulus: the source
 * draws it as a 12-wide stroke on r=110.5, which path data cannot carry, so it is
 * the two circles r=116.5 and r=104.5 with opposite arc sweeps; the inner one
 * winds the other way and punches the hole under the default nonzero fill rule.
 *
 * Its own transform cancels the group's, so the circle can be written in the
 * canvas coordinates it is actually centred in (116.5, 116.5).
 */
const LUNA_RING: BrandPath = {
	d: 'M116.5,0A116.5,116.5,0,1,1,116.5,233A116.5,116.5,0,1,1,116.5,0ZM116.5,12A104.5,104.5,0,1,0,116.5,221A104.5,104.5,0,1,0,116.5,12Z',
	transform: 'translate(7686 -1009)'
};

/**
 * The mark for a plate that is already a circle (LunaMark, the favicon): the ring
 * would be a second one, a hairline inside the plate's own edge. viewBox is the
 * glyph's measured bounds, squared.
 */
export const LUNA_PLATE_MARK: BrandMark = {
	viewBox: '34.4 44.7 144.5 144.5',
	transform: LUNA_ARTWORK_ORIGIN,
	paths: LUNA_GLYPH
};

export const BRAND_MARKS: Record<string, BrandMark> = {
	// our own mark, ringed as the artwork draws it; the whole 233 canvas, so the
	// ring is the icon's edge wherever a provider mark appears
	luna: {
		viewBox: '0 0 233 233',
		transform: LUNA_ARTWORK_ORIGIN,
		paths: [LUNA_RING, ...LUNA_GLYPH]
	},
	modrinth: {
		viewBox: '0 0 24 24',
		paths: [
			'M12.252.004a11.78 11.768 0 0 0-8.92 3.73 11 10.999 0 0 0-2.17 3.11 11.37 11.359 0 0 0-1.16 5.169c0 1.42.17 2.5.6 3.77.24.759.77 1.899 1.17 2.529a12.3 12.298 0 0 0 8.85 5.639c.44.05 2.54.07 2.76.02.2-.04.22.1-.26-1.7l-.36-1.37-1.01-.06a8.5 8.489 0 0 1-5.18-1.8 5.34 5.34 0 0 1-1.3-1.26c0-.05.34-.28.74-.5a37.572 37.545 0 0 1 2.88-1.629c.03 0 .5.45 1.06.98l1 .97 2.07-.43 2.06-.43 1.47-1.47c.8-.8 1.48-1.5 1.48-1.52 0-.09-.42-1.63-.46-1.7-.04-.06-.2-.03-1.02.18-.53.13-1.2.3-1.45.4l-.48.15-.53.53-.53.53-.93.1-.93.07-.52-.5a2.7 2.7 0 0 1-.96-1.7l-.13-.6.43-.57c.68-.9.68-.9 1.46-1.1.4-.1.65-.2.83-.33.13-.099.65-.579 1.14-1.069l.9-.9-.7-.7-.7-.7-1.95.54c-1.07.3-1.96.53-1.97.53-.03 0-2.23 2.48-2.63 2.97l-.29.35.28 1.03c.16.56.3 1.16.31 1.34l.03.3-.34.23c-.37.23-2.22 1.3-2.84 1.63-.36.2-.37.2-.44.1-.08-.1-.23-.6-.32-1.03-.18-.86-.17-2.75.02-3.73a8.84 8.839 0 0 1 7.9-6.93c.43-.03.77-.08.78-.1.06-.17.5-2.999.47-3.039-.01-.02-.1-.02-.2-.03Zm3.68.67c-.2 0-.3.1-.37.38-.06.23-.46 2.42-.46 2.52 0 .04.1.11.22.16a8.51 8.499 0 0 1 2.99 2 8.38 8.379 0 0 1 2.16 3.449 6.9 6.9 0 0 1 .4 2.8c0 1.07 0 1.27-.1 1.73a9.37 9.369 0 0 1-1.76 3.769c-.32.4-.98 1.06-1.37 1.38-.38.32-1.54 1.1-1.7 1.14-.1.03-.1.06-.07.26.03.18.64 2.56.7 2.78l.06.06a12.07 12.058 0 0 0 7.27-9.4c.13-.77.13-2.58 0-3.4a11.96 11.948 0 0 0-5.73-8.578c-.7-.42-2.05-1.06-2.25-1.06Z',
		]
	},
	curseforge: {
		viewBox: '0 0 24 24',
		paths: [
			'M18.326 9.2145S23.2261 8.4418 24 6.1882h-7.5066V4.4H0l2.0318 2.3576V9.173s5.1267-.2665 7.1098 1.2372c2.7146 2.516-3.053 5.917-3.053 5.917L5.0995 19.6c1.5465-1.4726 4.494-3.3775 9.8983-3.2857-2.0565.65-4.1245 1.6651-5.7344 3.2857h10.9248l-1.0288-3.2726s-7.918-4.6688-.8336-7.1127z',
		]
	},
	hangar: {
		// tightened onto the mark itself: the source box is the full logo canvas,
		// which would render the glyph at half size and off-centre
		viewBox: '51.7 45.6 133.2 133.2',
		paths: [
			'M163.5 103.2c-9.7-3.6-24 10.2-31 31.4a83.9 83.9 0 0 0-3.5 35.9l-4.5-1.9c-8.6-26.7-3.8-55.9 11.1-77Z',
			'm169.8 148.8-33.2-13.7c6.1-18.5 17.4-29.6 24.7-29.6a7.8 7.8 0 0 1 2.2.4l.6.3c2.6 1.2 10.5 8 5.7 42.6M157.9 66.7a73.4 73.4 0 0 0-25.8 23.4c-14.6 21.2-19.6 49.9-12 76.7a82.2 82.2 0 0 0 3.3 9.5l-44.5-18.4c-16.8-41.2-1.4-90.3 34.5-109.7Z',
		]
	},
	smithed: {
		// the blue plate is dropped, so the box art is re-centred on its own bounds
		viewBox: '41.4 45 417 417',
		transform: 'matrix(0.1, 0, 0, -0.1, 0, 512)',
		paths: [
			'M1508 4291 c-323 -163 -590 -299 -593 -303 -8 -8 1946 -988 1969 -988 23 0 1195 604 1193 615 -2 13 -1945 975 -1966 974 -9 -1 -280 -135 -603 -298z',
			'M870 3506 l0 -435 1007 -500 c553 -276 1012 -501 1018 -501 7 0 286 139 621 309 l609 310 3 441 c1 243 -1 440 -6 438 -31 -13 -1199 -613 -1206 -619 -6 -5 -16 -9 -23 -9 -7 0 -463 225 -1013 500 -550 275 -1002 500 -1005 500 -3 0 -5 -196 -5 -434z',
			'M1770 2301 l0 -260 487 -245 c268 -135 493 -246 500 -246 7 0 117 52 243 115 l230 115 0 195 c0 107 -3 195 -6 195 -3 0 -76 -36 -163 -80 -87 -44 -161 -80 -165 -80 -4 0 -257 124 -563 275 -306 151 -558 275 -559 275 -2 0 -4 -117 -4 -259z',
			'M3318 2219 l-38 -19 0 -225 0 -225 -252 -127 c-139 -71 -262 -128 -273 -128 -11 0 -238 110 -505 245 -266 135 -495 249 -507 253 -21 8 -23 15 -25 121 l-3 113 -332 -161 c-183 -88 -333 -162 -333 -165 1 -8 1416 -705 1438 -709 24 -4 1476 718 1466 728 -8 7 -594 321 -598 320 0 -1 -18 -10 -38 -21z',
			'M3246 1499 c-407 -203 -744 -369 -748 -369 -11 0 -189 86 -892 434 -329 163 -600 296 -602 296 -3 0 -3 -124 -2 -276 l3 -275 739 -365 c406 -200 744 -364 751 -364 7 0 348 164 757 364 l743 364 3 281 c1 155 -1 281 -5 280 -5 0 -341 -167 -747 -370z',
		]
	},
};
