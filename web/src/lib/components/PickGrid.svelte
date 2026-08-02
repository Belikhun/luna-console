<script lang="ts">
	import Checkbox from './Checkbox.svelte';

	/**
	 * A bordered grid of checkbox picks over a list of names — the wizards'
	 * "which instances / which plugins" selector. Selection stays in the
	 * caller's Set; this only renders it and reports toggles.
	 */
	let {
		items,
		selected,
		ontoggle,
		disabled = false,
		min = '8rem',
		maxHeight
	}: {
		items: string[];
		selected: Set<string>;
		ontoggle: (item: string, on: boolean) => void;
		disabled?: boolean;
		/** minimum column width, which is what sets the column count */
		min?: string;
		/** scroll past this height instead of growing (long plugin lists) */
		maxHeight?: string;
	} = $props();
</script>

<div class="grid" style:--min={min} style:max-height={maxHeight}>
	{#each items as item (item)}
		<label class="pick">
			<Checkbox
				checked={selected.has(item)}
				{disabled}
				label={item}
				onchange={(on) => ontoggle(item, on)}
			/>
			<span>{item}</span>
		</label>
	{/each}
</div>

<style lang="scss">
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(var(--min), 1fr));
		gap: 0.375rem 1rem;
		overflow-y: auto;
		padding: 0.5rem 0.25rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.5rem;
	}

	.pick {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8125rem;
		cursor: pointer;
	}
</style>
