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

<!-- Declared here rather than in app.html: these are the only screens built to
     reflow, and the console next door is deliberately left at its natural width
     on a phone instead of collapsing into overlapping panels. -->
<svelte:head>
	<meta name="viewport" content="width=device-width, initial-scale=1" />
</svelte:head>

<TooltipHost />

{@render children()}

<style lang="scss">
	// The rem scale is the whole design system, so one root size is the honest way
	// to make a phone fit more of it: every length, gap and radius comes down
	// together and the proportions survive. 75% of the 16px default is 12px; it is
	// written as a percentage because a root font-size is the anchor the rem scale
	// is measured against and cannot be expressed in the unit it defines.
	//
	// Global, but scoped by lifetime: it applies while a public page is mounted and
	// goes away with it, so the console is untouched even in the same tab.
	@include below($bp-narrow) {
		:global(html) {
			font-size: 75%;
		}
	}
</style>
