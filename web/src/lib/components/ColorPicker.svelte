<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * A hex colour field with a swatch popover: saturation/value square, hue
	 * slider, and Minecraft's sixteen named colours as presets.
	 *
	 * The panel is positioned in viewport space, like `Select`, because the places
	 * this is used; inspector panels, modal bodies; clip their overflow.
	 */

	import { t } from '$lib/i18n.svelte';
	import Icon from './Icon.svelte';
	import { NAMED_COLORS } from '$shared/minimessage';

	interface Props {
		value?: string;
		label?: string;
		placeholder?: string;
		disabled?: boolean;
		onchange?: (hex: string) => void;
	}

	const { value = '', label, placeholder = '#RRGGBB', disabled = false, onchange }: Props = $props();

	let open = $state(false);
	let trigger: HTMLButtonElement | undefined = $state();
	let panelX = $state(0);
	let panelY = $state(0);
	let area: HTMLDivElement | undefined = $state();

	const swatches = $derived([...new Set(Object.values(NAMED_COLORS))]);
	const normalized = $derived(/^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : '');

	function hexToHsv(hex: string): { h: number; s: number; v: number } {
		const r = parseInt(hex.slice(1, 3), 16) / 255;
		const g = parseInt(hex.slice(3, 5), 16) / 255;
		const b = parseInt(hex.slice(5, 7), 16) / 255;
		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		const delta = max - min;

		let h = 0;

		if (delta !== 0) {
			if (max === r) {
				h = ((g - b) / delta) % 6;
			} else if (max === g) {
				h = (b - r) / delta + 2;
			} else {
				h = (r - g) / delta + 4;
			}
		}

		return { h: ((h * 60) + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
	}

	function hsvToHex(h: number, s: number, v: number): string {
		const c = v * s;
		const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
		const m = v - c;
		const sector = Math.floor(h / 60) % 6;
		const table: Array<[number, number, number]> = [
			[c, x, 0],
			[x, c, 0],
			[0, c, x],
			[0, x, c],
			[x, 0, c],
			[c, 0, x]
		];
		const [r, g, b] = table[sector] ?? [0, 0, 0];
		const part = (channel: number): string =>
			Math.round((channel + m) * 255)
				.toString(16)
				.padStart(2, '0');

		return `#${part(r)}${part(g)}${part(b)}`;
	}

	const hsv = $derived(normalized ? hexToHsv(normalized) : { h: 0, s: 0, v: 1 });

	function place(): void {
		if (!trigger) {
			return;
		}

		const box = trigger.getBoundingClientRect();
		// getBoundingClientRect hands back device pixels; they only become a style
		panelX = box.left;
		panelY = box.bottom + 4;
	}

	function toggle(): void {
		if (disabled) {
			return;
		}

		place();
		open = !open;
	}

	function pick(hex: string): void {
		onchange?.(hex);
	}

	function pickFromArea(event: PointerEvent): void {
		if (!area) {
			return;
		}

		const box = area.getBoundingClientRect();
		const s = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
		const v = 1 - Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));

		pick(hsvToHex(hsv.h, s, v));
	}
</script>

<svelte:window
	onresize={() => (open = false)}
	onpointerdown={(event) => {
		if (open && trigger && !trigger.contains(event.target as Node)) {
			const panel = document.querySelector('.colorpanel');

			if (!panel || !panel.contains(event.target as Node)) {
				open = false;
			}
		}
	}}
/>

