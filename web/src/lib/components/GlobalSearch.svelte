<script lang="ts">
	import { goto } from '$app/navigation';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	/**
	 * Top-navigation search: the console's unified jump box. Pages are matched
	 * from a static map; instances and plugins are pulled once on first focus and
	 * cached, so opening the box costs nothing until it is actually used.
	 * Alt+S focuses it from anywhere.
	 */
	interface Hit {
		group: string;
		label: string;
		detail: string;
		href: string;
		icon: string;
	}

	const PAGES: Hit[] = [
		{
			group: 'Pages',
			label: 'Instances',
			detail: 'Cluster instances',
			href: '/instances',
			icon: 'server'
		},
		{
			group: 'Pages',
			label: 'Launch instance',
			detail: 'Create a new backend',
			href: '/instances/launch',
			icon: 'rocket'
		},
		{
			group: 'Pages',
			label: 'Plugins',
			detail: 'Plugin pool and updates',
			href: '/plugins',
			icon: 'plug'
		},
		{
			group: 'Pages',
			label: 'Ports',
			detail: 'Port allocations',
			href: '/network',
			icon: 'sitemap'
		},
		{
			group: 'Pages',
			label: 'Proxy routing',
			detail: 'Velocity routes',
			href: '/proxy',
			icon: 'route'
		},
		{
			group: 'Pages',
			label: 'Cleanup',
			detail: 'Reclaim disk space',
			href: '/cleanup',
			icon: 'broom'
		}
	];

	const GROUPS = ['Pages', 'Instances', 'Plugins'];

	const MAX_PER_GROUP = 5;

	let query = $state('');
	let open = $state(false);
	let cursor = $state(0);
	let loading = $state(false);
	let loaded = false;
	let resources: Hit[] = $state([]);
	let root: HTMLDivElement | undefined = $state();
	let input: HTMLInputElement | undefined = $state();

	/** Pull instances and plugins once, on first focus. A failure clears the flag
	 *  so the next focus retries. */
	async function load(): Promise<void> {
		if (loaded) {
			return;
		}

		loaded = true;
		loading = true;

		try {
			const [instanceBody, pluginBody] = (await Promise.all([
				fetch('/api/instances').then((res) => (res.ok ? res.json() : {})),
				fetch('/api/plugins').then((res) => (res.ok ? res.json() : {}))
			])) as [{ instances?: any[] }, { plugins?: any[] }];

			const instances: any[] = instanceBody?.instances ?? [];
			const plugins: any[] = pluginBody?.plugins ?? [];

			resources = [
				...instances.map((inst) => ({
					group: 'Instances',
					label: inst.name as string,
					detail: `${inst.software ?? 'instance'} · ${inst.state ?? 'unknown'}`,
					href: `/instances/${inst.name}`,
					icon: 'server'
				})),
				...plugins.map((plugin) => ({
					group: 'Plugins',
					label: plugin.plugin as string,
					detail: [
						plugin.sources?.join(', ') ?? 'plugin',
						plugin.families?.map((family: any) => family.family).join(', ') ?? ''
					]
						.filter(Boolean)
						.join(' · '),
					href: `/plugins/${encodeURIComponent(plugin.plugin)}`,
					icon: 'plug'
				}))
			];
		} catch {
			loaded = false;
		}

		loading = false;
	}

	const hits = $derived.by(() => {
		const needle = query.trim().toLowerCase();

		if (!needle) {
			return [];
		}

		const out: Hit[] = [];

		for (const group of GROUPS) {
			const pool = group === 'Pages' ? PAGES : resources;

			const matches = pool.filter((hit) => {
				if (hit.group !== group) {
					return false;
				}

				return (
					hit.label.toLowerCase().includes(needle) ||
					hit.detail.toLowerCase().includes(needle)
				);
			});

			out.push(...matches.slice(0, MAX_PER_GROUP));
		}

		return out;
	});

	$effect(() => {
		void hits;
		cursor = 0;
	});

	function pick(hit: Hit): void {
		open = false;
		query = '';
		input?.blur();
		goto(hit.href);
	}

	function onKeydown(event: KeyboardEvent): void {
		if (!open) {
			return;
		}

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			cursor = Math.min(cursor + 1, hits.length - 1);

			return;
		}

		if (event.key === 'ArrowUp') {
			event.preventDefault();
			cursor = Math.max(cursor - 1, 0);

			return;
		}

		if (event.key === 'Enter') {
			const hit = hits[cursor];

			if (hit) {
				pick(hit);
			}

			return;
		}

		if (event.key === 'Escape') {
			open = false;
			input?.blur();
		}
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		if (event.altKey && (event.key === 's' || event.key === 'S')) {
			event.preventDefault();
			input?.focus();
		}
	}

	function onWindowPointerDown(event: PointerEvent): void {
		if (open && root && !root.contains(event.target as Node)) {
			open = false;
		}
	}

	function onFocus(): void {
		open = true;
		void load();
	}
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerDown} />

