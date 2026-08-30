<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { tooltip } from '$lib/tooltip.svelte';

	import Icon from './Icon.svelte';

	/**
	 * A value that edits itself where it stands: the value, a pencil beside it,
	 * and on a click a field with a tick and a cross, in the AWS console's
	 * idiom.
	 *
	 * This is what a table column does instead of growing a column of buttons
	 * (CLAUDE.md, web console conventions): a control that edits a value in
	 * place belongs in that value's own cell, while the row's *verbs* live in
	 * its context menu. Use it where the value is one small scalar and opening
	 * a whole configure screen to change a number is the wrong weight.
	 *
	 * `save` owns persistence and reporting. It is awaited, the field stays open
	 * and spinning until it settles, and a rejection leaves the field open with
	 * the typed value intact so the operator can correct it rather than retype
	 * it. Returning normally closes the editor; the caller reloads its own rows.
	 */
	let {
		value,
		save,
		type = 'text',
		min,
		max,
		step,
		width = '3.5rem',
		label,
		disabled = false,
		hint
	}: {
		value: string | number;
		/** persists the new value; rejecting keeps the editor open and open-eyed */
		save: (next: string) => Promise<void>;
		type?: 'text' | 'number';
		min?: number;
		max?: number;
		step?: number;
		/** the field's width while open; the resting value is unaffected */
		width?: string;
		/** names the value for the pencil's accessible label and tooltip */
		label?: string;
		disabled?: boolean;
		/** why editing is unavailable; shown on the disabled pencil */
		hint?: string;
	} = $props();

	let editing = $state(false);
	let busy = $state(false);

	// `bind:value` on a number input writes a *number* back, and an emptied one
	// writes null; the declared type says so rather than letting the initializer
	// promise a string the runtime does not keep
	let draft: string | number | null = $state('');
	let field: HTMLInputElement | undefined = $state();

	/**
	 * Editing a value is not selecting the row it sits in, so every control here
	 * stops the click reaching the table. Without this, opening the editor also
	 * ticks the row, and the screen's Actions dropdown silently changes target.
	 */
	function contain(event: MouseEvent): void {
		event.stopPropagation();
	}

	function open(event: MouseEvent): void {
		contain(event);

		if (disabled) {
			return;
		}

		draft = String(value);
		editing = true;
	}

	function cancel(event?: MouseEvent): void {
		event?.stopPropagation();
		editing = false;
		busy = false;
	}

	// the field is only in the DOM while open, so focusing it is an effect
	// rather than something open() could do
	$effect(() => {
		if (editing && field) {
			field.focus();
			field.select();
		}
	});

	async function commit(event?: MouseEvent): Promise<void> {
		event?.stopPropagation();

		if (busy) {
			return;
		}

		const next = draft === null ? '' : String(draft).trim();

		// an emptied field is not an instruction to store nothing; and the value
		// it already had is not a save either. Both just close
		if (next === '' || next === String(value)) {
			cancel();

			return;
		}

		busy = true;

		try {
			await save(next);
			editing = false;
		} catch {
			// the caller has already reported it; keeping the field open with the
			// rejected text is what lets the operator fix it rather than retype it
		}

		busy = false;
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter') {
			event.preventDefault();
			void commit();

			return;
		}

		if (event.key === 'Escape') {
			// the table beneath must not read this as a dismissal of its own
			event.preventDefault();
			event.stopPropagation();
			cancel();
		}
	}

	/**
	 * Leaving the field abandons the edit rather than saving it. A blur is as
	 * often a misclick as an intent, and this control sits in a row a click
	 * would otherwise select; the tick is how a value is committed.
	 */
	function onBlur(event: FocusEvent): void {
		const next = event.relatedTarget as HTMLElement | null;

		if (busy || next?.closest('.inlineedit')) {
			return;
		}

		cancel();
	}
</script>

<span class="inlineedit" class:editing>
	{#if editing}
		<input
			bind:this={field}
			bind:value={draft}
			class="input editfield"
			style="width: {width}"
			{type}
			{min}
			{max}
			{step}
			disabled={busy}
			aria-label={label}
			onkeydown={onKeydown}
			onblur={onBlur}
			onclick={contain}
		/>
		<button
			class="act ok"
			disabled={busy}
			aria-label={t('web.inlineEdit.save')}
			use:tooltip={{ content: t('web.inlineEdit.save') }}
			onclick={commit}
		>
			<Icon name={busy ? 'rotate' : 'check'} style="solid" size="0.75rem" spin={busy} />
		</button>
		<button
			class="act"
			disabled={busy}
			aria-label={t('web.inlineEdit.cancel')}
			use:tooltip={{ content: t('web.inlineEdit.cancel') }}
			onclick={cancel}
		>
			<Icon name="close" style="solid" size="0.75rem" />
		</button>
	{:else}
		<span class="value">{value}</span>
		<button
			class="pencil"
			{disabled}
			aria-label={label ? t('web.inlineEdit.editNamed', { name: label }) : t('web.inlineEdit.edit')}
			use:tooltip={{ content: disabled ? (hint ?? '') : t('web.inlineEdit.clickToEdit') }}
			onclick={open}
		>
			<Icon name="pen" size="0.75rem" />
		</button>
	{/if}
</span>

<style lang="scss">
	.inlineedit {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;

		// the open editor overhangs a column sized for the resting value, so it
		// has to sit above the cells it covers (DataTable un-clips the cell) and
		// carry its own ground, or the value underneath reads through it
		&.editing {
			position: relative;
			z-index: 1;
			padding: 0.125rem 0.25rem;
			margin: -0.125rem -0.25rem;
			border-radius: var(--radius-input);
			background: var(--bg-panel-raised);
			box-shadow: var(--shadow-dropdown);
		}
	}

	.value {
		min-width: 0;
	}

	// deliberately not `.field`: that is a global utility in app.scss for a
	// labelled form-field block, and its margin-bottom would hang under the
	// input. Shorter than a form control, too, since this sits inside a table
	// row whose height must not jump when one cell opens
	.editfield {
		height: 1.75rem;
		min-height: 0;
		padding: 0 0.5rem;
		text-align: inherit;
	}

	.pencil,
	.act {
		@include bare-button;

		display: inline-flex;
		flex: none;
		padding: 0.25rem;
		border-radius: var(--radius-input);
		color: var(--text-secondary);

		&:hover:not(:disabled) {
			color: var(--text-heading);
			background: var(--bg-hover);
		}

		&:focus-visible {
			@include focus-ring;
		}

		&:disabled {
			color: var(--text-disabled);
		}
	}

	.act.ok:hover:not(:disabled) {
		color: var(--success);
	}
</style>
