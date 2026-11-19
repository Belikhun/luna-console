<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import { currentLanguage, t } from '$lib/i18n.svelte';

	import Btn from './Btn.svelte';
	import Dropdown from './Dropdown.svelte';
	import type { ContextMenuItem } from './contextmenu';
	import {
		DEFAULT_RANGE,
		MIN_RANGE_MS,
		RANGE_PRESETS,
		presetSpan,
		resolveRange,
		withRange,
		type RangePreset,
		type TimeRange
	} from './timerange';

	/**
	 * The range every chart on a screen shows: the kit's `Dropdown` reading
	 * "Last 24 hours", or the two instants of a fixed range ("12 Nov 13:00 to
	 * 14:30"). Its menu lists the presets, the current one checked, and
	 * "Custom…", which opens two date fields under the button. Presets reaching
	 * past what the daemon keeps are disabled with the reason. A fixed range (a
	 * custom one or a drag-to-zoom) gets a "Reset zoom" link beside the button.
	 *
	 * Without `onchange` it navigates itself, writing `?range=` with
	 * `withRange`, so Back undoes a change.
	 */
	let {
		value,
		onchange,
		presets = [...RANGE_PRESETS],
		max,
		resetTo = DEFAULT_RANGE
	}: {
		value: TimeRange;
		onchange?: (range: TimeRange) => void;
		presets?: RangePreset[];
		/** How far back the data reaches, ms; longer presets are disabled */
		max?: number;
		/** Where "Reset zoom" goes */
		resetTo?: TimeRange;
	} = $props();

	let open = $state(false);
	let fromText = $state('');
	let toText = $state('');
	let error = $state('');
	let root: HTMLElement | undefined = $state();
	let firstField: HTMLInputElement | undefined = $state();

	function locale(): string {
		return currentLanguage() === 'vi'
			? 'vi-VN'
			: 'en-GB';
	}

	/** "12 Nov 13:00 to 14:30", the date said once when both ends share it. */
	function fixedLabel(from: number, to: number): string {
		const start = new Date(from);
		const end = new Date(to);
		const sameDay = start.toDateString() === end.toDateString();

		const clock: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
		const dated: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', ...clock };

		return t('web.monitoring.range.between', {
			from: start.toLocaleString(locale(), dated),
			to: end.toLocaleString(locale(), sameDay ? clock : dated)
		});
	}

	const label = $derived(
		value.kind === 'preset'
			? t(`web.monitoring.range.${value.preset}`)
			: fixedLabel(value.from, value.to)
	);

	const menu = $derived<ContextMenuItem[]>([
		...presets.map((preset): ContextMenuItem => {
			const tooLong = max !== undefined && presetSpan(preset) > max;
			const current = value.kind === 'preset' && value.preset === preset;

			return {
				id: preset,
				label: t(`web.monitoring.range.${preset}`),
				icon: current
					? 'check'
					: undefined,
				color: current
					? 'accent'
					: 'default',
				disabled: tooLong,
				hint: tooLong
					? t('web.monitoring.range.beyondKept', { days: String(Math.floor((max ?? 0) / 86_400_000)) })
					: undefined,
				action: () => change({ kind: 'preset', preset })
			};
		}),
		{ separator: true },
		{
			id: 'custom',
			label: t('web.monitoring.range.custom'),
			icon: value.kind === 'fixed'
				? 'check'
				: 'calendar',
			color: value.kind === 'fixed'
				? 'accent'
				: 'default',
			action: () => openCustom()
		}
	]);

	function change(range: TimeRange): void {
		open = false;

		if (onchange) {
			onchange(range);

			return;
		}

		void goto(withRange(page.url, range), { keepFocus: true, noScroll: true });
	}

	/** A local `datetime-local` value for an instant. */
	function fieldValue(at: number): string {
		const date = new Date(at);
		const pad = (part: number): string => String(part).padStart(2, '0');

		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}

	async function openCustom(): Promise<void> {
		const current = resolveRange(value);

		fromText = fieldValue(current.from);
		toText = fieldValue(current.to);
		error = '';
		open = true;

		await tick();
		firstField?.focus();
	}

	function apply(): void {
		const from = new Date(fromText).getTime();
		const to = new Date(toText).getTime();

		if (Number.isNaN(from) || Number.isNaN(to)) {
			error = t('web.monitoring.range.invalid');

			return;
		}

		if (to - from < MIN_RANGE_MS) {
			error = t('web.monitoring.range.tooShort');

			return;
		}

		if (from > Date.now()) {
			error = t('web.monitoring.range.future');

			return;
		}

		change({ kind: 'fixed', from, to: Math.min(to, Date.now()) });
	}

	function onKey(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.stopPropagation();
			open = false;
		}

		if (event.key === 'Enter') {
			event.preventDefault();
			apply();
		}
	}

	onMount(() => {
		const outside = (event: PointerEvent): void => {
			if (open && root && !root.contains(event.target as Node)) {
				open = false;
			}
		};

		document.addEventListener('pointerdown', outside);

		return () => document.removeEventListener('pointerdown', outside);
	});
</script>

<div class="range-picker" bind:this={root}>
	{#if value.kind === 'fixed'}
		<Btn variant="link" onclick={() => change(resetTo)}>{t('web.monitoring.range.resetZoom')}</Btn>
	{/if}

	<Dropdown label={label} {menu} header={t('web.monitoring.range.label')} />

	{#if open}
		<div class="pop" role="dialog" aria-label={t('web.monitoring.range.customTitle')} tabindex="-1" onkeydown={onKey}>
			<label class="field">
				<span class="lbl">{t('web.monitoring.range.from')}</span>
				<input class="input" type="datetime-local" bind:value={fromText} bind:this={firstField} />
			</label>

			<label class="field">
				<span class="lbl">{t('web.monitoring.range.to')}</span>
				<input class="input" type="datetime-local" bind:value={toText} />
			</label>

			{#if error}
				<p class="err" role="alert">{error}</p>
			{/if}

			<div class="actions">
				<Btn variant="link" onclick={() => (open = false)}>{t('web.monitoring.range.cancel')}</Btn>
				<Btn variant="primary" onclick={apply}>{t('web.monitoring.range.apply')}</Btn>
			</div>
		</div>
	{/if}
</div>

<style lang="scss">
	.range-picker {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.pop {
		position: absolute;
		top: calc(100% + 0.5rem);
		right: 0;
		z-index: var(--z-popover);
		width: 18rem;
		padding: 1rem 1rem 0.75rem;
		background: var(--bg-dropdown);
		border: var(--hairline) solid var(--border);
		border-radius: var(--radius-input);
		box-shadow: var(--shadow-dropdown);

		.input {
			width: 100%;
			color-scheme: dark;
		}

		.err {
			margin: 0 0 0.75rem;
			font-size: 0.75rem;
			color: var(--error);
		}
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}
</style>
