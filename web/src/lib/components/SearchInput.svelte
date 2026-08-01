<script lang="ts">
	import Icon from './Icon.svelte';

	/** Filter box: magnifier icon inside a rounded input. */
	let {
		value = $bindable(''),
		placeholder = 'Find resources',
		width = '30rem'
	}: { value: string; placeholder?: string; width?: string } = $props();
</script>

<div class="search" style:max-width={width}>
	<span class="mg"><Icon name="search" size="0.75rem" /></span>
	<input {placeholder} bind:value />
	{#if value}
		<button class="clear" onclick={() => (value = '')} title="Clear">
			<Icon name="close" size="0.75rem" />
		</button>
	{/if}
</div>

<style lang="scss">
	.search {
		position: relative;
		display: flex;
		align-items: center;
		width: 100%;
	}
	.mg {
		position: absolute;
		left: 0.75rem;
		color: var(--text-secondary);
		display: inline-flex;
		pointer-events: none;
	}
	input {
		background: var(--bg-input);
		border: 0.125rem solid var(--border-input);
		border-radius: var(--radius-input);
		color: var(--text);
		font-family: var(--font);
		font-size: 0.875rem;
		line-height: 1.25rem;

		// symmetric 2rem insets leave room for the magnifier and the clear button
		padding: 0.25rem 2rem;
		outline: none;
		width: 100%;

		&:focus {
			border-color: var(--link);
			box-shadow: 0 0 0 0.1rem var(--link);
		}

		&::placeholder {
			color: var(--text-secondary);
		}
	}

	.clear {
		@include bare-button;

		position: absolute;
		right: 0.5rem;
		color: var(--text-secondary);
		display: inline-flex;
		padding: 0.25rem;

		&:hover {
			color: var(--text-heading);
		}
	}
</style>
