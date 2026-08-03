/**
 * Types and per-kind wording for `AddonCatalog.svelte`.
 *
 * Plugins and mods are one model — a lockfile entry whose family decides which
 * directory it deploys into — so the catalog screen is one component rendered
 * twice. Everything that genuinely differs between the two lives in this table.
 */

export type AddonKind = 'plugins' | 'mods';

export type AddonFamily = 'paper' | 'velocity' | 'universal' | 'neoforge';

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

export interface CatalogKind {
	/** Screen title, and the noun in "<X> details" */
	label: string;
	/** Singular, lowercase — row labels and dialog titles */
	noun: string;
	/** Plural, lowercase — sentences */
	plural: string;
	/** Families a build of this kind can have; a single one hides the picker */
	families: AddonFamily[];
	/** Target wildcards offered alongside the instance names */
	wildcards: string[];
	/** The provider project type this kind installs (search + URLs) */
	type: 'plugin' | 'mod';
	/** Provider sources the filter offers, beside luna/manual */
	sources: string[];
	emptyText: string;
}

export const CATALOG_KINDS: Record<AddonKind, CatalogKind> = {
	plugins: {
		label: 'Plugins',
		noun: 'plugin',
		plural: 'plugins',
		families: ['paper', 'velocity', 'universal'],
		wildcards: ['*paper', '*velocity'],
		type: 'plugin',
		sources: ['modrinth', 'curseforge', 'hangar'],
		emptyText: 'Install one from a provider, or run a scan to adopt the jars already on disk.'
	},
	mods: {
		label: 'Mods',
		noun: 'mod',
		plural: 'mods',
		families: ['neoforge'],
		wildcards: ['*neoforge'],
		type: 'mod',
		sources: ['modrinth', 'curseforge'],
		emptyText:
			'Install one from a provider, or upload a jar. A mod loader instance keeps its own mods — ' +
			'only the ones luna pooled appear here.'
	}
};
