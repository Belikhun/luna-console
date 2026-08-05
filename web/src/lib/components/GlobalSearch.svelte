<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { goto } from '$app/navigation';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';
	import { score } from '$lib/search/match';
	import { SEARCH_PROVIDERS, loadSearchIndex, type SearchHit } from '$lib/search/providers';

	/**
	 * Top-navigation search: the console's unified jump box. Everything in the
	 * cluster is indexed through the provider registry (DESIGN.md §5.3), pulled
	 * once on first focus and cached, so opening the box costs nothing until it
	 * is actually used.
	 *
	 * Keyboard: Alt+S focuses it from anywhere, up/down move the highlighted hit
	 * and keep it in view, Enter opens it, Escape closes and hands focus back to
	 * wherever it came from.
	 */
	type Hit = SearchHit;

	/** Groups render in registry order, so the index defines the ranking. */
	const GROUPS = SEARCH_PROVIDERS.map((provider) => provider.group);

	const MAX_PER_GROUP = 5;

	let query = $state('');
	let open = $state(false);
	let cursor = $state(0);
	let loading = $state(false);
	let loaded = false;
	let resources: Hit[] = $state([]);
	let root: HTMLDivElement | undefined = $state();
	let input: HTMLInputElement | undefined = $state();
	let listEl: HTMLDivElement | undefined = $state();

	/** Where focus was before Alt+S took it, so Escape can give it back. */
	let returnFocus: HTMLElement | null = null;

	/** Pull every provider once, on first focus. A failure clears the flag
	 *  so the next focus retries. */
	async function load(): Promise<void> {
		if (loaded) {
			return;
		}

		loaded = true;
		loading = true;

		try {
			resources = await loadSearchIndex();
		} catch {
			loaded = false;
		}

		loading = false;
	}

	const hits = $derived.by(() => {
		const needle = query.trim();

		if (!needle) {
			return [];
		}

		const out: Hit[] = [];

		// grouped in registry order, each group ranked on its own so a strong
		// match in a later group is not buried by weak ones in an earlier one
		for (const group of GROUPS) {
			const scored: Array<{ hit: Hit; rank: number }> = [];

			for (const hit of resources) {
				if (hit.group !== group) {
					continue;
				}

				const rank = Math.max(score(hit.label, needle), score(`${hit.label} ${hit.detail}`, needle) - 0.5);

				if (rank > 0) {
					scored.push({ hit, rank });
				}
			}

			scored.sort((a, b) => b.rank - a.rank);
			out.push(...scored.slice(0, MAX_PER_GROUP).map((entry) => entry.hit));
		}

		return out;
	});

	$effect(() => {
		void hits;
		cursor = 0;
	});

	// the highlighted hit has to stay visible while the arrows walk past the
	// bottom of the scrolling panel
	$effect(() => {
		void cursor;

		listEl?.querySelector<HTMLElement>('.hit.on')?.scrollIntoView({ block: 'nearest' });
	});

	function pick(hit: Hit): void {
		open = false;
		query = '';
		returnFocus = null;
		input?.blur();
		goto(hit.href);
	}

	/** Close the box and hand focus back to whatever had it before Alt+S. */
	function dismiss(): void {
		open = false;
		input?.blur();

		returnFocus?.focus();
		returnFocus = null;
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
			dismiss();
		}
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		if (event.altKey && (event.key === 's' || event.key === 'S')) {
			event.preventDefault();

			const from = document.activeElement;

			returnFocus = from instanceof HTMLElement && from !== input ? from : null;

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
		placeholder={t('web.common.search')}
		aria-label="Search the console"
		autocomplete="off"
		onfocus={onFocus}
		oninput={() => (open = true)}
		onkeydown={onKeydown}
	/>
	<span class="hint">[Alt+S]</span>

	{#if open && query.trim()}
		<div class="results" role="listbox" bind:this={listEl}>
			{#if loading}
				<div class="note"><Spinner size="0.875rem" /> Loading resources…</div>
			{:else if hits.length === 0}
				<div class="note">{t('web.search.noMatches', { query: query.trim() })}</div>
			{:else}
				<!-- keyed by position, deliberately: providers are an open registry, and
				     two distinct objects legitimately share group + label + href (the
				     proxy's 25565/tcp and the external sandbox's both land on
				     /network?q=25565). Any key built from hit fields is a duplicate-key
				     crash waiting for whoever adds the next provider. -->
				{#each hits as hit, i (i)}
					{#if i === 0 || hits[i - 1]?.group !== hit.group}
						<div class="ghead">{t(hit.group)}</div>
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
