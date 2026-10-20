<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts" generics="Row extends TagEditorRow = TagEditorRow">
	import { t } from '$lib/i18n.svelte';
	import { MAX_TAGS } from '$shared/iam/resources';
	import Btn from './Btn.svelte';
	import { blankTagRow, isBlankRow, type TagEditorRow, type TagRowFault } from './tageditor';

	/**
	 * The tag editing form AWS uses: one row per tag with a key field, a value
	 * field and a Remove button, then "Add new tag" and how many more fit.
	 *
	 * The caller owns the rows (bound) and the faults, since it is the one that
	 * decides whether Save may go ahead; a fault is drawn under its field once
	 * the row has been typed in. A row flagged `mixed` (the bulk editor's key
	 * whose value differs across the selection) shows "multiple values" until
	 * its value is typed, which marks it `edited`.
	 */

	let {
		rows = $bindable([]),
		faults = {},
		max = MAX_TAGS,
		disabled = false,
		// the default only fits the default row type; a caller with richer rows passes its own
		newRow = blankTagRow as () => Row,
		onremove
	}: {
		rows: Row[];
		faults?: Record<number, TagRowFault>;
		max?: number;
		disabled?: boolean;
		/** builds the row "Add new tag" appends */
		newRow?: () => Row;
		/** told about a row before it is taken out */
		onremove?: (row: Row) => void;
	} = $props();

	// faults show once a row was typed in or a save was attempted, not on a row just added
	let touched = $state<Set<number>>(new Set());

	const used = $derived(rows.filter((row) => !isBlankRow(row)).length);
	const left = $derived(Math.max(0, max - used));
	const full = $derived(rows.length >= max);

	/** Show every fault, for a caller whose save was refused. */
	export function touchAll(): void {
		touched = new Set(rows.map((row) => row.uid));
	}

	function touch(uid: number): void {
		if (!touched.has(uid)) {
			touched = new Set([...touched, uid]);
		}
	}

	function add(): void {
		if (full || disabled) {
			return;
		}

		rows = [...rows, newRow()];
	}

	function remove(row: Row): void {
		onremove?.(row);
		rows = rows.filter((entry) => entry.uid !== row.uid);
	}

	function valueInput(row: Row): void {
		touch(row.uid);

		if (row.mixed) {
			row.edited = true;
		}
	}

	function valuePlaceholder(row: Row): string {
		return row.mixed && !row.edited
			? t('web.tagEditor.multipleValues')
			: t('web.tagEditor.valuePlaceholder');
	}
</script>

<div class="tagrows">
	{#if rows.length > 0}
		<div class="row head">
			<span class="lbl">{t('web.tagEditor.key')}</span>
			<span class="lbl">{t('web.tagEditor.valueOptional')}</span>
			<span></span>
		</div>
	{/if}

	{#each rows as row (row.uid)}
		{@const fault = touched.has(row.uid) ? faults[row.uid] : undefined}
		<div class="row">
			<div class="field">
				<input
					class="input mono"
					class:bad={!!fault?.key}
					type="text"
					placeholder={t('web.tagEditor.keyPlaceholder')}
					aria-label={t('web.tagEditor.key')}
					bind:value={row.key}
					{disabled}
					oninput={() => touch(row.uid)}
				/>
				{#if fault?.key}
					<span class="err">{t(fault.key, { max })}</span>
				{/if}
			</div>

			<div class="field">
				<input
					class="input mono"
					class:bad={!!fault?.value}
					type="text"
					placeholder={valuePlaceholder(row)}
					aria-label={t('web.tagEditor.value')}
					bind:value={row.value}
					{disabled}
					oninput={() => valueInput(row)}
				/>
				{#if fault?.value}
					<span class="err">{t(fault.value, { max })}</span>
				{/if}
			</div>

			<div class="rm">
				<Btn {disabled} onclick={() => remove(row)}>{t('web.tagEditor.removeRow')}</Btn>
			</div>
		</div>
	{:else}
		<p class="none dim">{t('web.tagEditor.noRows')}</p>
	{/each}

	<div class="foot">
		<Btn icon="plus" disabled={disabled || full} title={full ? t('web.tagEditor.full', { max }) : undefined} onclick={add}>
			{t('web.tagEditor.addNew')}
		</Btn>
		<span class="hint dim">{t('web.tagEditor.remaining', { count: left })}</span>
	</div>
</div>

<style lang="scss">
	.tagrows {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}

	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
		gap: 0.75rem;
		align-items: start;

		&.head {
			align-items: end;
		}

		@include below($bp-narrow) {
			grid-template-columns: minmax(0, 1fr) auto;

			.field:nth-child(2) {
				grid-column: 1;
			}

			.rm {
				grid-row: 1 / span 2;
				grid-column: 2;
			}

			&.head {
				display: none;
			}
		}
	}

	.lbl {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-heading);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;

		.input {
			width: 100%;
			font-size: 0.8125rem;

			&.bad {
				border-color: var(--error);
			}
		}
	}

	.err {
		font-size: 0.75rem;
		color: var(--error);
	}

	.none {
		margin: 0;
		font-size: 0.8125rem;
	}

	.foot {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-top: 0.25rem;
	}

	.hint {
		font-size: 0.75rem;
	}
</style>
