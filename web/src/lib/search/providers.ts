// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The global search index (DESIGN.md §5.3).
 *
 * One provider per kind of object in the cluster. Adding a new kind of object
 * to luna means adding a provider here; `GlobalSearch.svelte` never grows
 * another branch, and nothing in the system stays unfindable because someone
 * forgot to teach the search box about it.
 *
 * Providers are loaded lazily on first focus, in parallel, and cached. A
 * provider that throws contributes nothing rather than emptying the box.
 */

import { t } from '$lib/i18n.svelte';

export interface SearchHit {
	group: string;
	label: string;
	/** the second line; what distinguishes this hit from a similar one */
	detail: string;
	href: string;
	icon: string;
}

export interface SearchProvider {
	/** heading the hits appear under, and the registry's display order */
	group: string;
	icon: string;
	load: () => Promise<SearchHit[]>;
}

/** GET a console API route, returning undefined instead of throwing. */
async function fetchJson<T>(path: string): Promise<T | undefined> {
	try {
		const response = await fetch(path);

		if (!response.ok) {
			return undefined;
		}

		return (await response.json()) as T;
	} catch {
		return undefined;
	}
}

/**
 * The console's own screens. Everything with a route belongs here, so the box
 * is a navigator as well as an object index.
 */
const pages = (): SearchHit[] => [
	{ group: 'web.searchGroups.pages', label: t('web.nav.instancesList'), detail: t('web.searchPages.instances'), href: '/instances', icon: 'server' },
	{
		group: 'web.searchGroups.pages',
		label: t('web.nav.serverSelector'),
		detail: t('web.searchPages.selector'),
		href: '/instances/selector',
		icon: 'grid'
	},
	{
		group: 'web.searchGroups.pages',
		label: t('web.nav.launchInstance'),
		detail: t('web.searchPages.launch'),
		href: '/instances/launch',
		icon: 'rocket'
	},
	{ group: 'web.searchGroups.pages', label: t('web.nav.playersList'), detail: t('web.searchPages.players'), href: '/players', icon: 'users' },
	{
		group: 'web.searchGroups.pages',
		label: t('web.nav.onlinePlayers'),
		detail: t('web.searchPages.online'),
		href: '/players/online',
		icon: 'userPortrait'
	},
	{
		group: 'web.searchGroups.pages',
		label: t('web.nav.permissionGroups'),
		detail: t('web.searchPages.permissions'),
		href: '/permissions',
		icon: 'key'
	},
	{ group: 'web.searchGroups.pages', label: t('web.nav.plugins'), detail: t('web.searchPages.plugins'), href: '/plugins', icon: 'plug' },
	{ group: 'web.searchGroups.pages', label: t('web.nav.mods'), detail: t('web.searchPages.mods'), href: '/mods', icon: 'puzzle' },
	{
		group: 'web.searchGroups.pages',
		label: t('web.nav.addonGroups'),
		detail: t('web.searchPages.addonGroups'),
		href: '/addons/groups',
		icon: 'layerGroup'
	},
	{
		group: 'web.searchGroups.pages',
		label: t('web.nav.resourcePacks'),
		detail: t('web.searchPages.resourcePacks'),
		href: '/packs',
		icon: 'image'
	},
	{
		group: 'web.searchGroups.pages',
		label: t('web.nav.dataPacks'),
		detail: t('web.searchPages.dataPacks'),
		href: '/datapacks',
		icon: 'box'
	},
	{
		group: 'web.searchGroups.pages',
		label: t('web.nav.javaRuntimes'),
		detail: t('web.searchPages.javaRuntimes'),
		href: '/runtime/java',
		icon: 'microchip'
	},
	{
		group: 'web.searchGroups.pages',
		label: t('web.nav.javaProfiles'),
		detail: t('web.searchPages.javaProfiles'),
		href: '/runtime/profiles',
		icon: 'sliders'
	},
	{ group: 'web.searchGroups.pages', label: t('web.nav.ports'), detail: t('web.searchPages.ports'), href: '/network', icon: 'sitemap' },
	{ group: 'web.searchGroups.pages', label: t('web.nav.proxyRouting'), detail: t('web.searchPages.proxy'), href: '/proxy', icon: 'route' },
	{ group: 'web.searchGroups.pages', label: t('web.nav.schedules'), detail: t('web.searchPages.schedules'), href: '/schedules', icon: 'clock' },
	{
		group: 'web.searchGroups.pages',
		label: t('web.nav.environment'),
		detail: t('web.searchPages.environment'),
		href: '/environment',
		icon: 'key'
	},
	{ group: 'web.searchGroups.pages', label: t('web.nav.cleanup'), detail: t('web.searchPages.cleanup'), href: '/cleanup', icon: 'broom' },
	{
		group: 'web.searchGroups.pages',
		label: t('web.nav.machines'),
		detail: t('web.searchPages.machines'),
		href: '/machines',
		icon: 'hardDrive'
	},
	{
		group: 'web.searchGroups.pages',
		label: t('web.nav.accounts'),
		detail: t('web.searchPages.accounts'),
		href: '/console/accounts',
		icon: 'userShield'
	},
	{
		group: 'web.searchGroups.pages',
		label: t('web.nav.consoleLogs'),
		detail: t('web.searchPages.consoleLogs'),
		href: '/console/logs',
		icon: 'fileLines'
	}
];

