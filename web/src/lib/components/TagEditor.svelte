<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts" generics="Row extends TagEditorRow = TagEditorRow">
	import { tick } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import { tooltip } from '$lib/tooltip.svelte';
	import { MAX_TAGS } from '$shared/iam/resources';
	import Btn from './Btn.svelte';
	import Icon from './Icon.svelte';
	import SearchInput from './SearchInput.svelte';
	import SegmentedControl from './SegmentedControl.svelte';
	import type { SegmentOption } from './segmented';
	import {
		blankTagRow,
		caseTwins,
		changeCounts,
		isBlankRow,
		parsePastedTags,
		revertRow,
		rowState,
		type TagEditorRow,
		type TagRowFault
	} from './tageditor';

	/**
	 * The tag editing form AWS uses: one row per tag with a key field and a
	 * value field, then "Add tag" and how many tags there are.
	 *
	 * The caller owns the rows (bound) and the faults, since it is the one that
	 * decides whether Save may go ahead; a fault is drawn under its field once
	 * the row has been typed in or its key left. Each row is marked with what
	 * saving would do to it, and a removal is a mark on the row until saved, so
	 * it can be taken back. A row flagged `mixed` (the bulk editor's key whose
	 * value differs across the selection) keeps each resource's value until its
	 * value is typed, which marks it `edited`.
	 */

	let {
		rows = $bindable([]),
		faults = {},
		max = MAX_TAGS,
		disabled = false,
		// the default only fits the default row type; a caller with richer rows passes its own
		newRow = blankTagRow as () => Row,
		canEdit = true,
		canRemove = true,
		editBlocked,
		removeBlocked,
		rowNote
	}: {
		rows: Row[];
		faults?: Record<number, TagRowFault>;
		max?: number;
		disabled?: boolean;
		/** builds the row "Add tag" appends */
		newRow?: () => Row;
		/** false: keys and values are read only and nothing can be added */
		canEdit?: boolean;
		/** false: a row the editor opened with can be neither removed nor renamed */
		canRemove?: boolean;
		/** why Add is disabled when `canEdit` is false */
		editBlocked?: string;
		/** why a remove button is disabled when `canRemove` is false */
		removeBlocked?: string;
		/** a dim line under a row's value field */
		rowNote?: (row: Row) => { text: string; detail?: string } | null;
	} = $props();

	/** Above this many rows the editor offers a filter. */
	const TOOLS_FROM = 8;

	let root: HTMLDivElement | undefined = $state();

	// faults show once a row was typed in, its key left, or a save was attempted
	let touched = $state<Set<number>>(new Set());
	let query = $state('');
	let view = $state('all');
	let focusedUid = $state<number | null>(null);

	const live = $derived(rows.filter((row) => !row.removed));
	const used = $derived(live.filter((row) => !isBlankRow(row)).length);
	const full = $derived(live.length >= max);
	const addable = $derived(!disabled && canEdit && !full);
	const counts = $derived(changeCounts(rows));
	const changedTotal = $derived(counts.add + counts.change + counts.remove);
	const twins = $derived(caseTwins(rows));
	const showTools = $derived(rows.length > TOOLS_FROM);
	const activeView = $derived(changedTotal === 0 ? 'all' : view);
	const tagRows = $derived(rows.filter((row) => !(row.original === null && isBlankRow(row))).length);

	const viewOptions: SegmentOption[] = $derived([
		{ id: 'all', label: t('web.tagEditor.showAll'), badge: tagRows },
		{ id: 'changed', label: t('web.tagEditor.showChanged'), badge: changedTotal, disabled: changedTotal === 0 }
	]);

	const addTitle = $derived.by(() => {
		if (!canEdit) {
			return editBlocked;
		}

		return full
			? t('web.tagEditor.full', { max })
			: undefined;
	});

	/** Whether a row survives the filter; only hides, never changes `rows`. */
	function shown(row: Row): boolean {
		if (!showTools) {
			return true;
		}

		// the row being typed in and every blank new row stay whatever the filter says
		if (row.uid === focusedUid || (row.original === null && isBlankRow(row))) {
			return true;
		}

		if (activeView === 'changed') {
			const state = rowState(row);

			if (state === 'same' || state === 'blank') {
				return false;
			}
		}

		const needle = query.trim().toLowerCase();

		if (needle === '') {
			return true;
		}

		return row.key.toLowerCase().includes(needle) || row.value.toLowerCase().includes(needle);
	}

	const visible = $derived(rows.filter(shown));

	/** Show every fault, for a caller whose save was refused. */
	export function touchAll(): void {
		touched = new Set(rows.map((row) => row.uid));
	}

	/** Show every fault and bring the first one into view, its field focused. */
	export async function revealFault(): Promise<void> {
		query = '';
		view = 'all';
		touchAll();

		await tick();

		const first = rows.find((row) => !!faults[row.uid]);

		if (!first) {
			return;
		}

		const fault = faults[first.uid];
		const field = fault?.key
			? 'key'
			: 'value';

		focusField(first.uid, field);
	}

	function touch(uid: number): void {
		if (!touched.has(uid)) {
			touched = new Set([...touched, uid]);
		}
	}

	function fieldOf(uid: number, field: 'key' | 'value'): HTMLInputElement | null {
		return root?.querySelector<HTMLInputElement>(`input[data-uid="${uid}"][data-field="${field}"]`) ?? null;
	}

	function focusField(uid: number, field: 'key' | 'value'): void {
		const input = fieldOf(uid, field);

		input?.scrollIntoView({ block: 'nearest' });
		input?.focus();
	}

	function focusAdd(): void {
		root?.querySelector<HTMLButtonElement>('.add button')?.focus();
	}

	async function add(): Promise<void> {
		if (!addable) {
			return;
		}

		const row = newRow();

		rows = [...rows, row];

		await tick();
		focusField(row.uid, 'key');
	}

	async function trash(row: Row): Promise<void> {
		if (row.original === null) {
			rows = rows.filter((entry) => entry.uid !== row.uid);

			await tick();
			focusAdd();

			return;
		}

		row.removed = true;

		await tick();
		root?.querySelector<HTMLButtonElement>(`[data-row="${row.uid}"] .acts button`)?.focus();
	}

	function restore(row: Row): void {
		row.removed = false;
	}

	function keyInput(row: Row): void {
		touch(row.uid);
	}

	function valueInput(row: Row): void {
		touch(row.uid);

		if (row.mixed) {
			row.edited = true;
		}
	}

	function keyKeydown(event: KeyboardEvent, row: Row): void {
		// Ctrl+Enter belongs to the dialog around the editor (its Save)
		if (event.ctrlKey || event.metaKey) {
			return;
		}

		if (event.key === 'Enter') {
			event.preventDefault();
			focusField(row.uid, 'value');

			return;
		}

		if (event.key !== 'Backspace' || row.key !== '' || row.original !== null || !isBlankRow(row)) {
			return;
		}

		event.preventDefault();

		const index = visible.findIndex((entry) => entry.uid === row.uid);
		const previous = index > 0
			? visible[index - 1]
			: undefined;

		rows = rows.filter((entry) => entry.uid !== row.uid);

		void tick().then(() => {
			if (previous) {
				focusField(previous.uid, 'value');
			} else {
				focusAdd();
			}
		});
	}

	function valueKeydown(event: KeyboardEvent, row: Row): void {
		if (event.key !== 'Enter' || event.ctrlKey || event.metaKey) {
			return;
		}

		event.preventDefault();

		const index = visible.findIndex((entry) => entry.uid === row.uid);
		const next = visible[index + 1];

		if (next) {
			focusField(next.uid, 'key');

			return;
		}

		if (!isBlankRow(row) && addable) {
			void add();
		}
	}

	async function keyPaste(event: ClipboardEvent, row: Row): Promise<void> {
		if (row.original !== null || !isBlankRow(row)) {
			return;
		}

		const entries = parsePastedTags(event.clipboardData?.getData('text') ?? '');

		if (!entries) {
			return;
		}

		event.preventDefault();

		let blankUsed = false;
		let lastUid = row.uid;
		const next = [...rows];

		for (const entry of entries) {
			const match = next.find((other) => other.uid !== row.uid && !other.removed && other.key.trim() === entry.key);

			if (match) {
				match.value = entry.value;

				if (match.mixed) {
					match.edited = true;
				}

				touch(match.uid);
				lastUid = match.uid;

				continue;
			}

			if (!blankUsed) {
				row.key = entry.key;
				row.value = entry.value;
				blankUsed = true;
				touch(row.uid);
				lastUid = row.uid;

				continue;
			}

			if (next.filter((other) => !other.removed).length >= max) {
				break;
			}

			const added = newRow();

			added.key = entry.key;
			added.value = entry.value;
			next.push(added);
			touch(added.uid);
			lastUid = added.uid;
		}

		rows = next;

		await tick();
		focusField(lastUid, 'key');
	}

	function valuePlaceholder(row: Row): string {
		return row.mixed && !row.edited
			? t('web.tagEditor.multipleValues')
			: t('web.tagEditor.valuePlaceholder');
	}
