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
	 *
	 * Tabs that do not fit stay on one line and the bar scrolls sideways, with
	 * the active tab brought into view. They used to wrap into rows with the
	 * active row moved last, the way a Windows property sheet does; on a narrow
	 * screen that reordered the tabs under the reader's finger, so they keep
	 * their order instead.
	 */
	let {
		tabs,
		active = $bindable()
	}: {
		tabs: Array<{ id: string; label: string; href?: string }>;
		active: string;
	} = $props();

	type Tab = (typeof tabs)[number];

	let bar: HTMLDivElement | undefined = $state();

	// the active tab is scrolled into view whenever it changes, never the page
	$effect(() => {
		void active;

		const tab = bar?.querySelector<HTMLElement>('.tab.active');

		if (!bar || !tab) {
			return;
		}

		// the bar is positioned, so a tab's offset is already measured from it
		const left = tab.offsetLeft;
		const right = left + tab.offsetWidth;

		if (left < bar.scrollLeft || right > bar.scrollLeft + bar.clientWidth) {
			bar.scrollTo({ left: Math.max(0, left - 16) });
		}
	});
</script>

{#snippet tabCell(tab: Tab)}
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
{/snippet}

<div class="tabs" role="tablist" bind:this={bar}>
	{#each tabs as tab (tab.id)}
		{@render tabCell(tab)}
	{/each}
</div>

<style lang="scss">
	// The active indicator is a 0.25rem bar overlapping the container's bottom
	// rule, so the indicator lives inside the tab and the rule sits under it.
	.tabs {
		position: relative;
		display: flex;
		flex-wrap: nowrap;
		gap: 0.5rem;
		overflow-x: auto;
		overflow-y: hidden;
		border-bottom: 0.1rem solid var(--border-divider);
		scrollbar-width: none;

		&::-webkit-scrollbar {
			display: none;
		}
	}

	// `a.tab` opts out of the chrome-link styling on purpose: a tab is chrome, and
	// the underline convention is for links that navigate *within* content
	.tab {
		position: relative;
		display: inline-block;
		flex: none;
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
