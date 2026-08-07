// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Types and per-kind wording for `AddonCatalog.svelte`.
 *
 * Plugins and mods are one model; a lockfile entry whose family decides which
 * directory it deploys into; so the catalog screen is one component rendered
 * twice. Everything that genuinely differs between the two lives in this table.
 */

import type { AddonDir, PluginFamily } from '$core/types';
import { SOFTWARE_IDS, traitsOf } from '$core/software';

export type AddonKind = 'plugins' | 'mods';

export type AddonFamily = PluginFamily;

export interface FamilyRow {
	key: string;
	family: string;
	source: string;
	autoUpdate: boolean;
	channel: string;
	version: string | null;
	remote: { provider: string; projectId: string; slug: string } | null;
	/** Provider web page, built server-side (the URL scheme is per provider) */
	url: string | null;
	effective: string[];
}

/** One addon identity, with every family build of it nested. */
export interface AddonRow {
	plugin: string;
	displayName: string;
	description: string | null;
	families: FamilyRow[];
	sources: string[];
	effective: string[];
	autoUpdate: boolean;
	pinned: boolean;
	variantCount: number;
}

/** One version group an update check found waiting for a lock entry. */
export interface AddonUpdateGroup {
	version: string;
	/** The pool's newest build; anything else is a per-instance variant */
	isPrimary: boolean;
	targets: string[];
	/** What those targets run today, joined when they disagree */
	current: string;
}

/** A build the provider has something newer for, or something to say about. */
export interface AddonUpdate {
	/** Lock entry key, e.g. "luckperms@paper"; what an update call names */
	name: string;
	/** Addon identity the build belongs to */
	plugin: string;
	family: AddonFamily;
	provider: string;
	installed: string | null;
	groups: AddonUpdateGroup[];
	holdbacks: Array<{ targets: string[]; current?: string; reason: string }>;
	pinned: Array<{ target: string; version: string }>;
}

export interface CatalogKind {
	/** Screen title, and the noun in "<X> details" */
	label: string;
	/** Singular, lowercase; row labels and dialog titles */
	/** i18n key of the singular noun */
	noun: string;
	/** Plural, lowercase; sentences */
	/** i18n key of the plural noun */
	plural: string;
	/** Families a build of this kind can have; a single one hides the picker */
	families: AddonFamily[];
	/** Target wildcards offered alongside the instance names */
	wildcards: string[];
	/** The provider project type this kind installs (search + URLs) */
	type: 'plugin' | 'mod';
	/** Provider sources the filter offers, beside luna/manual */
	sources: string[];
	/** i18n key of the empty-table text */
	emptyText: string;
}

/**
 * The `*<software>` selectors a kind can be targeted at: every software that
 * deploys addons into that kind's directory. Derived, because a hybrid runs
 * both ecosystems and belongs under both screens, and a hand-written list is
 * exactly where that gets forgotten.
 */
function wildcardsFor(dir: AddonDir): string[] {
	return SOFTWARE_IDS.filter((software) => traitsOf(software).addonDirs.includes(dir)).map(
		(software) => `*${software}`
	);
}

export const CATALOG_KINDS: Record<AddonKind, CatalogKind> = {
	plugins: {
		label: 'web.nav.plugins',
		noun: 'web.catalogKinds.plugin',
		plural: 'web.catalogKinds.plugins',
		families: ['paper', 'velocity', 'universal'],
		wildcards: wildcardsFor('plugins'),
		type: 'plugin',
		sources: ['modrinth', 'curseforge', 'hangar'],
		emptyText: 'web.catalogKinds.pluginsEmpty'
	},
	mods: {
		label: 'web.nav.mods',
		noun: 'web.catalogKinds.mod',
		plural: 'web.catalogKinds.mods',
		families: ['neoforge', 'fabric', 'forge'],
		wildcards: wildcardsFor('mods'),
		type: 'mod',
		sources: ['modrinth', 'curseforge'],
		emptyText: 'web.catalogKinds.modsEmpty'
	}
};