</script>

<div class="tagrows" bind:this={root}>
	{#if showTools}
		<div class="tools">
			<SearchInput bind:value={query} width="18rem" placeholder={t('web.tagEditor.filterPlaceholder')} />
			<SegmentedControl
				size="small"
				label={t('web.tagEditor.showLabel')}
				options={viewOptions}
				value={activeView}
				onchange={(id) => (view = id)}
			/>
		</div>
	{/if}

	<div class="scroller">
		<div class="grid">
			{#if visible.length > 0}
				<div class="row head">
					<span></span>
					<span class="lbl">{t('web.tagEditor.key')}</span>
					<span class="lbl">{t('web.tagEditor.valueOptional')}</span>
					<span></span>
				</div>
			{/if}

			{#each visible as row (row.uid)}
				{@const state = rowState(row)}
				{@const fault = touched.has(row.uid) ? faults[row.uid] : undefined}
				{@const twin = twins[row.uid]}
				{@const note = rowNote?.(row) ?? null}
				{@const keyLocked = disabled || !canEdit || row.removed || (!canRemove && row.original !== null)}
				{@const valueLocked = disabled || !canEdit || row.removed}
				{@const trashLocked = disabled || (!canRemove && row.original !== null)}
				<div class="row" class:removed={row.removed} data-row={row.uid}>
					<span class="state">
						{#if state === 'new'}
							<span class="glyph new" role="img" aria-label={t('web.tagEditor.stateNew')} use:tooltip={{ content: t('web.tagEditor.stateNew') }}>
								<Icon name="plus" size="0.75rem" style="solid" />
							</span>
						{:else if state === 'changed'}
							<span class="glyph" role="img" aria-label={t('web.tagEditor.stateChanged')} use:tooltip={{ content: t('web.tagEditor.stateChanged') }}>
								<span class="dot"></span>
							</span>
						{:else if state === 'removed'}
							<span class="glyph gone" role="img" aria-label={t('web.tagEditor.stateRemoved')} use:tooltip={{ content: t('web.tagEditor.stateRemoved') }}>
								<Icon name="close" size="0.75rem" style="solid" />
							</span>
						{/if}
					</span>

					<div class="field">
						<input
							class="input mono"
							class:bad={!!fault?.key}
							type="text"
							placeholder={t('web.tagEditor.keyPlaceholder')}
							aria-label={t('web.tagEditor.key')}
							data-uid={row.uid}
							data-field="key"
							bind:value={row.key}
							disabled={keyLocked}
							oninput={() => keyInput(row)}
							onfocus={() => (focusedUid = row.uid)}
							onblur={() => {
								focusedUid = null;
								touch(row.uid);
							}}
							onkeydown={(event) => keyKeydown(event, row)}
							onpaste={(event) => void keyPaste(event, row)}
						/>
						{#if fault?.key}
							<span class="err">{t(fault.key, { max })}</span>
						{:else if twin}
							<span class="warn">{t('web.tagEditor.caseTwin', { other: twin })}</span>
						{/if}
					</div>

					<div class="field">
						<input
							class="input mono"
							class:bad={!!fault?.value}
							type="text"
							placeholder={valuePlaceholder(row)}
							aria-label={t('web.tagEditor.value')}
							data-uid={row.uid}
							data-field="value"
							bind:value={row.value}
							disabled={valueLocked}
							oninput={() => valueInput(row)}
							onfocus={() => (focusedUid = row.uid)}
							onblur={() => (focusedUid = null)}
							onkeydown={(event) => valueKeydown(event, row)}
						/>
						{#if fault?.value}
							<span class="err">{t(fault.value, { max })}</span>
						{/if}
						{#if note}
							{#if note.detail}
								<span class="note info-trigger" use:tooltip={{ content: note.detail }}>{note.text}</span>
							{:else}
								<span class="note">{note.text}</span>
							{/if}
						{/if}
					</div>

					<div class="acts">
						{#if state === 'removed'}
							<Btn variant="icon" icon="rotateLeft" {disabled} title={t('web.tagEditor.restoreRow')} onclick={() => restore(row)} />
						{:else}
							{#if state === 'changed'}
								<Btn variant="icon" icon="rotateLeft" {disabled} title={t('web.tagEditor.revertRow')} onclick={() => revertRow(row)} />
							{/if}
							<Btn
								variant="icon"
								icon="trash"
								disabled={trashLocked}
								title={trashLocked && !disabled && removeBlocked
									? removeBlocked
									: t('web.tagEditor.removeRow')}
								onclick={() => void trash(row)}
							/>
						{/if}
					</div>
				</div>
			{:else}
				{#if rows.length === 0}
					<p class="none dim">{t('web.tagEditor.noRows')}</p>
				{:else}
					<p class="none dim">{t('web.tagEditor.noMatch', { query: query.trim() })}</p>
				{/if}
			{/each}
		</div>
	</div>

	<div class="foot">
		<span class="add">
			<Btn icon="plus" disabled={!addable} title={addable ? undefined : addTitle} onclick={() => void add()}>
				{t('web.tagEditor.addNew')}
			</Btn>
		</span>
		<span class="count dim">{t('web.tagEditor.count', { used, max })}</span>
		<button type="button" class="info-trigger paste" use:tooltip={{ content: t('web.tagEditor.pasteHint') }}>
			{t('web.tagEditor.pasteTrigger')}
		</button>
	</div>
</div>

<style lang="scss">
	.tagrows {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}

	.tools {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-bottom: 0.25rem;
	}

	// ten rows, then the list scrolls under its own header while the foot stays
	.scroller {
		max-height: min(22.5rem, 40vh);
		overflow-y: auto;
		padding-right: 0.25rem;
	}

	// one grid for every row, header included, so the columns line up: a row
	// that were its own grid would size its last column to its own buttons,
	// and the header's empty one to nothing
	.grid {
		display: grid;
		grid-template-columns: 1rem minmax(0, 1fr) minmax(0, 1fr) auto;
		column-gap: 0.75rem;
		row-gap: 0.5rem;

		@include below($bp-narrow) {
			grid-template-columns: 1rem minmax(0, 1fr) auto;
		}
	}

	.row {
		display: grid;
		grid-template-columns: subgrid;
		grid-column: 1 / -1;
		align-items: start;

		&.head {
			position: sticky;
			top: 0;
			z-index: 1;
			align-items: end;
			background: var(--bg-panel);
			padding-bottom: 0.25rem;
		}

		&.removed .input {
			text-decoration: line-through;
			opacity: 0.6;
		}

		@include below($bp-narrow) {
			row-gap: 0.5rem;

			.state {
				grid-row: 1 / span 2;
				grid-column: 1;
			}

			.field {
				grid-column: 2;
			}

			.acts {
				grid-row: 1 / span 2;
				grid-column: 3;
			}

			&.head {
				display: none;
			}
		}
	}

	.state {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 1.75rem;
	}

	.glyph {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--warning);

		&.new {
			color: var(--success);
		}

		&.gone {
			color: var(--error);
		}
	}

	.dot {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 50%;
		background: var(--warning);
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

	.warn {
		font-size: 0.75rem;
		color: var(--warning);
	}

	.note {
		align-self: flex-start;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.acts {
		display: flex;
		gap: 0.25rem;
		justify-content: flex-end;
	}

	.none {
		grid-column: 1 / -1;
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

	.count {
		font-size: 0.75rem;
	}

	.paste {
		margin-left: auto;
		font-size: 0.75rem;
	}
</style>
