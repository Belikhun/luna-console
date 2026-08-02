/**
 * The global search index (DESIGN.md §5.3).
 *
 * One provider per kind of object in the cluster. Adding a new kind of object
 * to mrds means adding a provider here — `GlobalSearch.svelte` never grows
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
		label: 'Launch instance',
		detail: 'Create a new backend',
		href: '/instances/launch',
		icon: 'rocket'
	},
	{ group: 'Pages', label: 'Players', detail: 'Who is online', href: '/players', icon: 'users' },
	{ group: 'Pages', label: 'Plugins', detail: 'Plugin pool and updates', href: '/plugins', icon: 'plug' },
	{
		group: 'Pages',
		label: 'Plugin groups',
		detail: 'Sets of plugins applied as a unit',
		href: '/plugins/groups',
		icon: 'layerGroup'
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
		label: 'Daemons',
		detail: 'Cluster daemons and followers',
		href: '/daemons',
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

	{
		group: 'Plugins',
		icon: 'plug',
		load: async () => {
			const body = await fetchJson<{ plugins?: any[] }>('/api/plugins');

			return (body?.plugins ?? []).map((plugin) => ({
				group: 'Plugins',
				label: String(plugin.plugin),
				detail: [
					plugin.displayName && plugin.displayName !== plugin.plugin ? plugin.displayName : '',
					plugin.sources?.join(', ') ?? 'plugin',
					plugin.families?.map((family: any) => family.family).join(', ') ?? ''
				]
					.filter(Boolean)
					.join(' · '),
				href: `/plugins/${encodeURIComponent(plugin.plugin)}`,
				icon: 'plug'
			}));
		}
	},

	{
		group: 'Plugin groups',
		icon: 'layerGroup',
		load: async () => {
			const body = await fetchJson<{ groups?: any[] }>('/api/plugins/groups');

			return (body?.groups ?? []).map((group) => ({
				group: 'Plugin groups',
				label: String(group.name),
				detail: `${group.plugins?.length ?? 0} plugin(s)${group.usedBy?.length ? ` · used by ${group.usedBy.join(', ')}` : ''}`,
				href: `/plugins/groups/${encodeURIComponent(group.name)}`,
				icon: 'layerGroup'
			}));
		}
	},

	{
		group: 'Daemons',
		icon: 'hardDrive',
		load: async () => {
			const body = await fetchJson<{ daemons?: any[] }>('/api/daemons');

			return (body?.daemons ?? []).map((daemon) => ({
				group: 'Daemons',
				label: String(daemon.name),
				detail: `${daemon.mode} · ${daemon.online ? 'online' : 'offline'}${daemon.host ? ` · ${daemon.host}` : ''}`,
				href: `/daemons/${encodeURIComponent(daemon.name)}`,
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
			const body = await fetchJson<{ players?: any[] }>('/api/luna/players');

			return (body?.players ?? []).map((player) => ({
				group: 'Players',
				label: String(player.username),
				detail: `on ${player.server} · ${player.uuid}`,
				href: screenHref('/players', player.username),
				icon: 'users'
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
