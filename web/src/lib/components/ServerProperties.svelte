<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { api, put, del } from '$lib/api';
	import Panel from './Panel.svelte';
	import Btn from './Btn.svelte';
	import Modal from './Modal.svelte';
	import ConfirmModal from './ConfirmModal.svelte';
	import Dropdown from './Dropdown.svelte';
	import Flash from './Flash.svelte';
	import StatusBadge from './StatusBadge.svelte';
	import ResourceTable from './ResourceTable.svelte';
	import type { Column, TableFilterGroup } from './table';
	import type { ContextMenuItem } from './contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * One instance's raw server.properties: every key on disk, with add, edit and
	 * remove.
	 *
	 * The schema-backed form above it is the curated way to change the keys luna
	 * knows; this is the escape hatch for the rest, and the only place a key the
	 * schema has never heard of can be added. Keys luna manages (the velocity
	 * forwarding four) are listed, badged and locked, because editing one breaks
	 * logins for the backend and a raw path around that guard would defeat it.
	 */

	let { instance, onchanged }: { instance: string; onchanged?: () => void } = $props();

	interface PropertyRow {
		key: string;
		value: string;
		/** the settings schema has a spec for this key */
		spec: boolean;
		managed: boolean;
		managedReason: string | null;
	}

	let rows: PropertyRow[] = $state([]);
	let supported = $state(true);
	let loaded = $state(false);
	let problem = $state('');
	let busy = $state(false);
	let selected: Set<string> = $state(new Set());

	// the add/edit dialog; `editing` empty means the key field is a new name
	let formOpen = $state(false);
	let editing = $state('');
	let formKey = $state('');
	let formValue = $state('');

	let removeOpen = $state(false);
	let removeTargets: PropertyRow[] = $state([]);

	async function refresh(): Promise<void> {
		try {
			const data = await api(`/instances/${instance}/properties`);

			rows = data.rows ?? [];
			supported = data.supported ?? true;
			problem = '';
		} catch (err) {
			problem = (err as Error).message;
		}

		loaded = true;
	}

	onMount(() => {
		void refresh();
	});

	function openAdd(): void {
		editing = '';
		formKey = '';
		formValue = '';
		formOpen = true;
	}

	function openEdit(row: PropertyRow): void {
		editing = row.key;
		formKey = row.key;
		formValue = row.value;
		formOpen = true;
	}

	/** Whether the dialog's key would collide with a row other than the edited one. */
	const keyTaken = $derived(
		!editing && rows.some((row) => row.key === formKey.trim())
	);

	async function save(): Promise<void> {
		const key = formKey.trim();

		if (!key) {
			return;
		}

		busy = true;

		const note = Notify.loading(t('web.props.saving', { key, instance }));

		try {
			const res = await put(`/instances/${instance}/properties`, { key, value: formValue });

			note.set({
				level: 'success',
				message: res.changed
					? t(res.appended ? 'web.props.added' : 'web.props.updated', { key })
					: t('web.props.unchanged', { key }),
				detail: res.changed ? t('web.props.appliesOnRestart') : '',
				closeable: true
			});

			formOpen = false;

			await refresh();
			onchanged?.();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.props.saveFailed', { key }),
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = false;
	}

	function askRemove(targets: PropertyRow[]): void {
		removeTargets = targets;
		removeOpen = true;
	}

	/**
	 * Remove every target, then reload once. Each key is its own request, so one
	 * refusal does not strand the rest; the outcome is reported as one line.
	 */
	async function remove(): Promise<void> {
		const targets = removeTargets;

		busy = true;

		const note = Notify.loading(t('web.props.removing', { count: targets.length }));
		const failures: string[] = [];
		let gone = 0;

		for (const row of targets) {
			try {
				const res = await del(
					`/instances/${instance}/properties?key=${encodeURIComponent(row.key)}`
				);

				if (res.existed) {
					gone += 1;
				}
			} catch (err) {
				failures.push(`${row.key}: ${(err as Error).message}`);
			}
		}

		note.set({
			level: failures.length ? 'error' : 'success',
			message: failures.length
				? t('web.props.removeFailed', { count: failures.length })
				: t('web.props.removed', { count: gone }),
			detail: failures.length ? failures.join(' · ') : t('web.props.appliesOnRestart'),
			closeable: true
		});

		selected = new Set();
		busy = false;

		await refresh();
		onchanged?.();
	}

	const columns: Column[] = $derived([
		{ id: 'key', label: t('web.props.colKey'), width: 320, sortable: true },
		{ id: 'value', label: t('web.props.colValue'), sortable: true },
		{ id: 'origin', label: t('web.props.colOrigin'), width: 150, sortable: true }
	]);

	const filters: TableFilterGroup<PropertyRow>[] = $derived([
		{
			id: 'origin',
			label: t('web.props.colOrigin'),
			options: [
				// the group's first entry is its "any value" one, and carries no match
				{ value: 'any', label: t('web.props.anyOrigin') },
				{ value: 'spec', label: t('web.props.originSpec'), match: (row) => row.spec && !row.managed },
				{ value: 'managed', label: t('web.props.originManaged'), match: (row) => row.managed },
				{ value: 'raw', label: t('web.props.originRaw'), match: (row) => !row.spec }
			]
		}
	]);

	/** The rows a bulk verb may touch: everything luna does not manage. */
	const selectedRows = $derived(rows.filter((row) => selected.has(row.key)));
	const editable = $derived(selectedRows.filter((row) => !row.managed));

	/**
	 * The verbs over a set of rows. Editing takes exactly one target, so with a
	 * wider selection it is disabled *with its reason* rather than dropped; the
	 * remove verb applies to the unmanaged rows in the selection.
	 */
	function actionsFor(targets: PropertyRow[]): ContextMenuItem[] {
		const one = targets.length === 1 ? targets[0] : undefined;
		const removable = targets.filter((row) => !row.managed);

		return [
			{
				label: t('web.props.editValue'),
				icon: 'pen',
				disabled: !one || one.managed || busy,
				hint: !one
					? t('web.props.pickOne')
					: one.managed
						? t(one.managedReason ?? 'web.props.managedHint')
						: undefined,
				action: () => one && openEdit(one)
			},
			{ separator: true },
			{
				label: t('web.props.copyKey'),
				icon: 'copy',
				disabled: !one,
				action: () => one && navigator.clipboard?.writeText(one.key)
			},
			{
				label: t('web.props.copyValue'),
				icon: 'copy',
				disabled: !one || !one.value,
				action: () => one && navigator.clipboard?.writeText(one.value)
			},
			{ separator: true },
			{
				label:
					removable.length > 1
						? t('web.props.removeMany', { count: removable.length })
						: t('web.props.remove'),
				icon: 'trash',
				color: 'danger',
				disabled: !removable.length || busy,
				hint: removable.length ? undefined : t('web.props.managedHint'),
				action: () => askRemove(removable)
			}
		];
	}

	/** A right-clicked row inside the selection acts on the whole selection. */
	function rowActions(row: PropertyRow): ContextMenuItem[] {
		return actionsFor(selected.has(row.key) && selectedRows.length > 1 ? selectedRows : [row]);
	}
</script>

<Panel
	title={t('web.props.title')}
	count={loaded && supported ? rows.length : undefined}
	description={t('web.props.description')}
	flush
>
	{#snippet actions()}
		{#if supported}
			<Dropdown
				label={t('web.common.actions')}
				disabled={!selectedRows.length}
				menu={actionsFor(selectedRows)}
			/>
			<Btn icon="sync" disabled={busy} onclick={() => void refresh()}>
				{t('web.props.refresh')}
			</Btn>
			<Btn variant="primary" icon="plus" disabled={busy} onclick={openAdd}>
				{t('web.props.addProperty')}
			</Btn>
		{/if}
	{/snippet}

	{#if problem}
		<div class="pad"><Flash kind="error">{problem}</Flash></div>
	{:else if !supported}
		<div class="pad"><Flash kind="info">{t('web.props.noPropertiesFile')}</Flash></div>
	{:else}
		<ResourceTable
			tableId="instance-properties"
			{columns}
			{filters}
			{rows}
			getId={(row) => row.key}
			searchValue={(row) => `${row.key} ${row.value}`}
			searchPlaceholder={t('web.props.findProperty')}
			searchWidth="20rem"
			selectable="multi"
			bind:selected
			{rowActions}
			rowLabel={(row) => row.key}
			rowDim={(row) => row.managed}
			onRowClick={(row) => !row.managed && openEdit(row)}
			sortValue={(row, col) =>
				col === 'origin' ? (row.managed ? 'managed' : row.spec ? 'spec' : 'raw') : row[col as 'key' | 'value']}
			noun={t('web.props.noun')}
			pageSize={25}
			emptyTitle={t('web.props.emptyTitle')}
			emptyText={t('web.props.emptyText')}
		>
			{#snippet cell(row, col)}
				{#if col === 'key'}
					<span class="mono">{row.key}</span>
				{:else if col === 'value'}
					{#if row.value}
						<span class="mono">{row.value}</span>
					{:else}
						<span class="dim">{t('web.props.blank')}</span>
					{/if}
				{:else if row.managed}
					<StatusBadge state="warning" label={t('web.props.originManaged')} />
				{:else if row.spec}
					<span class="dim">{t('web.props.originSpec')}</span>
				{:else}
					<span class="dim">{t('web.props.originRaw')}</span>
				{/if}
			{/snippet}
		</ResourceTable>
	{/if}
</Panel>

<Modal
	title={editing ? t('web.props.editTitle', { key: editing }) : t('web.props.addTitle')}
	bind:open={formOpen}
	dismissable={!busy}
>
	<label class="field">
		<span class="lbl">{t('web.props.colKey')}</span>
		<span class="hint">{t('web.props.keyHint')}</span>
		<input
			class="input mono"
			bind:value={formKey}
			disabled={busy || !!editing}
			placeholder="max-tick-time"
		/>
	</label>

	<label class="field">
		<span class="lbl">{t('web.props.colValue')}</span>
		<span class="hint">{t('web.props.valueHint')}</span>
		<input class="input mono" bind:value={formValue} disabled={busy} />
	</label>

	{#if keyTaken}
		<Flash kind="warning">{t('web.props.keyTaken', { key: formKey.trim() })}</Flash>
	{/if}

	{#snippet footer()}
		<Btn disabled={busy} onclick={() => (formOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn
			variant="primary"
			loading={busy}
			disabled={!formKey.trim()}
			onclick={() => void save()}
		>
			{editing ? t('web.props.saveValue') : t('web.props.addProperty')}
		</Btn>
	{/snippet}
</Modal>

<ConfirmModal
	bind:open={removeOpen}
	title={t('web.props.removeTitle')}
	lead={removeTargets.length === 1
		? t('web.props.removeLead', { key: removeTargets[0]?.key ?? '' })
		: t('web.props.removeLeadMany', { count: removeTargets.length })}
	notes={[t('web.props.removeNote')]}
	confirmLabel={t('web.props.remove')}
	onconfirm={() => void remove()}
/>

<style lang="scss">
	// the panel is flush, so a message standing in for the table brings its own
	// padding rather than sitting against the border
	.pad {
		padding: 1rem 1.25rem;
	}

	.field + .field {
		margin-top: 1rem;
	}
</style>
