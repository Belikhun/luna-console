<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';

	/**
	 * The same remount as the instance layout above, one level down: moving from
	 * one player to another on the same instance mounts a fresh page rather than
	 * showing the previous player's save until the new one is read.
	 */
	let { children }: { children: Snippet } = $props();
</script>

{#key page.params.player}
	{@render children()}
{/key}
