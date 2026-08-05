<script lang="ts">
	let {
		tabs,
		active = $bindable()
	}: { tabs: Array<{ id: string; label: string }>; active: string } = $props();
</script>

<div class="tabs" role="tablist">
	{#each tabs as tab}
		<button
			role="tab"
			class="tab"
			class:active={active === tab.id}
			aria-selected={active === tab.id}
			onclick={() => (active = tab.id)}
		>{tab.label}</button>
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

	.tab {
		position: relative;
		background: none;
		border: none;
		color: var(--text-heading);
		font-family: var(--font);
		font-size: 0.875rem;
		font-weight: 700;
		padding: 0.625rem 1rem;
		cursor: pointer;
		white-space: nowrap;

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
