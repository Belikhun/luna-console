// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** Shapes and constants for AddonPicker.svelte (a component cannot export types). */

import { api } from '$lib/api';

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

/** The kinds of addon a picker can search for (core's AddonType). */
export type AddonKindType = 'plugin' | 'mod' | 'resourcepack' | 'datapack';

/** An upstream luna can install addons from. */
export interface AddonProvider {
	id: string;
	label: string;
	/** Addon types the provider hosts at all; tabs are filtered by this */
	types: AddonKindType[];
	/** false = the daemon reports it unusable (e.g. curseforge without a key) */
	available: boolean;
	/** why it cannot be used; the tooltip and the empty state say so */
	note?: string;
}

/**
 * The providers, in the order they are offered, before the daemon has said
 * which are actually usable; `providerAvailability` overlays that.
 */
export const ADDON_PROVIDERS: AddonProvider[] = [
	{ id: 'modrinth', label: 'Modrinth', types: ['plugin', 'mod', 'resourcepack', 'datapack'], available: true },
	{ id: 'curseforge', label: 'CurseForge', types: ['plugin', 'mod', 'resourcepack', 'datapack'], available: false },
	{ id: 'hangar', label: 'Hangar', types: ['plugin'], available: true },
	{ id: 'smithed', label: 'Smithed', types: ['datapack'], available: true }
];

/** One fetch per page load: every picker shares the daemon's provider status. */
let availability: Promise<AddonProvider[]> | undefined;

/**
 * The provider list with live availability from `/api/providers` folded in.
 * Falls back to the static list (modrinth only) when the daemon is unreachable.
 */
export function providerAvailability(): Promise<AddonProvider[]> {
	availability ??= api('/providers')
		.then((res) => {
			const live = new Map<string, { available: boolean; reason?: string }>(
				(res.providers ?? []).map((entry: { id: string; available: boolean; reason?: string }) => [
					entry.id,
					entry
				])
			);

			return ADDON_PROVIDERS.map((provider) => {
				const status = live.get(provider.id);

				return {
					...provider,
					available: status?.available ?? provider.available,
					note: status?.reason
				};
			});
		})
		.catch(() => ADDON_PROVIDERS);

	return availability;
}
