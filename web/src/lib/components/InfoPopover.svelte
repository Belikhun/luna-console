<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { untrack } from 'svelte';

	import { t } from '$lib/i18n.svelte';

	import Icon from './Icon.svelte';
	import { stateStyle, type PopoverDetail } from './statusbadge';

	/**
	 * Text that explains itself on click: the dashed underline that means
	 * "reveals more about this value", opening a card with a close button, as
	 * the AWS console's info popovers do (and `StatusBadge`'s detail, which uses
	 * this). Lines are plain text or state rows (icon, bold name, a second line).
	 * Never a native `title`.
	 */
	let {
		detail,
		children
	}: {
		detail: PopoverDetail;
		children: Snippet;
	} = $props();

	const detailLines = $derived(Array.isArray(detail) ? detail : [detail]);

	// px, not rem: these are viewport measurements, matched against the card's own
	// 20rem width below
	const POP_WIDTH = 320;
	const GAP = 8;

	/** above this much room overhead, the card opens upwards on the first paint */
	const FLIP_ABOVE = 160;

	/** px; a card squeezed below this scrolls instead of shrinking further */
	const MIN_POP_H = 120;

	let open = $state(false);
	let root: HTMLSpanElement | undefined = $state();
	let trigger: HTMLButtonElement | undefined = $state();
	let card: HTMLSpanElement | undefined = $state();
	let pos = $state({ left: 0, top: 0, below: false });

	/** px; measured, so it goes into the style as px (CLAUDE.md's one exception) */
	let maxHeight = $state(0);

	/**
	 * Table cells clip their overflow, so the card is placed in viewport space.
	 *
	 * Called twice per opening: once on the click, when the card is not in the
	 * DOM yet and the side can only be guessed from the trigger's position, and
	 * once from the effect below with the real height in hand. A tall card; six
	 * daemon checks, opening upwards from halfway down the screen; would
	 * otherwise run off the top of the viewport.
	 *
	 * Never reads `pos` or `maxHeight`: the effect that calls it would then
	 * depend on its own writes and loop until Svelte kills it with
	 * `effect_update_depth_exceeded`, which is exactly what froze the page.
	 */
	function place(): void {
		if (!trigger) {
			return;
		}

		const box = trigger.getBoundingClientRect();
		const left = Math.max(GAP, Math.min(box.left, window.innerWidth - POP_WIDTH - GAP));
		const roomAbove = box.top - GAP * 2;
		const roomBelow = window.innerHeight - box.bottom - GAP * 2;
		const height = card?.offsetHeight ?? 0;

		const below = height > 0
			? height > roomAbove && roomBelow > roomAbove
			: box.top < FLIP_ABOVE;

		const top = below ? box.bottom + GAP : box.top - GAP;

		maxHeight = Math.max(MIN_POP_H, below ? roomBelow : roomAbove);

		if (pos.left !== left || pos.top !== top || pos.below !== below) {
			pos = { left, top, below };
		}
	}

	// re-place once the card is mounted and its height is measurable. The body is
	// untracked so this effect depends on `open`/`card` alone and can never be
	// woken by its own writes.
	$effect(() => {
		if (open && card) {
			untrack(place);
		}
	});

	/** Escape closes the card and hands focus back to what opened it. */
	function onKeyDown(event: KeyboardEvent): void {
		if (!open || event.key !== 'Escape') {
			return;
		}

		open = false;
		trigger?.focus();
	}

	function toggle(event: MouseEvent): void {
		event.stopPropagation();
		open = !open;

		if (open) {
			place();
		}
	}

	/** The card is rendered inside the badge but positioned fixed; test both. */
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

<svelte:window onpointerdown={onPointerDown} onkeydown={onKeyDown} onresize={() => (open = false)} />

<span class="infopop" bind:this={root}>
	<button class="info-trigger" bind:this={trigger} aria-expanded={open} onclick={toggle}>
		{@render children()}
	</button>
	{#if open}
		<span
			bind:this={card}
			class="pop"
			class:below={pos.below}
			role="tooltip"
			style="left: {pos.left}px; top: {pos.top}px"
			style:max-height={maxHeight ? `${maxHeight}px` : undefined}
		>
			<span class="ptext">
				{#each detailLines as line}
					{#if typeof line === 'string'}
						<span class="prow">{line}</span>
					{:else}
						{@const rowStyle = stateStyle(line.state)}
						<span class="prow structured">
							<span class="rico" style="color: {rowStyle.color}">
								<Icon name={rowStyle.icon} spin={rowStyle.spin ?? false} size="0.875rem" />
							</span>
							<span class="rbody">
								<span class="rlabel" class:heading={!!line.detail}>{line.label}</span>
								{#if line.detail}<span class="rdetail">{line.detail}</span>{/if}
							</span>
						</span>
					{/if}
				{/each}
			</span>
			<button
				class="pclose"
				aria-label={t('web.common.close')}
				onclick={(event) => {
					event.stopPropagation();
					open = false;
				}}
			>
				<Icon name="close" size="0.875rem" />
			</button>
		</span>
	{/if}
</span>

<style lang="scss">
	.infopop {
		position: relative;
		display: inline-flex;
		align-items: center;
		min-width: 0;
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
		overflow-y: auto;
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

		// a label is a heading only over its own detail line; a list of plain
		// rows reads as body text
		.rlabel {
			color: var(--text-heading);

			&.heading {
				font-weight: 700;
			}
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
