<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { tagEntries, type TagMap } from './tageditor';

	/**
	 * A resource's tags as read-only `key=value` pills, dense enough for a table
	 * cell. `limit` caps how many are drawn; the rest become a "+N" pill whose
	 * tooltip lists them.
	 */

	let {
		tags,
		limit
	}: {
		tags: TagMap;
		limit?: number;
	} = $props();

	const entries = $derived(tagEntries(tags));
	const drawn = $derived(limit === undefined ? entries : entries.slice(0, limit));
	const rest = $derived(entries.slice(drawn.length));

	const restTitle = $derived(
		rest
			.map((entry) => (entry.value === '' ? entry.key : `${entry.key}=${entry.value}`))
			.join('\n')
	);
</script>

{#if entries.length === 0}
	<span class="dim">–</span>
{:else}
	<span class="chips">
		{#each drawn as entry (entry.key)}
			<span class="chip mono" title="{entry.key}={entry.value}">
				<span class="k">{entry.key}</span>
				{#if entry.value !== ''}
					<span class="v">={entry.value}</span>
				{/if}
			</span>
		{/each}

		{#if rest.length > 0}
			<span class="chip more" title={restTitle}>{t('web.resourceMeta.moreTags', { count: rest.length })}</span>
		{/if}
	</span>
{/if}

<style lang="scss">
	.chips {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		min-width: 0;
	}

	.chip {
		display: inline-flex;
		max-width: 16rem;
		font-size: 0.6875rem;
		line-height: 1rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.75rem;
		padding: 0.0625rem 0.5rem;

		.k {
			@include ellipsis;

			color: var(--text-heading);
		}

		.v {
			@include ellipsis;

			color: var(--text-secondary);
		}

		&.more {
			color: var(--text-secondary);
		}
	}
</style>
