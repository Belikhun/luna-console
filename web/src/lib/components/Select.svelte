<script lang="ts">
	import { onDestroy } from 'svelte';
	import { claimMenu, releaseMenu } from './contextmenu';
	import Icon from './Icon.svelte';

	/**
	 * Select: a bordered field whose optional label is set *into* the top border
	 * (the "inline label" treatment — the label paints the panel background over
	 * the rule, leaving a notch), and a listbox whose current entry is ringed and
	 * check-marked. This is the control behind the canned attribute filters.
	 */
	let {
		label,
		value = $bindable(''),
		options,
		width = '15rem',
		onchange
	}: {
		/** caption notched into the field's top border */
		label?: string;
		value?: string;
		/** a disabled entry stays listed, greyed and unpickable — an option the
		 *  caller wants seen but not chosen (an offline machine, say) */
		options: Array<{ value: string; label: string; disabled?: boolean }>;
		width?: string;
		onchange?: (value: string) => void;
	} = $props();

	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();
	let box: HTMLButtonElement | undefined = $state();
	let list: HTMLDivElement | undefined = $state();
	let pos = $state({ left: 0, top: 0, width: 0, above: false });

	// px, not rem: viewport geometry, matched against the list's own 18rem max-height
	const GAP = 4;
	const MAX_LIST_H = 288;
	const OPTION_H = 32;
	const LIST_PADDING = 8;

	const selected = $derived(options.find((option) => option.value === value) ?? options[0]);

	/**
	 * The listbox is placed in viewport space: panels and modal bodies clip their
	 * overflow, and an absolutely positioned menu inside one is cut off at the
	 * container's edge.
	 */
	function place(): void {
		if (!box) {
			return;
		}

		const field = box.getBoundingClientRect();
		const roomBelow = window.innerHeight - field.bottom - GAP;
		const wanted = Math.min(MAX_LIST_H, options.length * OPTION_H + LIST_PADDING);
		const above = roomBelow < wanted && field.top > roomBelow;

		pos = {
			left: field.left,
			top: above ? field.top - GAP : field.bottom + GAP,
			width: field.width,
			above
		};
	}

	// One popup at a time, through the same registry the context menus use. A
	// menu trigger stops its own pointerdown (or this control's outside-click
	// handler would fire before the menu opened), so without the registry a
	// dropdown opening over an open list would leave both on screen.
	const handle = {
		close: (): void => {
			open = false;
		}
	};

	$effect(() => {
		if (open) {
			claimMenu(handle);
		} else {
			releaseMenu(handle);
		}
	});

	onDestroy(() => releaseMenu(handle));

	function toggle(): void {
		open = !open;

		if (open) {
			place();
		}
	}

	function pick(option: { value: string; disabled?: boolean }): void {
		if (option.disabled) {
			return;
		}

		value = option.value;
		open = false;
		onchange?.(option.value);
	}

	/** The listbox is fixed-positioned outside the root, so test it separately. */
	function onWindowDown(event: PointerEvent): void {
		const target = event.target as Node;

		if (open && root && !root.contains(target) && !list?.contains(target)) {
			open = false;
		}
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape' && open) {
			open = false;

			// an open list swallows the Escape — a surrounding modal must not close too
			event.preventDefault();
		}
	}

	function reposition(): void {
		if (open) {
			place();
		}
	}
</script>

<svelte:window
	onpointerdown={onWindowDown}
	onkeydowncapture={onKeydown}
	onresize={reposition}
	onscroll={reposition}
/>

<div class="sel" class:labelled={!!label} bind:this={root} style:width>
	{#if label}<span class="lbl">{label}</span>{/if}
	<button
		bind:this={box}
		class="box"
		class:open
		type="button"
		aria-haspopup="listbox"
		aria-expanded={open}
		onclick={toggle}
	>
		<span class="val">{selected?.label ?? ''}</span>
		<span class="caret"><Icon name="caretDown" size="0.75rem" style="solid" /></span>
	</button>
	{#if open}
		<div
			bind:this={list}
			class="list"
			class:above={pos.above}
			role="listbox"
			tabindex="-1"
			style="left: {pos.left}px; top: {pos.top}px; width: {pos.width}px"
		>
			{#each options as option (option.value)}
				{@const current = option.value === selected?.value}
				<button
					class="opt"
					class:current
					role="option"
					aria-selected={current}
					disabled={option.disabled}
					onclick={() => pick(option)}
				>
					<span class="otext">{option.label}</span>
					{#if current}<Icon name="check" size="0.875rem" style="solid" />{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>

<style lang="scss">
	.sel {
		position: relative;
		display: inline-flex;
		flex-direction: column;

		// the label sits astride the top rule: half of its 1rem box overhangs the
		// field, and its own background paints out the border underneath
		&.labelled {
			padding-top: 0.5rem;
		}
	}

	.lbl {
		position: absolute;
		top: 0;
		left: 0.5625rem;
		height: 1rem;
		padding: 0 0.25rem 0.125rem;
		background: var(--bg-panel);
		border-radius: 0.125rem;
		font-size: 0.75rem;
		line-height: 0.875rem;
		color: var(--text-heading);
		font-weight: 700;
		white-space: nowrap;
	}

	.box {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		width: 100%;

		// the shared control height — a select, a text field and a button on the
		// same row must agree, or the row reads as three different sizes
		min-height: var(--control-h);
		padding: 0.125rem 0.75rem;
		background: var(--bg-panel);
		border: 0.1rem solid var(--border-field);
		border-radius: var(--radius-input);
		color: var(--text);
		font-family: var(--font);
		font-size: 0.875rem;
		cursor: pointer;
		text-align: left;
	}
	.box {
		&:hover,
		&.open {
			border-color: var(--link);
		}

		&.open .caret {
			transform: rotate(180deg);
		}
	}

	.val {
		@include ellipsis;
	}

	.caret {
		display: inline-flex;
		color: var(--link);
		flex: none;
	}

	.list {
		position: fixed;
		background: var(--bg-dropdown);
		border: 0.1rem solid var(--border);
		border-radius: 0.5rem;
		box-shadow: var(--shadow-dropdown);
		padding: 0;
		z-index: var(--z-popover);
		max-height: 18rem;
		overflow: hidden auto;
		animation: fadein 0.1s ease-out;
	}
	// opening below is the default, so an upward list is pulled up by its own height
	.list.above {
		transform: translateY(-100%);
	}

	.opt {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		width: 100%;
		padding: 0.375rem 0.75rem;
		background: none;
		border: 0.125rem solid transparent;
		color: var(--text);
		font-family: var(--font);
		font-size: 0.875rem;
		text-align: left;
		cursor: pointer;
	}
	.opt {
		&:hover {
			background: var(--bg-hover);
		}

		&.current {
			border-color: var(--link);
			border-radius: 0.375rem;
			color: var(--text-heading);
			font-weight: 700;

			// the check mark is an Icon instance, hence :global
			:global(icon) {
				color: var(--link);
			}
		}

		// last, so it wins over both :hover and .current — a listed-but-unpickable
		// entry must never look interactive
		&:disabled {
			background: none;
			color: var(--text-disabled);
			cursor: not-allowed;
		}
	}

	.otext {
		@include ellipsis;
	}
</style>
