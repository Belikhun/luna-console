<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { api } from '$lib/api';
	import Icon from './Icon.svelte';
	import SearchInput from './SearchInput.svelte';
	import PlayerSkin from './PlayerSkin.svelte';

	/**
	 * A single-player picker for dialogs: a query box over the player
	 * directory with an avatar on every hit, and the typed text itself staying
	 * valid input, so a UUID or a name the directory has never seen is still
	 * submittable as entered.
	 *
	 * `value` is what the caller submits: the picked player's UUID, or the raw
	 * query text while nothing is picked. Editing the query drops the pick,
	 * because edited text means the raw entry is the intent again.
	 */

	interface DirectoryPlayer {
		uuid: string;
		username: string;
		online?: boolean;
		server?: string;
	}

	let {
		value = $bindable(''),
		placeholder = t('web.playerPicker.placeholder'),
		pickValue = 'uuid',
		onpick
	}: {
		value?: string;
		placeholder?: string;
		/** which field of a picked player becomes `value`; consumers whose
		 *  backend wants a name (vanilla commands) ask for the username */
		pickValue?: 'uuid' | 'username';
		/** the full picked player, null when the pick is cleared; for callers
		 *  that need both the name and the exact profile id */
		onpick?: (player: { uuid: string; username: string } | null) => void;
	} = $props();

	let query = $state('');
	let hits: DirectoryPlayer[] = $state([]);
	let picked: DirectoryPlayer | null = $state(null);
	let searching = $state(false);
	let unavailable = $state(false);

	/** the query the newest request was issued for; older answers are dropped */
	let inflight = '';

	async function search(term: string): Promise<void> {
		const qs = `${new URLSearchParams({ search: term, limit: '8' })}`;

		inflight = qs;
		searching = true;

		try {
			const res = await api(`/players?${qs}`);

			// a slower earlier request must not overwrite a newer answer
			if (inflight !== qs) {
				return;
			}

			unavailable = res.available === false;
			hits = res.players ?? [];
		} catch {
			unavailable = true;
			hits = [];
		}

		searching = false;
	}

	// not state on purpose: the effect must depend on the query alone, or the
	// pick it writes would re-trigger it and immediately unpick again
	let lastTerm: string | null = null;

	// typing searches on its own after a pause; the very first run fetches the
	// directory's front page immediately, so the dialog opens with choices
	$effect(() => {
		const term = query.trim();

		if (term === lastTerm) {
			return;
		}

		const first = lastTerm === null;

		lastTerm = term;

		if (!first) {
			if (picked) {
				picked = null;
				onpick?.(null);
			}

			value = term;
		}

		const id = setTimeout(() => void search(term), first ? 0 : 300);

		return () => clearTimeout(id);
	});

	function pick(hit: DirectoryPlayer): void {
		if (picked?.uuid === hit.uuid) {
			picked = null;
			value = query.trim();
			onpick?.(null);

			return;
		}

		picked = hit;
		value = pickValue === 'username' ? hit.username : hit.uuid;
		onpick?.({ uuid: hit.uuid, username: hit.username });
	}
</script>

<div class="picker">
	<SearchInput bind:value={query} {placeholder} width="100%" focus />

	<div class="results">
		{#if unavailable}
			<div class="state">
				<Icon name="triangleExclamation" size="1.25rem" />
				<span class="dim">{t('web.playerPicker.unavailable')}</span>
			</div>
		{:else if searching && !hits.length}
			<div class="state">
				<Icon name="rotate" size="1.25rem" spin />
				<span class="dim">{t('web.playerPicker.searching')}</span>
			</div>
		{:else if !hits.length}
			<div class="state">
				<Icon name="userSlash" size="1.25rem" />
				<span class="dim">{t('web.playerPicker.noMatches', { query: query.trim() })}</span>
			</div>
		{:else}
			<div class="list" class:stale={searching}>
				{#each hits as hit (hit.uuid)}
					<button
						type="button"
						class="hit"
						class:sel={picked?.uuid === hit.uuid}
						onclick={() => pick(hit)}
					>
						<PlayerSkin player={hit.uuid} view="face" px={4} />
						<span class="body">
							<b class="name">{hit.username}</b>
							<span class="uuid mono dim">{hit.uuid}</span>
						</span>
						{#if hit.online && hit.server}
							<span class="where dim">{t('web.playerPicker.onServer', { server: hit.server })}</span>
						{/if}
						{#if picked?.uuid === hit.uuid}
							<span class="tick"><Icon name="circleCheck" size="1rem" style="solid" /></span>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</div>

	{#if picked}
		<div class="will">
			<Icon name="circleCheck" size="0.875rem" style="solid" />
			{t('web.playerPicker.selected', { name: picked.username })}
		</div>
	{:else if value.trim()}
		<div class="will dim">
			<Icon name="inputText" size="0.875rem" />
			{t('web.playerPicker.asTyped', { text: value.trim() })}
		</div>
	{/if}
</div>

<style lang="scss">
	.picker {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	// a fixed band: the dialog must not resize under the pointer as answers
	// arrive, and a long result list scrolls inside it
	.results {
		min-height: 10rem;
		max-height: 16rem;
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
		min-height: 10rem;
		padding: 1rem;
		color: var(--text-secondary);
		text-align: center;
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
		padding: 0.375rem 0.5rem;
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

	.body {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		min-width: 0;
		flex: 1;
	}

	.name {
		color: var(--text-heading);
		@include ellipsis;
	}

	.uuid {
		font-size: 0.75rem;
		@include ellipsis;
	}

	.where {
		font-size: 0.75rem;
		flex: none;
	}

	.tick {
		color: var(--link);
		flex: none;
	}

	// what the footer's verb will act on, said in one quiet line
	.will {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.875rem;

		&:not(.dim) {
			color: var(--link);
		}
	}
</style>
