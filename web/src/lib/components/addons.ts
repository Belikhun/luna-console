/** Shapes and constants for AddonPicker.svelte (a component cannot export types). */

/** One search hit from an addon provider, in the shape the console renders. */
export interface AddonHit {
	project_id: string;
	slug: string;
	title: string;
	description: string;
	downloads: number;
	author?: string;
	icon_url?: string;
	categories?: string[];
	versions?: string[];
}

/** An upstream luna can install addons from. */
export interface AddonProvider {
	id: string;
	label: string;
	/** false = listed so the roadmap is visible, but nothing to search yet */
	available: boolean;
	/** why it cannot be used yet — the tooltip and the empty state say so */
	note?: string;
}

/**
 * The providers, in the order they are offered. Only Modrinth is wired up; the
 * others are listed deliberately — they are the ones luna intends to support,
 * and a greyed tab says that better than their absence does.
 */
export const ADDON_PROVIDERS: AddonProvider[] = [
	{ id: 'modrinth', label: 'Modrinth', available: true },
	{ id: 'curseforge', label: 'CurseForge', available: false, note: 'not connected yet' },
	{ id: 'hangar', label: 'Hangar', available: false, note: 'not connected yet' },
	{ id: 'smithed', label: 'Smithed', available: false, note: 'not connected yet' }
];
