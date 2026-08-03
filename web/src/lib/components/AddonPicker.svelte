<script lang="ts">
	import type { Snippet } from 'svelte';
	import { api } from '$lib/api';
	import Icon from './Icon.svelte';
	import Btn from './Btn.svelte';
	import SearchInput from './SearchInput.svelte';
	import BrandIcon from './BrandIcon.svelte';
	import {
		ADDON_PROVIDERS,
		providerAvailability,
		type AddonHit,
		type AddonKindType,
		type AddonProvider
	} from './addons';

	/**
	 * The provider-search half of every install dialog: the provider tabs, a
	 * query row (with an optional extra control, e.g. the plugin loader), and a
	 * results list that always shows *some* state — idle, searching, failed,
	 * nothing found, or hits. One project is picked at a time; the caller reads
	 * the slug (and the id, for providers whose slug alone cannot be looked up).
	 *
	 * Searching happens on Enter, on the button, and — debounced — as the query
	 * is typed, so the dialog answers without a deliberate second click.
	 *
	 * The tabs are the providers hosting this `kind` of addon; whether each is
	 * usable right now comes from the daemon (`/api/providers`) — CurseForge
	 * stays greyed with the reason until an API key is configured.
	 */
	let {
		endpoint,
		kind = 'plugin',
		params = {},
		selected = $bindable(''),
		provider = $bindable('modrinth'),
		placeholder = 'Search by name…',
		toolbar,
		onpick
	}: {
		/** Console API path answering `{ hits }`, e.g. "/plugins/search" */
		endpoint: string;
		/** Addon type being installed — filters which provider tabs appear */
		kind?: AddonKindType;
		/** Extra query parameters merged into every request */
		params?: Record<string, string>;
		/** Slug of the picked project; empty when nothing is selected */
		selected?: string;
		/** Provider being searched (bindable — the caller may preselect one) */
		provider?: string;
		placeholder?: string;
		/** Rendered between the field and the Search button */
		toolbar?: Snippet;
		/** Called with the full hit whenever the selection changes */
		onpick?: (hit: AddonHit | undefined) => void;
	} = $props();

	let providers: AddonProvider[] = $state(
		ADDON_PROVIDERS.filter((entry) => entry.types.includes(kind))
	);

	// overlay the daemon's live availability once it answers
	$effect(() => {
		providerAvailability().then((list) => {
			providers = list.filter((entry) => entry.types.includes(kind));
		});
	});

	const current = $derived(providers.find((entry) => entry.id === provider) ?? providers[0]!);

	let query = $state('');
	let hits: AddonHit[] = $state([]);
	let searching = $state(false);
	let failed = $state('');
	/** whether a search has completed at least once, to tell idle from empty */
	let ran = $state(false);

	/** the query the newest request was issued for — older answers are dropped */
	let inflight = '';

	async function search(): Promise<void> {
		const term = query.trim();

		if (!current.available) {
			return;
		}

		if (!term) {
			hits = [];
			ran = false;

			return;
		}

		const qs = `${new URLSearchParams({ q: term, provider: current.id, ...params })}`;

		inflight = qs;
		searching = true;
		failed = '';

		try {
			const res = await api(`${endpoint}?${qs}`);

			// a slower earlier request must not overwrite a newer answer
			if (inflight !== qs) {
				return;
			}

			hits = res.hits ?? [];
			ran = true;
		} catch (err) {
			failed = (err as Error).message;
			hits = [];
		}

		searching = false;
	}

	// typing searches on its own after a pause; the button and Enter still work
	// for anyone who does not wait
	$effect(() => {
		const term = query.trim();

		void provider;

		if (term.length < 2 || !current.available) {
			return;
		}

		const id = setTimeout(() => void search(), 450);

		return () => clearTimeout(id);
	});

	/** Switching provider drops the picked project — a slug belongs to one. */
	function choose(id: string): void {
		if (provider === id) {
			return;
		}

		provider = id;
		selected = '';
		hits = [];
		ran = false;
		failed = '';
		onpick?.(undefined);
	}

	function pick(hit: AddonHit): void {
		selected = selected === hit.slug ? '' : hit.slug;
		onpick?.(hits.find((candidate) => candidate.slug === selected));
	}

	/** Download counts run to eight digits — abbreviate rather than wrap. */
	function compact(count: number): string {
		if (count >= 1_000_000) {
			return `${(count / 1_000_000).toFixed(1)}M`;
		}

		if (count >= 1_000) {
			return `${Math.round(count / 1_000)}k`;
		}

		return String(count);
	}
</script>

