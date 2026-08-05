// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Client-side shapes for the provider-mapping dialog (a component cannot export
 * types), plus the per-kind endpoints that are the only thing separating a
 * plugin mapping from a pack one.
 */

import type { AddonKindType } from './addons';

/** Addon kinds a mapping can be made for. */
export type IdentifyKind = 'plugin' | 'mod' | 'respack' | 'datapack';

/** One published version, as the probe reports it. */
export interface IdentityMatchView {
	versionId: string;
	versionNumber: string;
	channel: 'release' | 'beta' | 'alpha';
	publishedAt: string;
	gameVersions?: string[];
	fileName: string;
	sizeBytes: number;
	basis: 'sha512' | 'sha256' | 'sha1' | 'filename' | 'size';
	exact: boolean;
}

/** What the daemon proved about a local file at one project. */
export interface IdentityProbeView {
	provider: string;
	project: { title: string; slug: string };
	local: { file: string; sizeBytes: number };
	confidence: 'exact' | 'likely' | 'unknown';
	best?: IdentityMatchView;
	matches: IdentityMatchView[];
	newest?: IdentityMatchView;
	versions: IdentityMatchView[];
}

/** Where a kind's search and mapping live, and what to call things. */
export interface IdentifySpec {
	/** Provider-search route the picker queries */
	search: string;
	/** Kind the picker filters provider tabs by */
	pickerKind: AddonKindType;
	placeholder: string;
	/** The mapping route for one target: probe (GET), map (POST), unmap (DELETE) */
	endpoint: (target: string) => string;
}

export const IDENTIFY_KINDS: Record<IdentifyKind, IdentifySpec> = {
	plugin: {
		search: '/plugins/search',
		pickerKind: 'plugin',
		placeholder: 'Search plugins by name…',
		endpoint: (target) => `/plugins/${encodeURIComponent(target)}/identify`
	},
	mod: {
		search: '/plugins/search',
		pickerKind: 'mod',
		placeholder: 'Search mods by name…',
		endpoint: (target) => `/plugins/${encodeURIComponent(target)}/identify`
	},
	respack: {
		search: '/respacks/search',
		pickerKind: 'resourcepack',
		placeholder: 'Search resource packs by name…',
		endpoint: (target) => `/respacks/${encodeURIComponent(target)}/identify`
	},
	datapack: {
		search: '/datapacks/search',
		pickerKind: 'datapack',
		placeholder: 'Search data packs by name…',
		endpoint: (target) => `/datapacks/${encodeURIComponent(target)}/identify`
	}
};