<div class="field">
	{#if label}
		<span class="lbl">{label}</span>
	{/if}

	<div class="row">
		<button class="swatch" bind:this={trigger} {disabled} onclick={toggle} title="Pick a colour" type="button">
			<span class="chip" style:background={normalized || 'transparent'}></span>
			<Icon name="caretDown" size="0.625rem" style="solid" />
		</button>

		<input
			class="input mono"
			{placeholder}
			{disabled}
			value={value}
			oninput={(event) => onchange?.((event.currentTarget as HTMLInputElement).value)}
		/>
	</div>
</div>

{#if open}
	<div class="colorpanel" style:left={`${panelX}px`} style:top={`${panelY}px`}>
		<div
			class="area"
			bind:this={area}
			style:background={`linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex(hsv.h, 1, 1)})`}
			onpointerdown={(event) => {
				(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
				pickFromArea(event);
			}}
			onpointermove={(event) => event.buttons === 1 && pickFromArea(event)}
			role="slider"
			aria-label={t('web.colorPicker.saturation')}
			aria-valuenow={Math.round(hsv.s * 100)}
			tabindex="0"
		>
			<span class="cursor" style:left={`${hsv.s * 100}%`} style:top={`${(1 - hsv.v) * 100}%`}></span>
		</div>

		<input
			class="hue"
			type="range"
			min="0"
			max="359"
			value={Math.round(hsv.h)}
			aria-label={t('web.colorPicker.hue')}
			oninput={(event) => pick(hsvToHex(Number((event.currentTarget as HTMLInputElement).value), hsv.s || 1, hsv.v || 1))}
		/>

		<div class="presets">
			{#each swatches as hex (hex)}
				<button
					class="preset"
					style:background={hex}
					title={hex}
					type="button"
					aria-label={hex}
					onclick={() => pick(hex)}
				></button>
			{/each}
		</div>
	</div>
{/if}

<style lang="scss">
	.row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.swatch {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		flex: none;
		height: var(--control-h);
		padding: 0 0.375rem;
		border: var(--border-control) solid var(--border-input);
		border-radius: var(--radius-input);
		background: var(--bg-input);
		color: var(--text-secondary);
		cursor: pointer;

		&:disabled {
			cursor: not-allowed;
			opacity: 0.6;
		}
	}

	.chip {
		width: 1rem;
		height: 1rem;
		border-radius: 0.25rem;
		// a checkerboard shows through when no colour is set
		background-image: linear-gradient(45deg, var(--border) 25%, transparent 25%),
			linear-gradient(-45deg, var(--border) 25%, transparent 25%);
		background-size: 0.5rem 0.5rem;
		box-shadow: inset 0 0 0 var(--hairline) var(--border);
	}

	.colorpanel {
		position: fixed;
		z-index: var(--z-popover);
		width: 15rem;
		padding: 0.75rem;
		border: var(--hairline) solid var(--border);
		border-radius: var(--radius-input);
		background: var(--bg-dropdown);
		box-shadow: var(--shadow-dropdown);
	}

	.area {
		position: relative;
		height: 8rem;
		border-radius: 0.25rem;
		cursor: crosshair;
		touch-action: none;
	}

	.cursor {
		position: absolute;
		width: 0.625rem;
		height: 0.625rem;
		margin: -0.3125rem 0 0 -0.3125rem;
		border: 0.125rem solid #fff;
		border-radius: 50%;
		box-shadow: 0 0 0 var(--hairline) rgba(0, 0, 0, 0.6);
		pointer-events: none;
	}

	.hue {
		width: 100%;
		margin: 0.75rem 0 0.5rem;
		appearance: none;
		height: 0.75rem;
		border-radius: 0.375rem;
		background: linear-gradient(
			to right,
			#f00 0%,
			#ff0 17%,
			#0f0 33%,
			#0ff 50%,
			#00f 67%,
			#f0f 83%,
			#f00 100%
		);

		&::-webkit-slider-thumb {
			appearance: none;
			width: 0.75rem;
			height: 0.75rem;
			border: 0.125rem solid #fff;
			border-radius: 50%;
			background: transparent;
		}
	}

	.presets {
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		gap: 0.25rem;
	}

	.preset {
		aspect-ratio: 1;
		border: var(--hairline) solid var(--border);
		border-radius: 0.25rem;
		cursor: pointer;

		&:hover {
			outline: 0.125rem solid var(--link);
		}
	}
</style>