<div class="picker">
	<div class="tabs" role="tablist">
		{#each providers as entry (entry.id)}
			<button
				type="button"
				role="tab"
				class="tab"
				class:on={provider === entry.id}
				class:soon={!entry.available}
				aria-selected={provider === entry.id}
				title={entry.note}
				onclick={() => choose(entry.id)}
			>
				<BrandIcon name={entry.id} size="0.875rem" />
				{entry.label}
				{#if !entry.available}<span class="badge">off</span>{/if}
			</button>
		{/each}
	</div>

	<div class="bar">
		<div class="qfield">
			<SearchInput
				bind:value={query}
				{placeholder}
				width="100%"
				focus
				onenter={() => void search()}
			/>
		</div>
		{#if toolbar}{@render toolbar()}{/if}
		<Btn
			icon="search"
			loading={searching}
			disabled={!query.trim() || !current.available}
			onclick={() => void search()}
		>
			Search
		</Btn>
	</div>

	<div class="results">
		{#if !current.available}
			<div class="state">
				<BrandIcon name={current.id} size="1.25rem" />
				<span class="dim">
					{current.label} is not available — {current.note ?? 'not connected yet'}. Install from
					another provider, or upload the file yourself.
				</span>
			</div>
		{:else if failed}
			<div class="state bad">
				<Icon name="triangleExclamation" size="1.25rem" />
				<div>
					<b>{current.label} search failed</b>
					<div class="dim">{failed}</div>
				</div>
			</div>
		{:else if searching && !hits.length}
			<div class="state">
				<Icon name="rotate" size="1.25rem" spin />
				<span class="dim">Searching {current.label}…</span>
			</div>
		{:else if !ran}
			<div class="state">
				<Icon name="search" size="1.25rem" />
				<span class="dim">Type a name to search {current.label}.</span>
			</div>
		{:else if !hits.length}
			<div class="state">
				<Icon name="box" size="1.25rem" />
				<span class="dim">Nothing on {current.label} matches “{query.trim()}”.</span>
			</div>
		{:else}
			<div class="list" class:stale={searching}>
				{#each hits as hit (hit.project_id)}
					<button
						type="button"
						class="hit"
						class:sel={selected === hit.slug}
						onclick={() => pick(hit)}
					>
						{#if hit.icon_url}
							<img class="ico" src={hit.icon_url} alt="" loading="lazy" />
						{:else}
							<span class="ico blank"><Icon name="cube" size="1rem" /></span>
						{/if}
						<span class="body">
							<span class="head">
								<b class="title">{hit.title}</b>
								{#if hit.author}<span class="dim by">by {hit.author}</span>{/if}
								<span class="dl dim">
									<Icon name="download" size="0.6875rem" />
									{compact(hit.downloads)}
								</span>
							</span>
							<span class="desc dim">{hit.description}</span>
						</span>
						{#if selected === hit.slug}
							<span class="tick"><Icon name="circleCheck" size="1rem" style="solid" /></span>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style lang="scss">
	.picker {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	// provider tabs: the same underline-on-active shape the detail views use
	.tabs {
		display: flex;
		gap: 0.25rem;
		border-bottom: var(--hairline) solid var(--border-divider);
	}

	.tab {
		@include bare-button;

		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 0.75rem;
		color: var(--text-secondary);
		font-size: 0.875rem;
		font-weight: 700;
		border-bottom: 0.125rem solid transparent;
		margin-bottom: calc(-1 * var(--hairline));

		&:hover {
			color: var(--text-heading);
		}

		&.on {
			color: var(--link);
			border-bottom-color: var(--link);
		}

		// a provider that is still only a promise reads as one, quietly
		&.soon {
			color: var(--text-disabled);

			&.on {
				color: var(--text-secondary);
				border-bottom-color: var(--text-disabled);
			}
		}
	}

	.badge {
		font-size: 0.625rem;
		font-weight: 400;
		text-transform: uppercase;
		letter-spacing: 0.03125rem;
		padding: 0 0.25rem;
		border: var(--hairline) solid var(--border);
		border-radius: 0.25rem;
	}

	.qfield {
		flex: 1;
		min-width: 0;
	}

	// a fixed band: the dialog must not resize under the pointer as answers
	// arrive, and a long result list scrolls inside it
	.results {
		min-height: 13.75rem;
		max-height: 21.25rem;
		overflow-y: auto;
		border: var(--hairline) solid var(--border-divider);
		border-radius: var(--radius-input);
		background: var(--bg-input);
	}

	.state {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		min-height: 13.75rem;
		padding: 1rem;
		color: var(--text-secondary);
		text-align: center;

		&.bad {
			color: var(--error);
			text-align: left;
		}
	}

	.list {
		display: flex;
		flex-direction: column;
		padding: 0.25rem;
		gap: 0.25rem;

		// a re-search keeps the old hits visible, dimmed, instead of blanking out
		&.stale {
			opacity: 0.5;
		}
	}

	.hit {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.5rem;
		border: var(--border-control) solid transparent;
		border-radius: var(--radius-input);
		background: transparent;
		color: var(--text);
		font-family: var(--font);
		font-size: 0.875rem;
		text-align: left;
		cursor: pointer;

		&:hover {
			background: var(--bg-hover);
		}

		&.sel {
			border-color: var(--link);
			background: var(--bg-selected);
		}

		&:focus-visible {
			@include focus-ring;
		}
	}

	.ico {
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-input);
		object-fit: cover;
		flex: none;
		background: var(--bg-panel);

		&.blank {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			color: var(--text-disabled);
		}
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
		flex: 1;
	}

	.head {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}

	.title {
		color: var(--text-heading);
		@include ellipsis;
	}

	.by {
		font-size: 0.75rem;
		flex: none;
	}

	.dl {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		margin-left: auto;
		flex: none;
	}

	// two lines of blurb, then clipped — hits stay a scannable fixed height
	.desc {
		font-size: 0.75rem;
		line-height: 1.125rem;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}

	.tick {
		color: var(--link);
		flex: none;
	}
</style>
