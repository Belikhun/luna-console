<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { actorHref } from '$lib/resourcemeta.svelte';

	/**
	 * Who created or changed a resource: a link to the account when the actor is
	 * one, plain text for `root` (the CLI) and MCP tokens, a dash when nothing
	 * was recorded.
	 */

	let {
		name
	}: {
		name: string | null | undefined;
	} = $props();

	const href = $derived(actorHref(name));
</script>

{#if !name}
	<span class="dim">–</span>
{:else if href}
	<a {href}>{name}</a>
{:else}
	<span class="mono">{name}</span>
{/if}