<div class="gs" bind:this={root}>
	<span class="mg"><Icon name="search" size="0.875rem" /></span>
	<input
		bind:this={input}
		bind:value={query}
		placeholder="Search"
		aria-label="Search the console"
		autocomplete="off"
		onfocus={onFocus}
		oninput={() => (open = true)}
		onkeydown={onKeydown}
	/>
	<span class="hint">[Alt+S]</span>

	{#if open && query.trim()}
		<div class="results" role="listbox">
			{#if loading}
				<div class="note"><Spinner size="0.875rem" /> Loading resources…</div>
			{:else if hits.length === 0}
				<div class="note">No matches for “{query.trim()}”</div>
			{:else}
				{#each hits as hit, i (hit.group + hit.href)}
					{#if i === 0 || hits[i - 1]?.group !== hit.group}
						<div class="ghead">{hit.group}</div>
					{/if}
					<button
						class="hit"
						class:on={i === cursor}
						role="option"
						aria-selected={i === cursor}
						onpointerenter={() => (cursor = i)}
						onclick={() => pick(hit)}
					>
						<Icon name={hit.icon} size="0.875rem" style="solid" />
						<span class="hl">{hit.label}</span>
						<span class="hd">{hit.detail}</span>
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<style lang="scss">
	.gs {
		position: relative;
		display: flex;
		align-items: center;
		flex: 1;
		max-width: 45rem;
	}
	.mg {
		position: absolute;
		left: 0.75rem;
		color: var(--text-secondary);
		display: inline-flex;
		pointer-events: none;
	}
	input {
		width: 100%;
		height: 1.875rem;
		background: transparent;
		border: 0.125rem solid var(--border-field);
		border-radius: var(--radius-input);
		color: #ebebf0;
		font-family: var(--font);
		font-size: 0.875rem;
		padding: 0 4rem 0 2.25rem;
		outline: none;
	}
	input {
		&::placeholder {
			color: var(--text-secondary);
		}

		&:focus {
			border-color: var(--link);
		}
	}

	.hint {
		position: absolute;
		right: 0.75rem;
		color: var(--text-secondary);
		font-size: 0.75rem;
		pointer-events: none;
	}

	.results {
		position: absolute;
		top: calc(100% + 0.25rem);
		left: 0;
		right: 0;
		background: var(--bg-dropdown);
		border: 0.1rem solid var(--border);
		border-radius: 0.5rem;
		box-shadow: var(--shadow-dropdown);
		padding: 0.25rem 0;
		z-index: var(--z-menu);
		max-height: 26rem;
		overflow-y: auto;
		animation: fadein 0.1s ease-out;
	}
	.note {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 0.875rem;
		color: var(--text-secondary);
	}
	.ghead {
		padding: 0.5rem 0.875rem 0.25rem;
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--text-secondary);
	}
	.hit {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		width: 100%;
		padding: 0.375rem 0.875rem;
		background: none;
		border: none;
		color: var(--text);
		font-family: var(--font);
		font-size: 0.875rem;
		text-align: left;
		cursor: pointer;
	}
	.hit {
		&.on {
			background: var(--bg-hover);
		}

		// the leading glyph is an Icon instance, hence :global
		:global(icon) {
			color: var(--text-secondary);
			flex: none;
		}
	}

	.hl {
		color: var(--text-heading);
		white-space: nowrap;
	}

	.hd {
		@include ellipsis;

		color: var(--text-secondary);
		font-size: 0.8125rem;
	}
</style>
