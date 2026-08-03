<script lang="ts">
	import Icon from './Icon.svelte';

	/**
	 * Multi-value sibling of Select: same bordered field and fixed-position
	 * listbox, but every row is a checkbox and picking one keeps the list open.
	 * The field shows the selection as a count plus a trailing-off name list.
	 */
	let {
		label,
		value = $bindable([]),
		options,
		width = '15rem',
		placeholder = 'Nothing selected',
		onchange
	}: {
		/** caption notched into the field's top border */
		label?: string;
		value?: string[];
		options: Array<{ value: string; label: string }>;
		width?: string;
		placeholder?: string;
		onchange?: (value: string[]) => void;
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

	const summary = $derived.by(() => {
		if (!value.length) {
			return placeholder;
		}

		const names = value
			.map((entry) => options.find((option) => option.value === entry)?.label ?? entry)
			.join(', ');

		return `${value.length} selected — ${names}`;
	});

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

	function toggle(): void {
		open = !open;

		if (open) {
			place();
		}
	}

	function pick(next: string): void {
		if (value.includes(next)) {
			value = value.filter((entry) => entry !== next);
		} else {
			value = [...value, next];
		}

		onchange?.(value);
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

<!-- capture phase: the Escape must be claimed before a surrounding Modal sees it -->
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
		class:empty={!value.length}
		type="button"
		aria-haspopup="listbox"
		aria-expanded={open}
		onclick={toggle}
	>
		<span class="val">{summary}</span>
		<span class="caret"><Icon name="caretDown" size="0.75rem" style="solid" /></span>
	</button>
	{#if open}
		<div
			bind:this={list}
			class="list"
			class:above={pos.above}
			role="listbox"
			aria-multiselectable="true"
			tabindex="-1"
			style="left: {pos.left}px; top: {pos.top}px; width: {pos.width}px"
		>
			{#each options as option (option.value)}
				{@const picked = value.includes(option.value)}
				<button
					class="opt"
					class:picked
					role="option"
					aria-selected={picked}
					onclick={() => pick(option.value)}
				>
					<span class="tick" class:on={picked}>
						{#if picked}<Icon name="check" size="0.625rem" style="solid" />{/if}
					</span>
					<span class="otext">{option.label}</span>
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

		// matches Select and the buttons it shares a row with; chips grow it from
		// here rather than starting a size of their own
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

		&:hover,
		&.open {
			border-color: var(--link);
		}

		&.open .caret {
			transform: rotate(180deg);
		}

		&.empty .val {
			color: var(--text-secondary);
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
		gap: 0.625rem;
		width: 100%;
		padding: 0.375rem 0.75rem;
		background: none;
		border: none;
		color: var(--text);
		font-family: var(--font);
		font-size: 0.875rem;
		text-align: left;
		cursor: pointer;

		&:hover {
			background: var(--bg-hover);
		}

		&.picked {
			color: var(--text-heading);
			font-weight: 700;
		}
	}

	.tick {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1rem;
		height: 1rem;
		flex: none;
		border: 0.1rem solid var(--border-field);
		border-radius: 0.25rem;
		color: #fff;

		&.on {
			background: var(--link);
			border-color: var(--link);
		}
	}

	.otext {
		@include ellipsis;
	}
</style>
