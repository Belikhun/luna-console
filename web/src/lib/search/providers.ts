/**
 * The global search index (DESIGN.md §5.3).
 *
 * One provider per kind of object in the cluster. Adding a new kind of object
 * to luna means adding a provider here — `GlobalSearch.svelte` never grows
 * another branch, and nothing in the system stays unfindable because someone
 * forgot to teach the search box about it.
 *
 * Providers are loaded lazily on first focus, in parallel, and cached. A
 * provider that throws contributes nothing rather than emptying the box.
 */

export interface SearchHit {
	group: string;
	label: string;
	/** the second line — what distinguishes this hit from a similar one */
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
const PAGES: SearchHit[] = [
	{ group: 'Pages', label: 'Instances', detail: 'Cluster instances', href: '/instances', icon: 'server' },
	{
		group: 'Pages',
		label: 'Server selector',
		detail: 'The chest players open with /servers',
		href: '/instances/selector',
		icon: 'grid'
	},
	{
		group: 'Pages',
		label: 'Launch instance',
		detail: 'Create a new backend',
		href: '/instances/launch',
		icon: 'rocket'
	},
	{ group: 'Pages', label: 'Players', detail: 'Every player the network has seen', href: '/players', icon: 'users' },
	{
		group: 'Pages',
		label: 'Online players',
		detail: 'Who is online right now',
		href: '/players/online',
		icon: 'userPortrait'
	},
	{
		group: 'Pages',
		label: 'Permission groups',
		detail: 'LuckPerms groups and nodes',
		href: '/permissions',
		icon: 'key'
	},
	{ group: 'Pages', label: 'Plugins', detail: 'Plugin pool and updates', href: '/plugins', icon: 'plug' },
	{ group: 'Pages', label: 'Mods', detail: 'Mod pool for the loader instances', href: '/mods', icon: 'puzzle' },
	{
		group: 'Pages',
		label: 'Addon groups',
		detail: 'Sets of plugins and packs applied as a unit',
		href: '/addons/groups',
		icon: 'layerGroup'
	},
	{
		group: 'Pages',
		label: 'Resource packs',
		detail: 'Proxy-served resource packs',
		href: '/packs',
		icon: 'image'
	},
	{
		group: 'Pages',
		label: 'Data packs',
		detail: 'World data pack pool',
		href: '/datapacks',
		icon: 'box'
	},
	{ group: 'Pages', label: 'Ports', detail: 'Port allocations', href: '/network', icon: 'sitemap' },
	{ group: 'Pages', label: 'Proxy routing', detail: 'Velocity routes', href: '/proxy', icon: 'route' },
	{ group: 'Pages', label: 'Schedules', detail: 'Timed instance actions', href: '/schedules', icon: 'clock' },
	{
		group: 'Pages',
		label: 'Environment',
		detail: 'Template variables',
		href: '/environment',
		icon: 'key'
	},
	{ group: 'Pages', label: 'Cleanup', detail: 'Reclaim disk space', href: '/cleanup', icon: 'broom' },
	{
		group: 'Pages',
		label: 'Machines',
		detail: 'Cluster machines and their daemons',
		href: '/machines',
		icon: 'hardDrive'
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
 * One kind's addons as search hits. Both kinds come from the same endpoint —
 * the lockfile does not separate them — so the kind filter is what makes the
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
		group: 'Pages',
		icon: 'file',
		load: async () => PAGES
	},

	{
		group: 'Instances',
		icon: 'server',
		load: async () => {
			const body = await fetchJson<{ instances?: any[]; externals?: any[] }>('/api/instances');

			return [
				...(body?.instances ?? []).map((inst) => ({
					group: 'Instances',
					label: String(inst.name),
					detail: `${inst.software ?? 'instance'} ${inst.mcVersion ?? ''} · ${inst.state ?? 'unknown'}`.replace(
						/\s+/g,
						' '
					),
					href: `/instances/${inst.name}`,
					icon: 'server'
				})),
				...(body?.externals ?? []).map((inst) => ({
					group: 'Instances',
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
		group: 'Plugins',
		icon: 'plug',
		load: async () => addonHits('plugins', 'Plugins', 'plug')
	},

	{
		group: 'Mods',
		icon: 'puzzle',
		load: async () => addonHits('mods', 'Mods', 'puzzle')
	},

	{
		group: 'Addon groups',
		icon: 'layerGroup',
		load: async () => {
			const body = await fetchJson<{ groups?: any[] }>('/api/addons/groups');

			return (body?.groups ?? []).map((group) => ({
				group: 'Addon groups',
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
		group: 'Resource packs',
		icon: 'image',
		load: async () => {
			const body = await fetchJson<{ packs?: any[] }>('/api/respacks');

			return (body?.packs ?? []).map((pack) => ({
				group: 'Resource packs',
				label: String(pack.key),
				detail: `${pack.enabled ? 'enabled' : 'disabled'} · priority ${pack.priority} · ${pack.servers?.join(', ') || 'no servers'}`,
				href: `/packs/${encodeURIComponent(pack.key)}`,
				icon: 'image'
			}));
		}
	},

	{
		group: 'Data packs',
		icon: 'box',
		load: async () => {
			const body = await fetchJson<{ packs?: any[] }>('/api/datapacks');

			return (body?.packs ?? []).map((pack) => ({
				group: 'Data packs',
				label: String(pack.name),
				detail: `${pack.entry?.source ?? 'pack'} ${pack.entry?.installed?.versionNumber ?? ''} · ${pack.effectiveTargets?.join(', ') || 'no targets'}`,
				href: screenHref('/datapacks', pack.name),
				icon: 'box'
			}));
		}
	},

	{
		group: 'Machines',
		icon: 'hardDrive',
		load: async () => {
			const body = await fetchJson<{ daemons?: any[] }>('/api/daemons');

			return (body?.daemons ?? []).map((daemon) => ({
				group: 'Machines',
				label: String(daemon.name),
				detail: `${daemon.mode} · ${daemon.online ? 'online' : 'offline'}${daemon.host ? ` · ${daemon.host}` : ''}`,
				href: `/machines/${encodeURIComponent(daemon.name)}`,
				icon: 'hardDrive'
			}));
		}
	},

	{
		group: 'Schedules',
		icon: 'clock',
		load: async () => {
			const body = await fetchJson<{ schedules?: any[] }>('/api/schedules');

			return (body?.schedules ?? []).map((schedule) => ({
				group: 'Schedules',
				label: String(schedule.name),
				detail: `${schedule.action} ${schedule.instances?.join(', ') ?? ''} · ${schedule.enabled ? 'enabled' : 'disabled'}`,
				href: screenHref('/schedules', schedule.name),
				icon: 'clock'
			}));
		}
	},

	{
		group: 'Players',
		icon: 'users',
		load: async () => {
			// the directory covers everyone; online players carry their backend
			const body = await fetchJson<{ players?: any[] }>('/api/players?limit=200');

			return (body?.players ?? []).map((player) => ({
				group: 'Players',
				label: String(player.username),
				detail: player.online ? `on ${player.server} · ${player.uuid}` : `offline · ${player.uuid}`,
				href: `/players/${player.uuid}`,
				icon: 'users'
			}));
		}
	},

	{
		group: 'Permission groups',
		icon: 'key',
		load: async () => {
			const body = await fetchJson<{ groups?: any[] }>('/api/permissions/groups');

			return (body?.groups ?? []).map((group) => ({
				group: 'Permission groups',
				label: String(group.name),
				detail: `weight ${group.weight} · ${group.memberCount} member(s)`,
				href: `/permissions/${encodeURIComponent(String(group.name))}`,
				icon: 'key'
			}));
		}
	},

	{
		group: 'Environment',
		icon: 'key',
		load: async () => {
			const body = await fetchJson<{ variables?: any[] }>('/api/env');

			return (body?.variables ?? []).map((variable) => ({
				group: 'Environment',
				label: String(variable.name),
				detail: variable.secret ? 'secret' : (variable.description || variable.value || 'variable'),
				href: screenHref('/environment', variable.name),
				icon: 'key'
			}));
		}
	},

	{
		group: 'Ports',
		icon: 'sitemap',
		load: async () => {
			const body = await fetchJson<{ ports?: any[] }>('/api/ports');

			return (body?.ports ?? []).map((entry) => ({
				group: 'Ports',
				label: `${entry.port}/${entry.protocol}`,
				detail: `${entry.owner} · ${entry.kind}`,
				href: screenHref('/network', String(entry.port)),
				icon: 'sitemap'
			}));
		}
	},

	{
		group: 'Proxy routes',
		icon: 'route',
		load: async () => {
			const body = await fetchJson<{ desired?: Record<string, string> }>('/api/proxy');

			return Object.entries(body?.desired ?? {}).map(([server, address]) => ({
				group: 'Proxy routes',
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
