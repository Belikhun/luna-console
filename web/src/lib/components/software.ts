// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * How a server software is drawn: its own mark, its accent, and the channel a
 * build came from. The counterpart of `brands.ts`, which does the same job for
 * the addon providers, and it exists for the same reason - "Paper" should read
 * as Paper in a table cell, an info grid and a page header alike, rather than
 * as whatever string the registry happened to store.
 *
 * # Where the artwork comes from
 *
 * Modrinth's loader tags (`/v2/tag/loader`), inlined here rather than fetched,
 * so the console stays self-contained: no CDN, no network on render.
 *
 * Modrinth rather than each project's own logo, which was the first attempt and
 * the wrong one. Those are a *set*: one 24x24 grid, one line weight, all drawn
 * in `currentColor`, made to sit in a row of filter chips - which is exactly
 * how they sit here. Assembled from each vendor's own artwork instead, a table
 * column mixes a solid glyph, a wordmark and a stroked cube at four different
 * optical weights, and reads as a ransom note. Modrinth is also a source luna
 * already trusts: it is one of the addon providers behind `services/providers`.
 *
 * The markup is kept verbatim rather than decomposed into path data, because
 * several of these carry `<defs>`/`<use>` and their own stroke settings; taking
 * them apart is how a mark ends up subtly wrong. It is rendered with `{@html}`,
 * which is safe here for the reason the console's log colouriser is: this is a
 * frozen constant compiled into the bundle, not anything a request can reach.
 *
 * Pumpkin and the mohist family are absent because Modrinth has no loader tag
 * for them; they fall back to a glyph naming what the software *is*. Pumpkin
 * does publish an icon, but as a 1.1 MB embedded raster.
 *
 * One quirk carried over deliberately: purpur's mark defines a face once and
 * repeats it with `<use>`, so two purpur rows put the same element id in the
 * document twice. Every copy is identical, so each `<use>` resolves to the same
 * shape whichever one it picks, and the icon draws correctly either way.
 */

import type { Software } from '$core/types';

/** One mark, as Modrinth publishes it: its canvas, its drawing settings, its shapes. */
export interface SoftwareMark {
	viewBox: string;
	/** presentation attributes the source set on its own root element */
	attrs: Record<string, string>;
	/** the source's inner markup, verbatim */
	markup: string;
}

