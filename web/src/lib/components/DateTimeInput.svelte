<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { onDestroy } from 'svelte';
	import { currentLanguage, t } from '$lib/i18n.svelte';
	import { claimMenu, releaseMenu } from './contextmenu';
	import Icon from './Icon.svelte';

	/**
	 * A date and time field: the value written out in the console's language, and
	 * a month calendar with an hour and a minute under it, in place of the
	 * browser's own picker, which every browser draws differently and none in
	 * the console's theme. The value is the string a `datetime-local` input
	 * holds (`YYYY-MM-DDTHH:mm`, local time, empty when unset), so a caller
	 * reads it exactly as it did before.
	 */
	let {
		value = $bindable(''),
		disabled = false,
		width = '100%',
		onchange
	}: {
		value?: string;
		disabled?: boolean;
		width?: string;
		onchange?: (value: string) => void;
	} = $props();

	// px, not rem: viewport geometry for placing the popover
	const GAP = 4;
	const POPOVER_H = 380;

	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();
	let box: HTMLButtonElement | undefined = $state();
	let pop: HTMLDivElement | undefined = $state();
	let pos = $state({ left: 0, top: 0, above: false });

	/** The month the calendar shows, as its first day */
	let month = $state(new Date());

	const picked = $derived(parse(value));

	const locale = $derived(currentLanguage() === 'vi' ? 'vi-VN' : 'en-GB');

	const shown = $derived(
		picked
			? picked.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
			: ''
	);

	const monthTitle = $derived(month.toLocaleDateString(locale, { month: 'long', year: 'numeric' }));

	// Monday first, the way both locales the console ships count a week
	const weekdays = $derived(
		Array.from({ length: 7 }, (_, index) => new Date(2024, 0, 1 + index).toLocaleDateString(locale, { weekday: 'narrow' }))
	);

	/** Six weeks from the Monday on or before the 1st, so every month fits and the grid never jumps */
	const days = $derived.by(() => {
		const first = new Date(month.getFullYear(), month.getMonth(), 1);
		const offset = (first.getDay() + 6) % 7;

		return Array.from({ length: 42 }, (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + index));
	});

	const hour = $derived(picked?.getHours() ?? 0);
	const minute = $derived(picked?.getMinutes() ?? 0);

	function pad(n: number): string {
		return String(n).padStart(2, '0');
	}

	function parse(text: string): Date | null {
		if (!text) {
			return null;
		}

		const date = new Date(text);

		return Number.isNaN(date.getTime()) ? null : date;
	}

	function format(date: Date): string {
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}

	function sameDay(left: Date, right: Date): boolean {
		return left.getFullYear() === right.getFullYear()
			&& left.getMonth() === right.getMonth()
			&& left.getDate() === right.getDate();
	}

	function commit(date: Date): void {
		value = format(date);
		onchange?.(value);
	}

	/** A day keeps the time already chosen; the first pick takes the next whole hour */
	function pickDay(day: Date): void {
		const next = new Date(day);

		if (picked) {
			next.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
		} else {
			next.setHours(new Date().getHours() + 1, 0, 0, 0);
		}

		if (next.getMonth() !== month.getMonth()) {
			month = new Date(next.getFullYear(), next.getMonth(), 1);
		}

		commit(next);
	}

	function setTime(part: 'hour' | 'minute', raw: string): void {
		const limit = part === 'hour' ? 23 : 59;
		const amount = Math.min(limit, Math.max(0, Math.trunc(Number(raw) || 0)));
		const next = picked ? new Date(picked) : new Date();

		if (!picked) {
			next.setSeconds(0, 0);
		}

		if (part === 'hour') {
			next.setHours(amount);
		} else {
			next.setMinutes(amount);
		}

		commit(next);
	}

	function shiftMonth(by: number): void {
		month = new Date(month.getFullYear(), month.getMonth() + by, 1);
	}

	function now(): void {
		const next = new Date();

		next.setSeconds(0, 0);
		month = new Date(next.getFullYear(), next.getMonth(), 1);
		commit(next);
	}

	function clear(): void {
		value = '';
		onchange?.('');
	}

	/** In viewport space, as Select's list is: panels and modal bodies clip their overflow */
	function place(): void {
		if (!box) {
			return;
		}

		const field = box.getBoundingClientRect();
		const roomBelow = window.innerHeight - field.bottom - GAP;
		const above = roomBelow < POPOVER_H && field.top > roomBelow;

		pos = {
			left: field.left,
			top: above ? field.top - GAP : field.bottom + GAP,
			above
		};
	}

	// one popup at a time, through the registry the menus and Select share
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
		if (disabled) {
			return;
		}

		open = !open;

		if (open) {
			const base = picked ?? new Date();

			month = new Date(base.getFullYear(), base.getMonth(), 1);
			place();
		}
	}

	function onWindowDown(event: PointerEvent): void {
		const target = event.target as Node;

		if (open && root && !root.contains(target) && !pop?.contains(target)) {
			open = false;
		}
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape' && open) {
			open = false;

			// an open calendar swallows the Escape; a surrounding modal must not close too
			event.preventDefault();
			box?.focus();
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

<div class="dt" bind:this={root} style:width>
	<button
		bind:this={box}
		class="box"
		class:open
		type="button"
		aria-haspopup="dialog"
		aria-expanded={open}
		{disabled}
		onclick={toggle}
	>
		<span class="val" class:empty={!shown}>{shown || t('web.dateTime.pick')}</span>
		<span class="glyph"><Icon name="calendar" size="0.875rem" style="solid" /></span>
	</button>
	{#if open}
		<div
			bind:this={pop}
			class="pop"
			class:above={pos.above}
			role="dialog"
			aria-label={t('web.dateTime.pick')}
			style="left: {pos.left}px; top: {pos.top}px"
		>
			<div class="head">
				<button class="nav" type="button" title={t('web.dateTime.previousMonth')} onclick={() => shiftMonth(-1)}>
					<Icon name="arrowLeft" size="0.75rem" style="solid" />
				</button>
				<span class="title">{monthTitle}</span>
				<button class="nav" type="button" title={t('web.dateTime.nextMonth')} onclick={() => shiftMonth(1)}>
					<Icon name="arrowRight" size="0.75rem" style="solid" />
				</button>
			</div>

			<div class="grid">
				{#each weekdays as name, index (index)}
					<span class="wd">{name}</span>
				{/each}
				{#each days as day (day.getTime())}
					<button
						class="day"
						type="button"
						class:outside={day.getMonth() !== month.getMonth()}
						class:today={sameDay(day, new Date())}
						class:chosen={!!picked && sameDay(day, picked)}
						aria-pressed={!!picked && sameDay(day, picked)}
						onclick={() => pickDay(day)}
					>
						{day.getDate()}
					</button>
				{/each}
			</div>

			<div class="time">
				<Icon name="clock" size="0.875rem" style="solid" />
				<input
					class="input num"
					type="number"
					min="0"
					max="23"
					aria-label={t('web.dateTime.hour')}
					value={pad(hour)}
					onchange={(event) => setTime('hour', event.currentTarget.value)}
				/>
				<span class="colon">:</span>
				<input
					class="input num"
					type="number"
					min="0"
					max="59"
					aria-label={t('web.dateTime.minute')}
					value={pad(minute)}
					onchange={(event) => setTime('minute', event.currentTarget.value)}
				/>
				<span class="spacer"></span>
				<button class="link" type="button" onclick={now}>{t('web.dateTime.now')}</button>
				{#if value}
					<button class="link" type="button" onclick={clear}>{t('web.dateTime.clear')}</button>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style lang="scss">
	.dt {
		position: relative;
		display: inline-flex;
	}

	// the same field as Select's, so a date sits on a form row like every other control
	.box {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		width: 100%;
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

		&:focus-visible {
			@include focus-ring;
		}

		// after the hover rule, so a disabled field does not light up under the pointer
		&:disabled {
			opacity: 0.55;
			cursor: default;
			border-color: var(--border-field);
		}
	}

	.val {
		@include ellipsis;

		&.empty {
			color: var(--text-secondary);
		}
	}

	.glyph {
		display: inline-flex;
		flex: none;
		color: var(--link);
	}

	.pop {
		position: fixed;
		z-index: var(--z-popover);
		width: 17.5rem;
		padding: 0.5rem;
		background: var(--bg-dropdown);
		border: 0.1rem solid var(--border);
		border-radius: 0.5rem;
		box-shadow: var(--shadow-dropdown);
		animation: fadein 0.1s ease-out;

		// opening below is the default, so an upward popover is pulled up by its own height
		&.above {
			transform: translateY(-100%);
		}
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.375rem;

		.title {
			flex: 1;
			text-align: center;
			font-weight: 700;
			color: var(--text-heading);
			text-transform: capitalize;
		}
	}

	.nav {
		@include bare-button;

		display: inline-grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		color: var(--text-secondary);
		cursor: pointer;

		&:hover {
			background: var(--bg-hover);
			color: var(--text-heading);
		}
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 0.125rem;
	}

	.wd {
		padding: 0.25rem 0;
		text-align: center;
		font-size: 0.6875rem;
		font-weight: 700;
		color: var(--text-secondary);
		text-transform: uppercase;
	}

	.day {
		@include bare-button;

		height: 2rem;
		border: 0.125rem solid transparent;
		border-radius: 0.375rem;
		color: var(--text);
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
		cursor: pointer;

		&:hover {
			background: var(--bg-hover);
		}

		&:focus-visible {
			@include focus-ring;
		}

		&.outside {
			color: var(--text-disabled);
		}

		&.today {
			border-color: var(--border-input);
		}

		// last, so the pick reads over today's ring and a neighbouring month's dimming
		&.chosen {
			background: var(--link);
			border-color: var(--link);
			color: var(--bg-panel);
			font-weight: 700;
		}
	}

	.time {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		margin-top: 0.5rem;
		padding-top: 0.5rem;
		border-top: 0.1rem solid var(--border-divider);
		color: var(--text-secondary);

		.num {
			width: 3rem;
			text-align: center;
			font-variant-numeric: tabular-nums;
		}

		.colon {
			font-weight: 700;
		}

		.spacer {
			flex: 1;
		}
	}

	.link {
		@include bare-button;

		padding: 0.25rem 0.375rem;
		border-radius: 0.375rem;
		color: var(--link);
		font-size: 0.8125rem;
		cursor: pointer;

		&:hover {
			background: var(--bg-hover);
		}
	}
</style>
