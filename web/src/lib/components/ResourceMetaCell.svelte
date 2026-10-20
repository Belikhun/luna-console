<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { ResourceMetaIndex } from '$lib/resourcemeta.svelte';
	import OwnerCell from './OwnerCell.svelte';
	import TagChips from './TagChips.svelte';

	/**
	 * The cell of a list screen's metadata columns (`resourceMetaColumns()`):
	 * `createdBy` draws the creator, `tags` the tag pills. A row standing for
	 * several resources passes all their names.
	 */

	let {
		index,
		names,
		col
	}: {
		index: ResourceMetaIndex;
		names: string | string[];
		col: string;
	} = $props();

	const owners = $derived(index.owners(names));
</script>

{#if col === 'createdBy'}
	{#if owners.length === 0}
		<OwnerCell name={null} />
	{:else}
		{#each owners as owner, position (owner)}
			{#if position > 0}<span class="dim">, </span>{/if}
			<OwnerCell name={owner} />
		{/each}
	{/if}
{:else if col === 'tags'}
	<TagChips tags={index.mergedTags(names)} limit={3} />
{/if}