/** Marks for the softwares Modrinth publishes a loader icon for. */
export const SOFTWARE_MARKS: Partial<Record<Software, SoftwareMark>> = {
	paper: {
		viewBox: '0 0 24 24',
		attrs: { 'fill-rule': 'evenodd', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-miterlimit': '1.5', 'clip-rule': 'evenodd' },
		markup: '<path fill="none" d="M0 0h24v24H0z"/> <path fill="none" stroke="currentColor" stroke-width="2" d="m12 18 6 2 3-17L2 14l6 2"/> <path stroke="currentColor" stroke-width="2" d="m9 21-1-5 4 2-3 3Z"/> <path fill="currentColor" d="m12 18-4-2 10-9-6 11Z"/>'
	},
	folia: {
		viewBox: '0 0 24 24',
		attrs: { 'fill': 'none', 'stroke': 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
		markup: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"></path><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"></path>'
	},
	velocity: {
		viewBox: '0 0 500 500',
		attrs: { 'fill': 'currentColor' },
		markup: '<path d="M236.25 232.55l-54.08-73.79a11.86 11.86 0 00-11.91-4.62L84 171.57a11.88 11.88 0 00-8 5.88l-42.64 77.07a11.84 11.84 0 00.81 12.75l54.21 74a11.86 11.86 0 0011.91 4.62l86-17.37a11.85 11.85 0 008-5.89l42.78-77.3a11.86 11.86 0 00-.82-12.78zm-59.45 74.21a9.57 9.57 0 01-13.39-2.06l-31-42.24a16 16 0 00-16-6.21l-52.58 10.63a9.58 9.58 0 01-11.29-7.49A9.58 9.58 0 0160 248.1l57-11.52a16 16 0 0010.81-7.92L156.42 177a9.58 9.58 0 0113-3.75 9.58 9.58 0 013.75 13L146.81 234a16 16 0 001.09 17.16l31 42.23a9.58 9.58 0 01-2.1 13.37z"/><circle cx="416.44" cy="236.11" r="9.83"/><path d="M458.29 265.6H280.52a9.83 9.83 0 110-19.66h106.22a9.84 9.84 0 000-19.67h-70.2a9.83 9.83 0 110-19.66H422.9a9.84 9.84 0 000-19.67H202.83l33.42 45.61a11.86 11.86 0 01.81 12.75l-42.78 77.3a11.75 11.75 0 01-1.4 2h212.29a9.83 9.83 0 100-19.66h-53.53a9.84 9.84 0 110-19.67h106.65a9.84 9.84 0 100-19.67z"/>'
	},
	purpur: {
		viewBox: '0 0 24 24',
		attrs: { 'fill-rule': 'evenodd', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-miterlimit': '1.5', 'clip-rule': 'evenodd' },
		markup: '<defs> <path id="purpur" fill="none" stroke="currentColor" stroke-width="1.68" d="m264 41.95 8-4v8l-8 4v-8Z"></path> </defs> <path fill="none" d="M0 0h24v24H0z"></path> <path fill="none" stroke="currentColor" stroke-width="1.77" d="m264 29.95-8 4 8 4.42 8-4.42-8-4Z" transform="matrix(1.125 0 0 1.1372 -285 -31.69)"></path> <path fill="none" stroke="currentColor" stroke-width="1.77" d="m272 38.37-8 4.42-8-4.42" transform="matrix(1.125 0 0 1.1372 -285 -31.69)"></path> <path fill="none" stroke="currentColor" stroke-width="1.77" d="m260 31.95 8 4.21V45" transform="matrix(1.125 0 0 1.1372 -285 -31.69)"></path> <path fill="none" stroke="currentColor" stroke-width="1.77" d="M260 45v-8.84l8-4.21" transform="matrix(1.125 0 0 1.1372 -285 -31.69)"></path> <use href="#purpur" stroke-width="1.68" transform="matrix(1.125 0 0 1.2569 -285 -40.78)"></use> <use href="#purpur" stroke-width="1.68" transform="matrix(-1.125 0 0 1.2569 309 -40.78)"></use>'
	},
	fabric: {
		viewBox: '0 0 24 24',
		attrs: { 'fill-rule': 'evenodd', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'clip-rule': 'evenodd' },
		markup: '<path fill="none" d="M0 0h24v24H0z"/> <path fill="none" stroke="currentColor" stroke-width="23" d="m820 761-85.6-87.6c-4.6-4.7-10.4-9.6-25.9 1-19.9 13.6-8.4 21.9-5.2 25.4 8.2 9 84.1 89 97.2 104 2.5 2.8-20.3-22.5-6.5-39.7 5.4-7 18-12 26-3 6.5 7.3 10.7 18-3.4 29.7-24.7 20.4-102 82.4-127 103-12.5 10.3-28.5 2.3-35.8-6-7.5-8.9-30.6-34.6-51.3-58.2-5.5-6.3-4.1-19.6 2.3-25 35-30.3 91.9-73.8 111.9-90.8" transform="matrix(.08671 0 0 .0867 -49.8 -56)"/>'
	},
	forge: {
		viewBox: '0 0 24 24',
		attrs: { 'fill-rule': 'evenodd', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-miterlimit': '1.5', 'clip-rule': 'evenodd' },
		markup: '<path fill="none" d="M0 0h24v24H0z"></path> <path fill="none" stroke="currentColor" stroke-width="2" d="M2 7.5h8v-2h12v2s-7 3.4-7 6 3.1 3.1 3.1 3.1l.9 3.9H5l1-4.1s3.8.1 4-2.9c.2-2.7-6.5-.7-8-6Z"></path>'
	},
	neoforge: {
		viewBox: '0 0 24 24',
		attrs: {},
		markup: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="m12 19.2v2m0-2v2"/><path d="m8.4 1.3c0.5 1.5 0.7 3 0.1 4.6-0.2 0.5-0.9 1.5-1.6 1.5m8.7-6.1c-0.5 1.5-0.7 3-0.1 4.6 0.2 0.6 0.9 1.5 1.6 1.5"/><path d="m3.6 15.8h-1.7m18.5 0h1.7"/><path d="m3.2 12.1h-1.7m19.3 0h1.8"/><path d="m8.1 12.7v1.6m7.8-1.6v1.6"/><path d="m10.8 18h1.2m0 1.2-1.2-1.2m2.4 0h-1.2m0 1.2 1.2-1.2"/><path d="m4 9.7c-0.5 1.2-0.8 2.4-0.8 3.7 0 3.1 2.9 6.3 5.3 8.2 0.9 0.7 2.2 1.1 3.4 1.1m0.1-17.8c-1.1 0-2.1 0.2-3.2 0.7m11.2 4.1c0.5 1.2 0.8 2.4 0.8 3.7 0 3.1-2.9 6.3-5.3 8.2-0.9 0.7-2.2 1.1-3.4 1.1m-0.1-17.8c1.1 0 2.1 0.2 3.2 0.7"/><path d="m4 9.7c-0.2-1.8-0.3-3.7 0.5-5.5s2.2-2.6 3.9-3m11.6 8.5c0.2-1.9 0.3-3.7-0.5-5.5s-2.2-2.6-3.9-3"/><path d="m12 21.2-2.4 0.4m2.4-0.4 2.4 0.4"/></g>'
	}
};

/**
 * Tint per software, as a token reference so the value lives in `app.scss` with
 * the rest of the palette (the comment there records which are the projects'
 * published primaries and which had to be lifted to read on these panels).
 */
export const SOFTWARE_COLORS: Partial<Record<Software, string>> = {
	paper: 'var(--sw-paper)',
	folia: 'var(--sw-folia)',
	velocity: 'var(--sw-velocity)',
	purpur: 'var(--sw-purpur)',
	fabric: 'var(--sw-fabric)',
	forge: 'var(--sw-forge)',
	neoforge: 'var(--sw-neoforge)',
	pumpkin: 'var(--sw-pumpkin)',
	youer: 'var(--sw-mohist)',
	asyncyouer: 'var(--sw-mohist)'
};

/** A software's tint, falling back to the surrounding colour for an unknown one. */
export function softwareColor(software: string | null | undefined): string {
	return SOFTWARE_COLORS[software as Software] ?? 'currentColor';
}

/**
 * Fallback glyph for a software with no published icon artwork.
 *
 * Picked from what the software *is* rather than from its branding: a proxy
 * routes, a mod loader loads, a native server is a binary. That way the icon
 * still says something true when the mark is missing, and a project that later
 * publishes a mark simply stops using it.
 */
export const SOFTWARE_ICONS: Record<string, string> = {
	fabric: 'puzzle',
	// the forges share a glyph because they are one ecosystem; their accents are
	// what tells them apart. `anvil` would have been the obvious pick and Font
	// Awesome does not have one.
	forge: 'hammer',
	neoforge: 'hammer',
	pumpkin: 'pumpkin',
	// a hybrid stacks a plugin platform on a mod loader, which is what the mohist
	// family is and what the glyph says
	youer: 'layerGroup',
	asyncyouer: 'layerGroup'
};

/** The glyph to draw when `SOFTWARE_MARKS` has nothing for this software. */
export function softwareIcon(software: string | null | undefined): string {
	return SOFTWARE_ICONS[software ?? ''] ?? 'server';
}

/**
 * How finished a build claims to be.
 *
 * Not every upstream uses the same words - paper says stable/beta/alpha,
 * mojang says release/snapshot, pumpkin publishes nothing but nightlies - so
 * these are luna's own names for the idea, and a caller maps its provider's
 * vocabulary onto them. `release` is deliberately absent from the badge: an
 * ordinary build is the default and saying so on every row is noise.
 */
export type ReleaseChannel = 'release' | 'snapshot' | 'prerelease' | 'nightly' | 'experimental';

/** Every channel a badge can draw, in increasing order of "do not run this". */
export const RELEASE_CHANNELS: ReleaseChannel[] = [
	'release',
	'snapshot',
	'prerelease',
	'nightly',
	'experimental'
];

/** Tint per channel, as tokens for the same reason the software tints are. */
export const CHANNEL_COLORS: Record<ReleaseChannel, string> = {
	release: 'var(--chan-release)',
	snapshot: 'var(--chan-snapshot)',
	prerelease: 'var(--chan-prerelease)',
	nightly: 'var(--chan-nightly)',
	experimental: 'var(--chan-experimental)'
};

/** i18n key per channel; the label a badge shows. */
export const CHANNEL_LABELS: Record<ReleaseChannel, string> = {
	release: 'web.software.channelRelease',
	snapshot: 'web.software.channelSnapshot',
	prerelease: 'web.software.channelPrerelease',
	nightly: 'web.software.channelNightly',
	experimental: 'web.software.channelExperimental'
};

/**
 * What channel a version string reads as, when nobody said.
 *
 * A convenience for the common case, not a replacement for a channel the
 * provider actually stated: pass one explicitly wherever the build carries it.
 * `undefined` means "an ordinary release", which is what the badge omits.
 */
export function channelOf(version: string | null | undefined): ReleaseChannel | undefined {
	const value = (version ?? '').trim().toLowerCase();

	if (!value) {
		return undefined;
	}

	if (value === 'nightly' || value.endsWith('-nightly')) {
		return 'nightly';
	}

	// mojang's snapshots are `24w14a`; a pre-release or release candidate says so
	if (/^\d{2}w\d{2}[a-z]$/.test(value)) {
		return 'snapshot';
	}

	if (value.includes('-pre') || value.includes('-rc')) {
		return 'prerelease';
	}

	if (value.includes('snapshot')) {
		return 'snapshot';
	}

	return undefined;
}
