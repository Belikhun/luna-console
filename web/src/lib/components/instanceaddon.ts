// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Shapes and per-kind wording for `InstanceAddonAdd.svelte` (a component cannot
 * export types).
 *
 * The three *sources* an addon can come from behave the same for every kind; the
 * two *kinds* differ in their pool, their route and whether a build declares a
 * platform. Everything that genuinely differs lives in this table, as
 * `CATALOG_KINDS` does for the catalog screens.
 */

import type { AddonKindType } from './addons';

/** Where the addon is coming from. */
export type AddonSource = 'pool' | 'provider' | 'upload';

/** What an instance tab can be handed. */
export type InstanceAddonKind = 'plugin' | 'mod' | 'datapack';

export interface InstanceAddonSpec {
	/** i18n key for the noun in the dialog's title */
	noun: string;
	/** the picker's addon type, which decides which provider tabs appear */
	pickerKind: AddonKindType;
	/** provider search endpoint */
	search: string;
	/** file picker filter for the upload source */
	accept: string;
	/** whether a build declares a platform family (jars do, pack zips do not) */
	family: boolean;
	/**
	 * Whether a duplicate of the same addon under another name is a hazard here.
	 *
	 * It is for jars: a server that finds two copies loads the plugin twice. A
	 * data pack is a zip in a world folder keyed by its file name, and luna has no
	 * descriptor to recognise two spellings of one pack by, so there is nothing
	 * honest to offer and the block is left out rather than guessed at.
	 */
	supersedes: boolean;
	/**
	 * Whether the operator may pick the exact build instead of the newest
	 * compatible one. Jars can, because a per-instance choice lands as a pin the
	 * pool's variant machinery carries; a data pack is one zip for every target,
	 * so there is no per-instance version to offer.
	 */
	pickVersion: boolean;
}

export const INSTANCE_ADDON_KINDS: Record<InstanceAddonKind, InstanceAddonSpec> = {
	plugin: {
		noun: 'web.catalogKinds.plugin',
		pickerKind: 'plugin',
		search: '/plugins/search',
		accept: '.jar',
		family: true,
		supersedes: true,
		pickVersion: true
	},
	mod: {
		noun: 'web.catalogKinds.mod',
		pickerKind: 'mod',
		search: '/plugins/search',
		accept: '.jar',
		family: true,
		supersedes: true,
		pickVersion: true
	},
	datapack: {
		noun: 'web.catalogKinds.datapack',
		pickerKind: 'datapack',
		search: '/datapacks/search',
		accept: '.zip',
		family: false,
		supersedes: false,
		pickVersion: false
	}
};

/** One provider build as the manual version picker lists it. */
export interface VersionChoice {
	/** The provider's version id; the unique handle, since a project is free to
	 *  publish one build per MC version all under the same version number */
	id: string;
	versionNumber: string;
	channel: string;
	gameVersions: string[];
	date: string;
	/** null when the instance carries no MC constraint to judge by */
	compatible: boolean | null;
}

/** One pooled addon offered as a source, as the dialog lists it. */
export interface PoolChoice {
	plugin: string;
	displayName: string;
	description: string | null;
	/** families pooled for it, for the "paper, velocity" hint */
	families: string[];
	/** instances it already reaches, so the ones already here can be filtered out */
	effective: string[];
}

/**
 * A pool name suggested from the file the operator picked.
 *
 * Drop the extension, then everything from the first `@` or `_`, then the
 * platform and version suffixes a published jar carries.
 * `LuckPerms-Bukkit-5.5.71.jar` is a name nobody wants as a pool key, and
 * `luckperms` is what they would have typed.
 */
export function suggestName(fileName: string): string {
	return fileName
		.replace(/\.(jar|zip)$/i, '')
		.replace(/[@_].*$/, '')
		.replace(/-(bukkit|paper|spigot|velocity|fabric|forge|neoforge|universal)\b.*$/i, '')
		.replace(/-v?\d[\d.]*$/, '')
		.toLowerCase();
}
