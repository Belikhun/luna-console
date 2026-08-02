<script lang="ts">
	import type { Snippet } from 'svelte';

	/** One cell in an OverviewBar: bold label, value line, optional progress bar. */
	let {
		label,
		progress,
		progressColor = 'var(--success)',
		children
	}: {
		label: string;
		/** 0..1 */
		progress?: number;
		progressColor?: string;
		children: Snippet;
	} = $props();
</script>

<div class="ovc">
	<div class="l">{label}</div>
	{#if progress !== undefined}
		<div class="bar">
			<div
				class="fill"
				style:width="{Math.round(progress * 100)}%"
				style:background={progressColor}
			></div>
		</div>
	{/if}
	<div class="v">{@render children()}</div>
</div>

<style lang="scss">
	.l {
		font-weight: 700;
		color: var(--text-heading);
		font-size: 0.875rem;
		margin-bottom: 0.25rem;
	}

	.v {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.bar {
		height: 0.5rem;
		background: var(--bg-bar);
		border-radius: 0.25rem;
		overflow: hidden;
		margin: 0.375rem 0;
	}

	.fill {
		height: 100%;
		border-radius: 0.25rem;
		transition: width 0.4s ease;
	}
</style>
