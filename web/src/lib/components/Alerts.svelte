<script lang="ts">
	import Icon from './Icon.svelte';

	/** Combined log-alert readout: `⚠ N warning(s) | ⨯ N error(s)`. */
	let {
		warnings,
		errors
	}: {
		warnings: number;
		errors: number;
	} = $props();
</script>

<span class="alerts">
	<span class="seg warn" class:none={!warnings}>
		<Icon name="triangleExclamation" size="0.75rem" style="solid" />
		{warnings} warning(s)
	</span>
	<span class="sep">|</span>
	<span class="seg err" class:none={!errors}>
		<Icon name="circleXMark" size="0.75rem" style="solid" />
		{errors} error(s)
	</span>
</span>

<style lang="scss">
	.alerts {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.seg {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;

		&.warn {
			color: var(--warning);
		}

		&.err {
			color: var(--error);
		}

		// a zero keeps its tint but recedes
		&.none {
			opacity: 0.45;
		}
	}

	.sep {
		color: var(--border-divider);
	}
</style>
