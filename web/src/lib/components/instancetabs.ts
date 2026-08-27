// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The instance screen's tabs, as addressable paths.
 *
 * A tab used to be client state with a `?tab=` deep link bolted on, which meant
 * it had no URL of its own: it could not be linked to, opened in a new tab, or
 * named in the breadcrumb - the crumb for `/instances/<name>/plugins` pointed at
 * a path that did not exist. Each tab is now a path segment
 * (`/instances/<name>/plugins`), and this is the list both ends read: the screen
 * builds its tab bar from it, and the layout's breadcrumb labels the segment from
 * it rather than guessing at a title from the slug.
 */

/** Every tab id, which is also its path segment. */
export const INSTANCE_TABS = [
	'details',
	'checks',
	'monitoring',
	'plugins',
	'world',
	'datapacks',
	'respacks',
	'access',
	'network',
	'environment',
	'logs',
	'config',
] as const;

export type InstanceTab = (typeof INSTANCE_TABS)[number];

/** The tab a bare `/instances/<name>` shows, and the fallback for an unknown one. */
export const DEFAULT_INSTANCE_TAB: InstanceTab = 'details';

/**
 * Language keys for each tab's name.
 *
 * `plugins` is the one whose name depends on the instance: "Plugins" on Paper,
 * "Mods" on a mod loader, "Plugins & Mods" on a hybrid. Nothing outside the
 * screen knows the software, so the screen lends the breadcrumb the right word
 * through `$lib/crumbs.svelte` and this stands in until it does.
 *
 * It is deliberately *not* an umbrella term: "addons" means plugins, mods **and**
 * data packs here, so captioning the plugin tab with it names the wrong set.
 */
export const INSTANCE_TAB_LABELS: Record<InstanceTab, string> = {
	details: 'web.instanceDetail.details',
	checks: 'web.instanceDetail.statusAndAlarms',
	monitoring: 'web.instanceDetail.monitoring',
	plugins: 'web.instanceDetail.addonsPlugins',
	world: 'web.instanceDetail.worldAndBackup',
	datapacks: 'web.instanceDetail.dataPacks',
	respacks: 'web.instanceDetail.resourcePacks',
	access: 'web.instanceDetail.playersAccess',
	network: 'web.instanceDetail.networking',
	environment: 'web.instanceDetail.environment',
	logs: 'web.instanceDetail.logs',
	config: 'web.instanceDetail.configuration',
};

/** Whether a path segment names a tab. */
export function isInstanceTab(value: string | undefined): value is InstanceTab {
	return value !== undefined && (INSTANCE_TABS as readonly string[]).includes(value);
}

/** The path of one tab on one instance; the default tab is the bare instance path. */
export function instanceTabPath(instance: string, tab: InstanceTab | string): string {
	const base = `/instances/${encodeURIComponent(instance)}`;

	return tab === DEFAULT_INSTANCE_TAB ? base : `${base}/${tab}`;
}
