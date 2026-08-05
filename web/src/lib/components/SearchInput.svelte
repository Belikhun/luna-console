<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import Icon from './Icon.svelte';

	/** Filter box: magnifier icon inside a rounded input. */
	let {
		value = $bindable(''),
		placeholder = t('web.common.findResources'),
		width = '30rem',
		focus = false,
		onenter
	}: {
		value: string;
		placeholder?: string;
		width?: string;
		/** Take the caret as soon as the box is mounted (a dialog's own field) */
		focus?: boolean;
		/** Enter pressed in the field; for boxes that submit rather than filter */
		onenter?: () => void;
	} = $props();

	let field: HTMLInputElement | undefined = $state();

	$effect(() => {
		if (focus) {
			field?.focus();
		}
	});
</script>

<div class="search" style:max-width={width}>
	<span class="mg"><Icon name="search" size="0.75rem" /></span>
	<input
		bind:this={field}
		{placeholder}
		bind:value
		onkeydown={(event) => {
			if (event.key === 'Enter') {
				onenter?.();
			}
		}}
	/>
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
		border: var(--border-control) solid var(--border-input);
		border-radius: var(--radius-input);
		color: var(--text);
		font-family: var(--font);
		font-size: 0.875rem;
		line-height: 1.25rem;

		// one control height, so a search box and the button beside it line up
		height: var(--control-h);

		// symmetric 2rem insets leave room for the magnifier and the clear button
		padding: 0.125rem 2rem;
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
