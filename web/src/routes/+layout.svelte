<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import '../app.scss';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { browser, dev } from '$app/environment';
	import TerminalDrawer from '$lib/components/TerminalDrawer.svelte';
	import Flashbar from '$lib/components/Flashbar.svelte';
	import ShellGlyph from '$lib/components/ShellGlyph.svelte';
	import GlobalSearch from '$lib/components/GlobalSearch.svelte';
	import TooltipHost from '$lib/components/TooltipHost.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import LunaMark from '$lib/components/LunaMark.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { del } from '$lib/api';
	import { INSTANCE_TAB_LABELS, isInstanceTab } from '$lib/components/instancetabs';
	import { crumbLabel } from '$lib/crumbs.svelte';
	import { fmtBytes } from '$lib/format';
	import { LANGUAGES, currentLanguage, switchLanguage, t } from '$lib/i18n.svelte';
	import { tooltip } from '$lib/tooltip.svelte';

	let { children, data } = $props();

	/**
	 * Screens that render on their own, without any of the chrome below.
	 *
	 * The sign-in page is reachable before there is a session, so the side nav,
	 * the global search, the terminal drawer and the host vitals all have nothing
	 * to talk to. The public page is the same case for a different reason: it is
	 * served to visitors who have no account and are not meant to learn that an
	 * operator's console exists behind it. A route group would express this too,
	 * but at the cost of moving every screen in the console into one.
	 */
	const bare = $derived(
		page.url.pathname === '/login' ||
			page.url.pathname === '/public' ||
			page.url.pathname.startsWith('/public/')
	);

	/** The signed-in account, resolved server-side in `+layout.server.ts`. */
	const account = $derived(data?.account ?? null);

	/** host vitals are cheap but not free; poll them slowly */
	const HOST_POLL_MS = 60_000;

	interface HostInfo {
		/** the local daemon's name; the machine this console is attached to */
		name: string;
		root: string;
		disk: { totalBytes: number; usedBytes: number; freeBytes: number; mount: string } | null;
	}

	let host: HostInfo | null = $state(null);

	$effect(() => {
		// the sign-in screen has no session, so this poll would only ever 401
		if (bare) {
			return;
		}

		let alive = true;

		const load = async (): Promise<void> => {
			try {
				const res = await fetch('/api/host');

				if (alive && res.ok) {
					host = await res.json();
				}
			} catch {
				// chrome-only decoration; a failed poll just leaves the last value
			}
		};

		void load();

		const id = setInterval(load, HOST_POLL_MS);

		return () => {
			alive = false;
			clearInterval(id);
		};
	});

	let shellOpen = $state(false);
	let shellHeight = $state(320);
	let navCollapsed = $state(false);

	const nav = $derived([
		{
			section: t('web.nav.instances'),
			items: [
				{ label: t('web.nav.instancesList'), href: '/instances', icon: 'server' },
				{ label: t('web.nav.serverSelector'), href: '/instances/selector', icon: 'grid' },
				{ label: t('web.nav.launchInstance'), href: '/instances/launch', icon: 'rocket' }
			]
		},
		{
			section: t('web.nav.players'),
			items: [
				{ label: t('web.nav.playersList'), href: '/players', icon: 'users' },
				{ label: t('web.nav.onlinePlayers'), href: '/players/online', icon: 'userPortrait' },
				{ label: t('web.nav.moderation'), href: '/players/moderation', icon: 'gavel' },
				{ label: t('web.nav.permissionGroups'), href: '/permissions', icon: 'key' }
			]
		},
		{
			section: t('web.nav.addons'),
			items: [
				{ label: t('web.nav.plugins'), href: '/plugins', icon: 'plug' },
				{ label: t('web.nav.mods'), href: '/mods', icon: 'puzzle' },
				{ label: t('web.nav.resourcePacks'), href: '/packs', icon: 'image' },
				{ label: t('web.nav.dataPacks'), href: '/datapacks', icon: 'box' },
				{ label: t('web.nav.addonGroups'), href: '/addons/groups', icon: 'layerGroup' }
			]
		},
		{
			section: t('web.nav.runtime'),
			items: [
				{ label: t('web.nav.javaRuntimes'), href: '/runtime/java', icon: 'microchip' },
				{ label: t('web.nav.javaProfiles'), href: '/runtime/profiles', icon: 'sliders' }
			]
		},
		{
			section: t('web.nav.networkProxy'),
			items: [
				{ label: t('web.nav.ports'), href: '/network', icon: 'sitemap' },
				{ label: t('web.nav.proxyRouting'), href: '/proxy', icon: 'route' }
			]
		},
		{
			section: t('web.nav.automation'),
			items: [
				{ label: t('web.nav.schedules'), href: '/schedules', icon: 'clock' },
				{ label: t('web.nav.environment'), href: '/environment', icon: 'key' }
			]
		},
		{
			section: t('web.nav.maintenance'),
			items: [{ label: t('web.nav.cleanup'), href: '/cleanup', icon: 'broom' }]
		},
		{
			section: t('web.nav.cluster'),
			items: [{ label: t('web.nav.machines'), href: '/machines', icon: 'hardDrive' }]
		},
		{
			section: t('web.nav.console'),
			items: [
				{ label: t('web.nav.accounts'), href: '/console/accounts', icon: 'userShield' },
				{ label: t('web.nav.consoleLogs'), href: '/console/logs', icon: 'fileLines' }
			]
		},
		// the component gallery is a workbench for building the console, not a way
		// to operate a cluster, so it only exists in a dev server. `dev` is
		// resolved at build time, so a production bundle never carries the entry
		// (the route itself still answers, for anyone who types the path)
		...(dev
			? [
					{
						section: t('web.nav.development'),
						items: [{ label: t('web.nav.components'), href: '/gallery', icon: 'shapes' }]
					}
				]
			: [])
	]);

	/**
	 * The account menu, top right, as the console this is modelled on places it.
	 * "Your account" goes to the signed-in account's own detail screen, which is
	 * where its password, its access keys and its open sessions live; there is no
	 * separate profile screen holding a second copy of them.
	 */
	const accountMenu: ContextMenuItem[] = $derived(
		!account
			? []
			: [
					{ label: account.username, header: true },
					{
						label: t('web.layout.yourAccount'),
						icon: 'userPortrait',
						action: () => goto(`/console/accounts/${account.id}`)
					},
					{
						label: t('web.nav.accounts'),
						icon: 'userShield',
						action: () => goto('/console/accounts')
					},
					{
						label: t('web.nav.consoleLogs'),
						icon: 'fileLines',
						action: () => goto('/console/logs')
					},
					{ separator: true },
					{ label: t('web.layout.signOut'), icon: 'rightFromBracket', color: 'danger', action: signOut }
				]
	);

	async function signOut(): Promise<void> {
		await del('/auth/session').catch(() => {});

		// a full load: the gate has to run again, and every layout on the far side of
		// it must be discarded rather than kept in the client's cache
		location.href = '/login';
	}

	/**
	 * Route patterns that have a page of their own.
	 *
	 * The crumb trail is derived from the URL, and **not every prefix of a URL is a
	 * page**: `/instances/<name>/plugins/<plugin>` is one, `/instances/<name>/plugins`
	 * is not - the addon list is a tab on the instance page. Linking every prefix
	 * blindly sent people to a 404, and that path was not the only one shaped like
	 * it: `/runtime` and `/addons` are both linked prefixes with no page either.
	 *
	 * Held as route ids so a dynamic segment matches structurally rather than by
	 * value. A page missing from this list only loses its crumb link, which is the
	 * safe direction to be wrong in - so add to it when you add a page, and nothing
	 * breaks if you forget.
	 */
	const PAGE_ROUTES = new Set([
		'/addons/groups',
		'/addons/groups/[name]',
		'/addons/groups/new',
		'/cleanup',
		'/console/accounts',
		'/console/accounts/[id]',
		'/console/accounts/[id]/edit',
		'/console/accounts/new',
		'/console/logs',
		'/datapacks',
		'/environment',
		'/environment/[name]',
		'/environment/new',
		'/gallery',
		'/instances',
		'/instances/launch',
		'/instances/[name]',
		'/instances/[name]/[[tab]]',
		'/instances/[name]/plugins',
		'/instances/[name]/console',
		'/instances/[name]/files',
		'/instances/[name]/plugins/[plugin]',
		'/instances/selector',
		'/machines',
		'/machines/[name]',
		'/mods',
		'/network',
		'/network/pools',
		'/packs',
		'/packs/[key]',
		'/packs/[key]/configure',
		'/permissions',
		'/permissions/[name]',
		'/permissions/[name]/edit',
		'/players',
		'/players/moderation',
		'/players/online',
		'/players/[player]',
		'/plugins',
		'/plugins/[name]',
		'/proxy',
		'/public',
		'/public/[instance]',
		'/runtime/java',
		'/runtime/profiles',
		'/runtime/profiles/new',
		'/schedules',
		'/schedules/new'
	]);

	const crumbs = $derived.by(() => {
		const parts = page.url.pathname.split('/').filter(Boolean);
		// the matching route id, which is what says whether a segment is a literal
		// or a value; null on an error page, where nothing below claims otherwise
		const pattern = (page.route.id ?? '').split('/').filter(Boolean);
		const out: Array<{ label: string; href: string }> = [{ label: 'Luna', href: '/' }];

		let path = '';
		let route = '';

		for (let index = 0; index < parts.length; index += 1) {
			const part = parts[index]!;
			const literal = pattern[index];
			const dynamic = literal === undefined || literal.startsWith('[');

			path += `/${part}`;
			route += `/${literal ?? part}`;

			// An instance tab is a path segment whose slug is not its name: `respacks`
			// is "Resource packs". It is the one dynamic segment with a name of its
			// own, so it is looked up rather than derived from the text.
			const tabLabel =
				literal === '[[tab]]' && isInstanceTab(part) ? t(INSTANCE_TAB_LABELS[part]) : undefined;

			// A static segment is a route literal and reads as a noun, so it is
			// title-cased. A dynamic one is a *value* - an instance name, an account id
			// - and is shown exactly as it is configured: the instance called
			// `survival` is not called `Survival`, and shouting it makes the crumb
			// disagree with every other place the name appears.
			//
			// A label the screen has lent wins over both: the addon tab is called
			// "Plugins" or "Mods" depending on the instance's software, and only the
			// screen knows which.
			const label =
				crumbLabel(path) ??
				tabLabel ??
				(!dynamic && /^[a-z]+$/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part);

			out.push({ label, href: PAGE_ROUTES.has(route) ? path : '' });
		}

		return out;
	});

	function isActive(href: string): boolean {
		// "Launch instance" and "Server selector" are their own nav entries, so
		// /instances must not claim them
		if (href === '/instances') {
			return /^\/instances(?!\/launch|\/selector)/.test(page.url.pathname);
		}

		// "Online players" and "Moderation" are their own nav entries, so
		// /players must not claim them
		if (href === '/players') {
			return /^\/players(?!\/online|\/moderation)/.test(page.url.pathname);
		}

		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Luna Console</title>
</svelte:head>

{#if bare}
	{@render children?.()}
	<TooltipHost />
{:else}
	<div class="app" style:--shell-h="{shellOpen && browser ? shellHeight : 0}px">
		<header class="topnav">
			<a class="brand" href="/instances">
				<LunaMark size="1.5rem" glyph="1rem" />
				<span class="dim-sep">|</span>
				<span class="logo"><Icon name="cube" size="1.125rem" style="solid" /></span>
				<!-- the name says which console this is: a dev server and the real one
				     look identical otherwise, and acting on the wrong one is the mistake
				     worth spending a word of chrome to prevent -->
				<b class:dev>{dev ? 'luna-dev' : 'luna'}</b><span class="dim-sep">|</span><span
					class="sub">Luna Cluster Console</span
				>
			</a>
			<GlobalSearch />
			<div class="region">
				{#if host?.disk}
					{@const disk = host.disk}
					<span
						class="disk"
						use:tooltip={{
							content: t('web.layout.diskTooltip', {
								used: fmtBytes(disk.usedBytes),
								total: fmtBytes(disk.totalBytes),
								mount: disk.mount,
								free: fmtBytes(disk.freeBytes)
							}),
							position: 'bottom'
						}}
					>
						<ProgressBar
							compact
							transition={false}
							width="12rem"
							value={disk.usedBytes}
							max={disk.totalBytes}
							color="auto"
							right={t('web.layout.diskFree', { free: fmtBytes(disk.freeBytes) })}
						/>
					</span>
					<span class="regdiv"></span>
				{/if}
				<span class="where">
					<Icon name="hardDrive" size="0.875rem" style="solid" />
					{host?.name ?? '—'} · {host?.root ?? '—'}
				</span>
				{#if account}
					<span class="regdiv"></span>
					<span class="who">
						<Dropdown label={account.username} menu={accountMenu} />
					</span>
				{/if}
			</div>
		</header>

		<div class="crumbs">
			{#each crumbs as crumb, i}
				{#if i > 0}
					<span class="sep"><Icon name="arrowRight" size="0.625rem" /></span>
				{/if}
				{#if i === crumbs.length - 1 || !crumb.href}
					<span class="here" class:plain={i !== crumbs.length - 1}>{crumb.label}</span>
				{:else}
					<a href={crumb.href}>{crumb.label}</a>
				{/if}
			{/each}
		</div>

		<div class="mid">
			<nav class="sidenav" class:collapsed={navCollapsed}>
				<button
					class="collapse"
					onclick={() => (navCollapsed = !navCollapsed)}
					title={navCollapsed ? t('web.layout.expand') : t('web.layout.collapse')}
				>
					<Icon name={navCollapsed ? 'rightFromLine' : 'leftFromLine'} size="0.875rem" style="solid" />
				</button>
				{#if !navCollapsed}
					<div class="navhead"><a href="/instances">{t('web.layout.navTitle')}</a></div>
					{#each nav as group, gi}
						{#if gi > 0}<hr />{/if}
						<div class="group">
							<div class="gt">{group.section}</div>
							{#each group.items as item}
								<a class="nl" class:active={isActive(item.href)} href={item.href}>
									<Icon name={item.icon} size="1rem" style="solid" />
									{item.label}
								</a>
							{/each}
						</div>
					{/each}
				{/if}
			</nav>

			<main class="content">
				<Flashbar />
				{@render children?.()}
			</main>
		</div>

		{#if shellOpen && browser}
			<TerminalDrawer
				bind:height={shellHeight}
				user={account?.username ?? 'root'}
				onclose={() => (shellOpen = false)}
			/>
		{/if}

		<footer class="statusbar">
			<button class="shellbtn" onclick={() => (shellOpen = !shellOpen)}>
				<ShellGlyph size="0.8125rem" /> {t('web.layout.terminal')}
			</button>
			<span class="statusdiv"></span>
			<span class="spacer"></span>
			<label class="langpick">
				<Icon name="globe" size="0.75rem" style="solid" />
				<select
					value={currentLanguage()}
					onchange={(event) => switchLanguage(event.currentTarget.value as 'en' | 'vi')}
				>
					{#each LANGUAGES as lang}
						<option value={lang.code}>{lang.label}</option>
					{/each}
				</select>
			</label>
			<span class="statusdiv"></span>
			<span class="dim">{t('web.layout.footer')} <a href="https://github.com/belikhun" target="_blank">belikhun</a></span>
		</footer>

		<TooltipHost />
	</div>
{/if}

<style lang="scss">
	.app {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
		--nav-w: 17.5rem;
		--content-top: 4.5rem;
		--statusbar-h: 1.75rem;
	}
	// the split panel and the drawer read --nav-w, so it has to follow the side nav
	.app:has(.sidenav.collapsed) {
		--nav-w: 3rem;
	}

	// console chrome: the top bar and the breadcrumb strip are each closed by a
	// 1px --border-nav rule, so they stack as two separate bands
	.topnav {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		background: var(--bg-nav);
		border-bottom: 0.1rem solid var(--border-nav);
		padding: 0 1rem;
		height: 3rem;
		flex: none;
	}
	// chrome link, so it opts out of the global in-content underline
	.brand {
		color: #fff;
		font-size: 1rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;

		&,
		&:hover {
			text-decoration: none;
		}

		// a dev console must not be mistakeable for the production one at a glance
		b.dev {
			color: var(--warning);
		}

		.sub {
			color: var(--text);
			font-size: 0.875rem;
			font-weight: 300;
		}
	}

	.logo {
		color: var(--primary);
		display: inline-flex;
	}

	.dim-sep {
		color: #414d5c;
		margin: 0 0.125rem;
		font-weight: 300;
	}

	// pinned to the window edge: the search box only grows to its max-width, so
	// without the auto margin the vitals would float in the middle of the bar
	.region {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
		flex: none;
		color: var(--text-secondary);
		font-size: 0.75rem;
	}
	.region .where {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.disk {
		display: inline-flex;
		align-items: center;
		font-size: 0.6875rem;
	}

	.regdiv {
		width: var(--hairline);
		height: 1rem;
		background: var(--border-nav);
	}

	// the account menu sits in chrome, not in a content panel, so its trigger is
	// pulled down to the bar's own type scale rather than the button metric
	.who :global(.trigger) {
		height: 1.5rem;
		font-size: 0.75rem;
		padding: 0 0.625rem;
	}

	.crumbs {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: var(--bg-panel);
		border-bottom: 0.1rem solid var(--border-nav);
		padding: 0 1.5rem;
		height: 2.625rem;
		font-size: 0.875rem;
		flex: none;
	}
	.crumbs {
		.sep {
			color: var(--text-disabled);
			display: inline-flex;
		}

		// the current page is the one crumb that does not navigate
		.here {
			color: var(--text-secondary);
			text-decoration: none;
		}

		// a segment with no page of its own: still part of the path, but there is
		// nowhere to go, so it must not look clickable and must not look current
		// either
		.here.plain {
			color: var(--text-disabled);
		}
	}

	.mid {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	// side nav: panel background, 1px chrome rule on the right, 28px rows inset
	// 20px/8px, hr groups, and an active item that is simply blue and bold -
	// there is no rail or fill behind it
	.sidenav {
		width: var(--nav-w);
		flex: none;
		background: var(--bg-panel);
		border-right: 0.1rem solid var(--border-nav);
		overflow-y: auto;
		padding: 0 1rem 1.5rem 1.25rem;
		position: relative;

		&.collapsed {
			width: 3rem;
			padding-right: 0;
		}

		hr {
			border: none;
			border-top: 0.1rem solid var(--border-nav);
			margin: 1.25rem 0;
		}
	}

	// centred on the navhead's text line (1.25rem padding + half of its 1.375rem
	// line box) so the chevron and the title share a baseline
	.collapse {
		@include bare-button;

		position: absolute;
		top: 1.9375rem;
		right: 0.75rem;
		transform: translateY(-50%);
		color: var(--text);
		padding: 0.25rem;
		border-radius: 0.5rem;

		&:hover {
			color: var(--link);
			background: var(--bg-hover);
		}
	}

	.navhead {
		font-weight: 700;
		font-size: 1.125rem;
		line-height: 1.375rem;
		padding: 1.25rem 2.75rem 1.25rem 0.5rem;

		// chrome link, so it opts out of the global in-content underline
		a {
			color: var(--text-heading);
			text-decoration: none;

			&:hover {
				color: var(--link);
			}
		}
	}

	.gt {
		font-size: 0.875rem;
		font-weight: 700;
		color: var(--text-heading);
		padding: 0.25rem 0.5rem;
	}
	.nl {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		color: var(--text);
		padding: 0.25rem 0.5rem;
		font-size: 0.875rem;
		line-height: 1.25rem;
		border-radius: 0.5rem;
		text-decoration: none;
	}
	.nl {
		&:hover {
			color: var(--link);
			background: var(--bg-hover);
		}

		// the active item is marked with colour and weight alone
		&.active {
			color: var(--link);
			font-weight: 700;
		}
	}

	.content {
		flex: 1;
		overflow-y: auto;
		min-width: 0;
		padding: 1.25rem 1.5rem 2.5rem;
		padding-bottom: calc(2.5rem + var(--split-bottom, 0rem));
		padding-right: calc(1.5rem + var(--split-right, 0rem));
	}

	.statusbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		background: var(--bg-nav);
		border-top: 0.1rem solid #000;
		padding: 0 0.5rem;
		height: 1.75rem;
		flex: none;
		font-size: 0.75rem;
	}
	.spacer {
		flex: 1;
	}

	.shellbtn {
		@include bare-button;

		color: var(--text);
		font-size: 0.6875rem;
		font-weight: 400;
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		height: 100%;
		padding: 0 0.5rem;

		&:hover {
			color: var(--link);
		}
	}

	.statusdiv {
		width: 0.1rem;
		height: 1rem;
		background: var(--border);
	}

	// the locale picker sits in the status bar chrome, styled as quiet text
	.langpick {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--text);
		font-size: 0.6875rem;

		select {
			background: transparent;
			border: none;
			color: var(--text);
			font-size: 0.6875rem;
			cursor: pointer;

			&:hover {
				color: var(--link);
			}

			option {
				background: var(--bg-panel);
				color: var(--text);
			}
		}
	}
</style>
