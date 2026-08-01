<script lang="ts">
	import '../app.scss';
	import favicon from '$lib/assets/favicon.svg';
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import TerminalDrawer from '$lib/components/TerminalDrawer.svelte';
	import Flashbar from '$lib/components/Flashbar.svelte';
	import ShellGlyph from '$lib/components/ShellGlyph.svelte';
	import GlobalSearch from '$lib/components/GlobalSearch.svelte';
	import TooltipHost from '$lib/components/TooltipHost.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { fmtBytes } from '$lib/format';
	import { tooltip } from '$lib/tooltip.svelte';

	let { children } = $props();

	/** host vitals are cheap but not free — poll them slowly */
	const HOST_POLL_MS = 60_000;

	interface HostInfo {
		root: string;
		disk: { totalBytes: number; usedBytes: number; freeBytes: number; mount: string } | null;
	}

	let host: HostInfo | null = $state(null);

	$effect(() => {
		let alive = true;

		const load = async (): Promise<void> => {
			try {
				const res = await fetch('/api/host');

				if (alive && res.ok) {
					host = await res.json();
				}
			} catch {
				// chrome-only decoration — a failed poll just leaves the last value
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

	const nav = [
		{
			section: 'Instances',
			items: [
				{ label: 'Instances', href: '/instances', icon: 'server' },
				{ label: 'Launch instance', href: '/instances/launch', icon: 'rocket' }
			]
		},
		{
			section: 'Plugins',
			items: [{ label: 'Plugins', href: '/plugins', icon: 'plug' }]
		},
		{
			section: 'Network & Proxy',
			items: [
				{ label: 'Ports', href: '/network', icon: 'sitemap' },
				{ label: 'Proxy routing', href: '/proxy', icon: 'route' }
			]
		},
		{
			section: 'Maintenance',
			items: [{ label: 'Cleanup', href: '/cleanup', icon: 'broom' }]
		},
		{
			section: 'Development',
			items: [{ label: 'Components', href: '/gallery', icon: 'shapes' }]
		}
	];

	const crumbs = $derived.by(() => {
		const parts = page.url.pathname.split('/').filter(Boolean);
		const out: Array<{ label: string; href: string }> = [{ label: 'MRDS', href: '/' }];
		let acc = '';

		for (const part of parts) {
			acc += `/${part}`;
			out.push({ label: part.charAt(0).toUpperCase() + part.slice(1), href: acc });
		}

		return out;
	});

	function isActive(href: string): boolean {
		// "Launch instance" is its own nav entry, so /instances must not claim it
		if (href === '/instances') {
			return /^\/instances(?!\/launch)/.test(page.url.pathname);
		}

		return page.url.pathname === href || page.url.pathname.startsWith(href + '/');
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>MRDS Console</title>
</svelte:head>

<div class="app" style:--shell-h="{shellOpen && browser ? shellHeight : 0}px">
	<header class="topnav">
		<a class="brand" href="/instances">
			<span class="logo"><Icon name="cube" size="1.125rem" style="solid" /></span>
			<b>mrds</b><span class="dim-sep">|</span><span class="sub">Luna Cluster Console</span>
		</a>
		<GlobalSearch />
		<div class="region">
			{#if host?.disk}
				{@const disk = host.disk}
				<span
					class="disk"
					use:tooltip={{
						content: `${fmtBytes(disk.usedBytes)} used of ${fmtBytes(disk.totalBytes)} on ${disk.mount} · ${fmtBytes(disk.freeBytes)} free`,
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
						right="{fmtBytes(disk.freeBytes)} free"
					/>
				</span>
				<span class="regdiv"></span>
			{/if}
			<span class="where">
				<Icon name="hardDrive" size="0.875rem" style="solid" /> shulker · {host?.root ?? '/mnt/shulker/mrds'}
			</span>
		</div>
	</header>

	<div class="crumbs">
		{#each crumbs as crumb, i}
			{#if i > 0}
				<span class="sep"><Icon name="arrowRight" size="0.625rem" /></span>
			{/if}
			{#if i === crumbs.length - 1}
				<span class="here">{crumb.label}</span>
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
				title={navCollapsed ? 'Expand' : 'Collapse'}
			>
				<Icon name={navCollapsed ? 'rightFromLine' : 'leftFromLine'} size="0.875rem" style="solid" />
			</button>
			{#if !navCollapsed}
				<div class="navhead"><a href="/instances">Minecraft Cluster</a></div>
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
		<TerminalDrawer bind:height={shellHeight} onclose={() => (shellOpen = false)} />
	{/if}

	<footer class="statusbar">
		<button class="shellbtn" onclick={() => (shellOpen = !shellOpen)}>
			<ShellGlyph size="0.8125rem" /> Terminal
		</button>
		<span class="statusdiv"></span>
		<span class="spacer"></span>
		<span class="dim">mrds console — part of luna network by <a href="https://github.com/belikhun" target="_blank">belikhun</a></span>
	</footer>

	<TooltipHost />
</div>

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
	}

	.mid {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	// side nav: panel background, 1px chrome rule on the right, 28px rows inset
	// 20px/8px, hr groups, and an active item that is simply blue and bold —
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
</style>
