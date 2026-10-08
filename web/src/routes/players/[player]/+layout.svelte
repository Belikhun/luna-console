<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';

	/**
	 * A player's page reads that player when it mounts, and SvelteKit keeps it
	 * mounted when only the player in the address changes. Without the key, moving
	 * straight to another player would keep the previous one's header and every tab
	 * already opened until each was fetched again, and a late answer could still
	 * paint over the new player. Keying on the parameter mounts a fresh page.
	 */
	let { children }: { children: Snippet } = $props();
</script>

{#key page.params.player}
	{@render children()}
{/key}
