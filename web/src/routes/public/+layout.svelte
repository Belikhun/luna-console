<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import TooltipHost from '$lib/components/TooltipHost.svelte';
	import { setAssetBase } from '$lib/components/mcassets';

	/**
	 * The public page's shell.
	 *
	 * Almost nothing: the root layout already renders this subtree bare, and the
	 * two screens want different chrome (the home page has a masthead and a
	 * footer, the server view is a full-screen map with panels floating over it).
	 * The tooltip host is the one thing both need, since the uptime timeline is on
	 * both and every slot carries its day.
	 */
	let { children } = $props();

	// the block icons on the server cards come from the ungated mirror; a visitor
	// has no session, so the console's own asset routes would 401 for every one
	setAssetBase('/api/public/assets');
</script>

<TooltipHost />

{@render children()}
