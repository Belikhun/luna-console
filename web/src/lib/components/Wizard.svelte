<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import PageHeader from './PageHeader.svelte';
	import Btn from './Btn.svelte';

	/**
	 * The console's one wizard shell; every create flow (launch instance,
	 * create schedule, create addon group) renders through this: the page
	 * header, a single column of panels, and a sticky summary bar whose dim
	 * recap and primary submit stay reachable while the form scrolls.
	 */
	let {
		title,
		description,
		windowTitle = title,
		submitLabel,
		disabled = false,
		loading = false,
		onsubmit,
		summary,
		children
	}: {
		title: string;
		description?: string;
		/** browser-tab title; defaults to `title` */
		windowTitle?: string;
		/** the primary button's label, e.g. "Launch instance" */
		submitLabel: string;
		/** blocks submit; a validation failure, a missing required field */
		disabled?: boolean;
		/** the submit is in flight */
		loading?: boolean;
		onsubmit: () => void;
		/** the dim recap line in the sticky bar */
		summary: Snippet;
		children: Snippet;
	} = $props();
</script>

<svelte:head><title>{windowTitle} | Luna Console</title></svelte:head>

<PageHeader {title} {description} />

<div class="wizard">
	{@render children()}

	<div class="bar">
		<span class="recap dim">{@render summary()}</span>
		<Btn variant="primary" {disabled} {loading} onclick={onsubmit}>
			{submitLabel}
		</Btn>
	</div>
</div>

<style lang="scss">
	.wizard {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 52rem;
	}

	// the summary bar stays reachable while the form scrolls; the translucent
	// ground + blur keeps the content scrolling under it legible
	.bar {
		position: sticky;
		bottom: 0;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;

		padding: 0.75rem 1.25rem;
		background: color-mix(in srgb, var(--bg-panel) 60%, transparent);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);

		backdrop-filter: blur(1rem) brightness(0.9);
		z-index: 10;
	}

	.recap {
		min-width: 0;
	}
</style>