/**
 * A screen without per-object routes still answers a search: the hit lands on
 * the screen with the term pre-filled into its table (see ResourceTable's
 * `initialSearch`).
 */
function screenHref(path: string, term: string): string {
	return `${path}?q=${encodeURIComponent(term)}`;
}

/**
 * One kind's addons as search hits. Both kinds come from the same endpoint -
 * the lockfile does not separate them; so the kind filter is what makes the
 * two providers answer with different things.
 */
async function addonHits(
	kind: 'plugins' | 'mods',
	group: string,
	icon: string
): Promise<SearchHit[]> {
	const body = await fetchJson<{ plugins?: any[] }>(`/api/plugins?kind=${kind}`);

	return (body?.plugins ?? []).map((addon) => ({
		group,
		label: String(addon.plugin),
		detail: [
			addon.displayName && addon.displayName !== addon.plugin ? addon.displayName : '',
			addon.sources?.join(', ') ?? '',
			addon.families?.map((family: any) => family.family).join(', ') ?? ''
		]
			.filter(Boolean)
			.join(' · '),
		href: `/plugins/${encodeURIComponent(addon.plugin)}`,
		icon
	}));
}

export const SEARCH_PROVIDERS: SearchProvider[] = [
	{
		group: 'web.searchGroups.pages',
		icon: 'file',
		load: async () => pages()
	},

	{
		group: 'web.searchGroups.instances',
		icon: 'server',
		load: async () => {
			const body = await fetchJson<{ instances?: any[]; externals?: any[] }>('/api/instances');

			return [
				...(body?.instances ?? []).map((inst) => ({
					group: 'web.searchGroups.instances',
					label: String(inst.name),
					detail: `${inst.software ?? 'instance'} ${inst.mcVersion ?? ''} · ${inst.state ?? 'unknown'}`.replace(
						/\s+/g,
						' '
					),
					href: `/instances/${inst.name}`,
					icon: 'server'
				})),
				...(body?.externals ?? []).map((inst) => ({
					group: 'web.searchGroups.instances',
					label: String(inst.name),
					detail: `external · ${inst.external}`,
					href: '/instances',
					icon: 'server'
				}))
			];
		}
	},

	// one provider per kind, because a mod and a plugin are different objects to
	// look for even though the lockfile stores them the same way
	{
		group: 'web.searchGroups.plugins',
		icon: 'plug',
		load: async () => addonHits('plugins', 'web.searchGroups.plugins', 'plug')
	},

	{
		group: 'web.searchGroups.mods',
		icon: 'puzzle',
		load: async () => addonHits('mods', 'web.searchGroups.mods', 'puzzle')
	},

	{
		group: 'web.searchGroups.addonGroups',
		icon: 'layerGroup',
		load: async () => {
			const body = await fetchJson<{ groups?: any[] }>('/api/addons/groups');

			return (body?.groups ?? []).map((group) => ({
				group: 'web.searchGroups.addonGroups',
				label: String(group.name),
				detail:
					`${group.plugins?.length ?? 0} plugin(s), ${group.respacks?.length ?? 0} resource pack(s), ` +
					`${group.datapacks?.length ?? 0} data pack(s)` +
					(group.usedBy?.length ? ` · used by ${group.usedBy.join(', ')}` : ''),
				href: `/addons/groups/${encodeURIComponent(group.name)}`,
				icon: 'layerGroup'
			}));
		}
	},

	{
		group: 'web.searchGroups.resourcePacks',
		icon: 'image',
		load: async () => {
			const body = await fetchJson<{ packs?: any[] }>('/api/respacks');

			return (body?.packs ?? []).map((pack) => ({
				group: 'web.searchGroups.resourcePacks',
				label: String(pack.key),
				detail: `${pack.enabled ? 'enabled' : 'disabled'} · priority ${pack.priority} · ${pack.servers?.join(', ') || 'no servers'}`,
				href: `/packs/${encodeURIComponent(pack.key)}`,
				icon: 'image'
			}));
		}
	},

	{
		group: 'web.searchGroups.dataPacks',
		icon: 'box',
		load: async () => {
			const body = await fetchJson<{ packs?: any[] }>('/api/datapacks');

			return (body?.packs ?? []).map((pack) => ({
				group: 'web.searchGroups.dataPacks',
				label: String(pack.name),
				detail: `${pack.entry?.source ?? 'pack'} ${pack.entry?.installed?.versionNumber ?? ''} · ${pack.effectiveTargets?.join(', ') || 'no targets'}`,
				href: screenHref('/datapacks', pack.name),
				icon: 'box'
			}));
		}
	},

	{
		group: 'web.searchGroups.runtimes',
		icon: 'microchip',
		load: async () => {
			const body = await fetchJson<{ machines?: any[] }>('/api/runtimes');
			const seen = new Map<string, string[]>();

			// a runtime installed on three machines is one object to look for, so the
			// machines it sits on become its detail line rather than three hits
			for (const machine of body?.machines ?? []) {
				for (const runtime of machine.runtimes ?? []) {
					const on = seen.get(runtime.id) ?? [];

					on.push(machine.name);
					seen.set(runtime.id, on);
				}
			}

			return [...seen.entries()].map(([id, on]) => ({
				group: 'web.searchGroups.runtimes',
				label: id,
				detail: on.join(', '),
				href: screenHref('/runtime/java', id),
				icon: 'microchip'
			}));
		}
	},

	{
		group: 'web.searchGroups.profiles',
		icon: 'sliders',
		load: async () => {
			const body = await fetchJson<{ profiles?: any[] }>('/api/profiles');

			return (body?.profiles ?? []).map((profile) => ({
				group: 'web.searchGroups.profiles',
				label: String(profile.name),
				detail: [
					profile.runtime ?? profile.java ?? 'machine default',
					`${profile.flags?.length ?? 0} flags`,
					profile.usedBy?.length ? profile.usedBy.join(', ') : 'unused'
				].join(' · '),
				href: screenHref('/runtime/profiles', profile.name),
				icon: 'sliders'
			}));
		}
	},

	{
		group: 'web.searchGroups.machines',
		icon: 'hardDrive',
		load: async () => {
			const body = await fetchJson<{ daemons?: any[] }>('/api/daemons');

			return (body?.daemons ?? []).map((daemon) => ({
				group: 'web.searchGroups.machines',
				label: String(daemon.name),
				detail: `${daemon.mode} · ${daemon.online ? 'online' : 'offline'}${daemon.host ? ` · ${daemon.host}` : ''}`,
				href: `/machines/${encodeURIComponent(daemon.name)}`,
				icon: 'hardDrive'
			}));
		}
	},

	{
		group: 'web.searchGroups.schedules',
		icon: 'clock',
		load: async () => {
			const body = await fetchJson<{ schedules?: any[] }>('/api/schedules');

			return (body?.schedules ?? []).map((schedule) => ({
				group: 'web.searchGroups.schedules',
				label: String(schedule.name),
				detail: `${schedule.action} ${schedule.instances?.join(', ') ?? ''} · ${schedule.enabled ? 'enabled' : 'disabled'}`,
				href: screenHref('/schedules', schedule.name),
				icon: 'clock'
			}));
		}
	},

	{
		group: 'web.searchGroups.players',
		icon: 'users',
		load: async () => {
			// the directory covers everyone; online players carry their backend
			const body = await fetchJson<{ players?: any[] }>('/api/players?limit=200');

			return (body?.players ?? []).map((player) => ({
				group: 'web.searchGroups.players',
				label: String(player.username),
				detail: player.online ? `on ${player.server} · ${player.uuid}` : `offline · ${player.uuid}`,
				href: `/players/${player.uuid}`,
				icon: 'users'
			}));
		}
	},

	{
		group: 'web.searchGroups.permissionGroups',
		icon: 'key',
		load: async () => {
			const body = await fetchJson<{ groups?: any[] }>('/api/permissions/groups');

			return (body?.groups ?? []).map((group) => ({
				group: 'web.searchGroups.permissionGroups',
				label: String(group.name),
				detail: `weight ${group.weight} · ${group.memberCount} member(s)`,
				href: `/permissions/${encodeURIComponent(String(group.name))}`,
				icon: 'key'
			}));
		}
	},

	{
		group: 'web.searchGroups.environment',
		icon: 'key',
		load: async () => {
			const body = await fetchJson<{ variables?: any[] }>('/api/env');

			return (body?.variables ?? []).map((variable) => ({
				group: 'web.searchGroups.environment',
				label: String(variable.name),
				detail: variable.secret ? 'secret' : (variable.description || variable.value || 'variable'),
				href: screenHref('/environment', variable.name),
				icon: 'key'
			}));
		}
	},

	{
		group: 'web.searchGroups.accounts',
		icon: 'userShield',
		load: async () => {
			const body = await fetchJson<{ accounts?: any[] }>('/api/accounts');

			return (body?.accounts ?? []).map((account) => ({
				group: 'web.searchGroups.accounts',
				label: String(account.username),
				detail: [
					account.displayName || '',
					account.enabled ? 'enabled' : 'disabled',
					`${account.identities?.length ?? 0} identity/identities`,
					account.activeSessions ? `${account.activeSessions} session(s)` : ''
				]
					.filter(Boolean)
					.join(' · '),
				href: `/console/accounts/${account.id}`,
				icon: 'userShield'
			}));
		}
	},

	{
		group: 'web.searchGroups.ports',
		icon: 'sitemap',
		load: async () => {
			const body = await fetchJson<{ ports?: any[] }>('/api/ports');

			return (body?.ports ?? []).map((entry) => ({
				group: 'web.searchGroups.ports',
				// the same number on two machines is two different ports, so the
				// machine belongs in what tells them apart
				label: `${entry.port}/${entry.protocol}`,
				detail: `${entry.owner} · ${entry.kind} · ${entry.machine === null ? 'external' : entry.machine || 'primary'}`,
				href: screenHref('/network', String(entry.port)),
				icon: 'sitemap'
			}));
		}
	},

	{
		group: 'web.searchGroups.proxyRoutes',
		icon: 'route',
		load: async () => {
			const body = await fetchJson<{ desired?: Record<string, string> }>('/api/proxy');

			return Object.entries(body?.desired ?? {}).map(([server, address]) => ({
				group: 'web.searchGroups.proxyRoutes',
				label: server,
				detail: `routes to ${address}`,
				href: screenHref('/proxy', server),
				icon: 'route'
			}));
		}
	}
];

/** Load every provider in parallel; a failing one contributes nothing. */
export async function loadSearchIndex(): Promise<SearchHit[]> {
	const results = await Promise.all(
		SEARCH_PROVIDERS.map(async (provider) => {
			try {
				return await provider.load();
			} catch {
				return [];
			}
		})
	);

	return results.flat();
}
