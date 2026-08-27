<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * A tab bar. A tab carrying an `href` is rendered as a real link rather than a
	 * button, which is what lets it be opened in a new tab, copied, or named in a
	 * breadcrumb; without one it stays a button that only flips `active`.
	 *
	 * Both shapes are kept because not every tab bar addresses a URL - some sit
	 * inside a dialog, where there is nowhere to navigate to.
	 */
	let {
		tabs,
		active = $bindable()
	}: {
		tabs: Array<{ id: string; label: string; href?: string }>;
		active: string;
	} = $props();
</script>

<div class="tabs" role="tablist">
	{#each tabs as tab}
		{#if tab.href}
			<a
				role="tab"
				class="tab"
				class:active={active === tab.id}
				aria-selected={active === tab.id}
				href={tab.href}
			>{tab.label}</a>
		{:else}
			<button
				role="tab"
				class="tab"
				class:active={active === tab.id}
				aria-selected={active === tab.id}
				onclick={() => (active = tab.id)}
			>{tab.label}</button>
		{/if}
	{/each}
</div>

<style lang="scss">
	// The active indicator is a 0.25rem bar overlapping the
	// container's bottom rule; it must not be clipped by the scroll box, so the
	// indicator lives inside the tab and the rule sits under it.
	.tabs {
		display: flex;
		gap: 0.5rem;
		border-bottom: 0.1rem solid var(--border-divider);
		overflow-x: auto;
		overflow-y: hidden;
	}

	// `a.tab` opts out of the chrome-link styling on purpose: a tab is chrome, and
	// the underline convention is for links that navigate *within* content
	.tab {
		position: relative;
		display: inline-block;
		background: none;
		border: none;
		color: var(--text-heading);
		font-family: var(--font);
		font-size: 0.875rem;
		font-weight: 700;
		padding: 0.625rem 1rem;
		cursor: pointer;
		white-space: nowrap;
		text-decoration: none;

		&::after {
			content: '';
			position: absolute;
			left: 0;
			right: 0;
			bottom: 0;
			height: 0.25rem;
			background: transparent;
		}

		&:hover {
			color: var(--link);
		}

		&.active {
			color: var(--link);

			&::after {
				background: var(--link);
			}
		}
	}
</style>
