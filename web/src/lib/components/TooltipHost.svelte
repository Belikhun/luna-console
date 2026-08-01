<script lang="ts">
	import { untrack } from 'svelte';
	import { TooltipState, clampTooltip } from '$lib/tooltip.svelte';

	/**
	 * Renders the single tooltip card driven by `$lib/tooltip.svelte`. Mounted
	 * once, at the end of the app shell, so it floats above every surface.
	 */
	let card: HTMLDivElement | undefined = $state();

	$effect(() => {
		void TooltipState.content;
		void TooltipState.position;

		if (!TooltipState.mounted || !card) {
			return;
		}

		// clamping writes back x/y — read them untracked so it settles in one pass
		untrack(() => clampTooltip(card!.offsetWidth, card!.offsetHeight));
	});
</script>

{#if TooltipState.mounted}
	<div
		class="tooltip"
		class:show={TooltipState.visible}
		data-position={TooltipState.position}
		style="left: {TooltipState.x}px; top: {TooltipState.y}px"
		role="tooltip"
	>
		<div class="content" bind:this={card}>{TooltipState.content}</div>
	</div>
{/if}

<style lang="scss">
	// The wrapper carries the anchor offset (which corner of the card sits on the
	// anchor point); the card inside carries the fade/scale motion, so the two
	// transforms never fight over the same property.
	.tooltip {
		position: fixed;
		z-index: var(--z-tooltip);
		pointer-events: none;

		&[data-position='top'] {
			transform: translate(-50%, -100%);

			> .content {
				transform-origin: center bottom;
				transform: scaleY(0.9) translateY(0.25rem);
			}
		}

		&[data-position='bottom'] {
			transform: translate(-50%, 0);

			> .content {
				transform-origin: center top;
				transform: scaleY(0.9) translateY(-0.25rem);
			}
		}

		&[data-position='left'] {
			transform: translate(-100%, -50%);

			> .content {
				transform-origin: right center;
				transform: scaleX(0.98) translateX(0.25rem);
			}
		}

		&[data-position='right'] {
			transform: translate(0, -50%);

			> .content {
				transform-origin: left center;
				transform: scaleX(0.98) translateX(-0.25rem);
			}
		}

		&.show > .content {
			transform: none;
			opacity: 1;
			box-shadow: var(--shadow-dropdown);
		}
	}

	.content {
		padding: 0.25rem 0.75rem;
		border-radius: 0.5rem;
		border: 0.1rem solid var(--border);
		background: color-mix(in srgb, var(--bg-dropdown) 92%, transparent);
		backdrop-filter: blur(0.5rem);
		color: var(--text-heading);
		font-size: 0.8125rem;
		font-weight: 700;
		line-height: 1.25rem;

		// nowrap plus a max-width just spills the text out of the card — long
		// tooltips have to wrap inside it, as the dashboard's do
		max-width: 22rem;
		white-space: normal;

		opacity: 0;
		box-shadow: rgba(0, 7, 22, 0.1) 0 0 0;
		transition:
			opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1),
			transform 0.3s cubic-bezier(0.16, 1, 0.3, 1),
			box-shadow 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.1s;
	}
</style>
