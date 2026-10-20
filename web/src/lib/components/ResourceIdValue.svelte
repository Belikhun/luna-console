<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { resourceIdList } from '$lib/resourceid';

	import CopyValue from './CopyValue.svelte';

	/**
	 * A resource id (`luna:<type>/<name>`) with its copy affordance, rendered the
	 * same in a table cell and in a summary grid. Several ids (a plugin spanning
	 * families) stack, one per line, each copyable on its own.
	 */
	let {
		value,
		label
	}: {
		value: string | string[] | null | undefined;
		/** names the value for the copy button's accessible label */
		label?: string;
	} = $props();

	const ids = $derived(resourceIdList(value));
</script>

{#if ids.length === 0}
	<span class="dim">–</span>
{:else}
	<span class="ids">
		{#each ids as id (id)}
			<CopyValue value={id} label={label ?? t('web.resourceId.label')} />
		{/each}
	</span>
{/if}

<style lang="scss">
	.ids {
		display: inline-flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}
</style>
