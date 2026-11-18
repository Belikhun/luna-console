<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	/**
	 * A link that leaves the current screen for another one. The trailing mark
	 * tells it apart from links that only switch a tab or a view in place.
	 */
	let {
		href,
		class: className = '',
		children
	}: {
		href: string;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<a class="screen-link {className}" {href}><span class="lt">{@render children()}</span><Icon name="arrowUpRightFromSquare" size="0.75em" /></a>

<style lang="scss">
	// the global link rule moves the underline onto `.lt` once an icon is inside
	.screen-link {
		display: inline-flex;
		align-items: center;
		gap: 0.375em;
	}
</style>
