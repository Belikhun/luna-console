<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';

	/**
	 * Every screen under one instance (its tabs, console, files and player pages)
	 * reads that instance when it mounts. SvelteKit keeps a page mounted when only
	 * a parameter in the address changes, so moving straight to another instance
	 * would keep showing the previous one: its header until the next poll, every
	 * tab already opened, and any answer still in flight. Keying on the name mounts
	 * a fresh page instead, and late answers for the old one land on a component
	 * that no longer exists.
	 */
	let { children }: { children: Snippet } = $props();
</script>

{#key page.params.name}
	{@render children()}
{/key}
