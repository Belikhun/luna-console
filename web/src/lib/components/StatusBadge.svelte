<script lang="ts">
	import Icon from './Icon.svelte';

	/**
	 * State indicator: coloured icon + label. When `detail` is given the label
	 * becomes a popover trigger — dashed underline in body colour, per the
	 * console convention that a solid underline means "navigates" and a dashed
	 * one means "reveals more about this value".
	 */
	// `state` is renamed on the way in: leaving it in scope would shadow the
	// $state rune for the whole component.
	/** Structured popover row: a nested state icon + name, with secondary detail. */
	export interface StatusDetailRow {
		state: string;
		label: string;
		detail?: string;
	}

	let {
		state: kind,
		label,
		detail
	}: {
		state: string;
		label?: string;
		/**
		 * Explanation revealed in a popover on click. Strings render as plain
		 * rows; StatusDetailRow entries get a state-coloured icon, a bold name
		 * and a secondary detail line — used for per-check breakdowns.
		 */
		detail?: string | Array<string | StatusDetailRow>;
	} = $props();

	const detailLines = $derived.by(() => {
		if (detail === undefined) {
			return [];
		}

		return Array.isArray(detail) ? detail : [detail];
	});

	const FALLBACK_STYLE = { color: 'var(--text-secondary)', icon: 'circleQuestion' };

	const styles: Record<string, { color: string; icon: string; spin?: boolean }> = {
		running: { color: 'var(--success)', icon: 'circleCheck' },
		ok: { color: 'var(--success)', icon: 'circleCheck' },
		passed: { color: 'var(--success)', icon: 'circleCheck' },
		stopped: { color: 'var(--text-secondary)', icon: 'ban' },
		failed: { color: 'var(--error)', icon: 'circleXMark' },
		incompatible: { color: 'var(--error)', icon: 'circleXMark' },
		error: { color: 'var(--error)', icon: 'circleXMark' },
		starting: { color: 'var(--text-secondary)', icon: 'rotate', spin: true },
		stopping: { color: 'var(--warning)', icon: 'rotate', spin: true },
		restarting: { color: 'var(--text-secondary)', icon: 'rotate', spin: true },
		pending: { color: 'var(--text-secondary)', icon: 'rotate', spin: true },
		warning: { color: 'var(--warning)', icon: 'triangleExclamation' },
		unknown: { color: 'var(--text-secondary)', icon: 'circleQuestion' },
		external: { color: 'var(--text-secondary)', icon: 'externalLink' }
	};
	const style = $derived(styles[kind] ?? FALLBACK_STYLE);
	const text = $derived(label ?? kind.charAt(0).toUpperCase() + kind.slice(1));

	// px, not rem: these are viewport measurements, matched against the card's own
	// 20rem width below
	const POP_WIDTH = 320;
	const GAP = 8;

	/** above this much room overhead, the card opens upwards */
	const FLIP_ABOVE = 160;

	let open = $state(false);
	let root: HTMLSpanElement | undefined = $state();
	let trigger: HTMLButtonElement | undefined = $state();
	let pos = $state({ left: 0, top: 0, below: false });

	/** Table cells clip their overflow, so the card is placed in viewport space. */
	function place(): void {
		if (!trigger) {
			return;
		}

		const box = trigger.getBoundingClientRect();
		const left = Math.max(GAP, Math.min(box.left, window.innerWidth - POP_WIDTH - GAP));
		const below = box.top < FLIP_ABOVE;

		pos = { left, top: below ? box.bottom + GAP : box.top - GAP, below };
	}

	function toggle(event: MouseEvent): void {
		event.stopPropagation();
		open = !open;

		if (open) {
			place();
		}
	}

	/** The card is rendered inside the badge but positioned fixed — test both. */
	function onPointerDown(event: PointerEvent): void {
		if (!open || !root) {
			return;
		}

		const target = event.target as HTMLElement;

		if (!root.contains(target) && !target.closest('.pop')) {
			open = false;
		}
	}
</script>

<svelte:window onpointerdown={onPointerDown} onresize={() => (open = false)} />

<span class="badge" class:has-detail={!!detail} style="color: {style.color}" bind:this={root}>
	<Icon name={style.icon} spin={style.spin ?? false} size="1rem" />
	{#if detail}
		<button class="info-trigger" bind:this={trigger} aria-expanded={open} onclick={toggle}>
			{text}
		</button>
		{#if open}
			<span
				class="pop"
				class:below={pos.below}
				role="tooltip"
				style="left: {pos.left}px; top: {pos.top}px"
			>
				<span class="ptext">
					{#each detailLines as line}
						{#if typeof line === 'string'}
							<span class="prow">{line}</span>
						{:else}
							{@const rowStyle = styles[line.state] ?? FALLBACK_STYLE}
							<span class="prow structured">
								<span class="rico" style="color: {rowStyle.color}">
									<Icon name={rowStyle.icon} spin={rowStyle.spin ?? false} size="0.875rem" />
								</span>
								<span class="rbody">
									<b>{line.label}</b>
									{#if line.detail}<span class="rdetail">{line.detail}</span>{/if}
								</span>
							</span>
						{/if}
					{/each}
				</span>
				<button
					class="pclose"
					title="Close"
					onclick={(event) => {
						event.stopPropagation();
						open = false;
					}}
				>
					<Icon name="close" size="0.875rem" />
				</button>
			</span>
		{/if}
	{:else}
		{text}
	{/if}
</span>

<style lang="scss">
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		line-height: 1.25rem;
		font-size: 0.875rem;
		white-space: nowrap;
	}
	.badge.has-detail {
		position: relative;
	}

	.pop {
		position: fixed;
		transform: translateY(-100%);
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		width: 20rem;
		padding: 0.75rem 0.75rem 0.75rem 1rem;
		background: var(--bg-dropdown);
		border: 0.1rem solid var(--border);
		border-radius: 0.5rem;
		box-shadow: var(--shadow-dropdown);
		color: var(--text);
		white-space: normal;
		z-index: var(--z-popover);
		animation: fadein 0.1s ease-out;
	}
	// opening upwards is the default, so the card is pulled up by its own height
	.pop.below {
		transform: none;
	}

	.ptext {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		line-height: 1.25rem;
	}

	.prow {
		display: block;

		&.structured {
			display: flex;
			align-items: flex-start;
			gap: 0.5rem;
		}
	}

	.rico {
		display: inline-flex;
		flex: none;
		padding-top: 0.125rem;
	}

	.rbody {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;

		b {
			font-weight: 700;
			color: var(--text-heading);
		}
	}

	.rdetail {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		line-height: 1.25rem;
	}

	.pclose {
		@include bare-button;

		color: var(--text);
		display: inline-flex;
		flex: none;

		&:hover {
			color: var(--link);
		}
	}
</style>
