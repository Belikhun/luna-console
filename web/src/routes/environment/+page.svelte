<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { api, post, del } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Select from '$lib/components/Select.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Environment manager: the variables config templates substitute as ${NAME}.
	 * Global values with optional per-instance overrides; secrets are write-only
	 * — the server masks them on every read.
	 */

	interface EnvRow {
		name: string;
		value: string;
		secret: boolean;
		description: string;
	}

	let variables: EnvRow[] = $state([]);
	/** instance → override names (values stay server-side for secrets' sake) */
	let overrides: Record<string, string[]> = $state({});
	let instanceNames: string[] = $state([]);

	let loading = $state(false);
	let lastUpdated: number | null = $state(null);

	let editOpen = $state(false);
	let editing: EnvRow | null = $state(null);
	let formName = $state('');
	let formValue = $state('');
	let formSecret = $state(false);
	let formDescription = $state('');
	let formScope = $state('');
	let saving = $state(false);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api('/env');

			variables = data.variables;
			overrides = data.instances;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error('Could not load the environment', { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void refresh();

		void api('/instances').then((data) => {
			instanceNames = data.instances.map((inst: any) => inst.name);
		});
	});

	function openEditor(row: EnvRow | null): void {
		editing = row;
		formName = row?.name ?? '';
		formValue = row?.secret ? '' : (row?.value ?? '');
		formSecret = row?.secret ?? false;
		formDescription = row?.description ?? '';
		formScope = '';
		editOpen = true;
	}

	async function save(): Promise<void> {
		saving = true;

		try {
			await post('/env', {
				name: formName,
				value: formValue,
				secret: formSecret,
				description: formDescription,
				instance: formScope || undefined
			});

			Notify.success(`${formName} saved`, {
				detail: 'Templates pick it up on the next deploy or env apply.'
			});

			editOpen = false;
			await refresh();
		} catch (err) {
			Notify.error(`Could not save ${formName}`, { detail: (err as Error).message });
		}

		saving = false;
	}

	async function remove(row: EnvRow): Promise<void> {
		try {
			await del(`/env?name=${encodeURIComponent(row.name)}`);
			Notify.success(`${row.name} removed`);
			await refresh();
		} catch (err) {
			Notify.error(`Could not remove ${row.name}`, { detail: (err as Error).message });
		}
	}

	const columns: Column[] = [
		{ id: 'name', label: 'Name', sortable: true, width: 240 },
		{ id: 'value', label: 'Value' },
		{ id: 'description', label: 'Description' },
	];

	function rowActions(row: EnvRow): ContextMenuItem[] {
		return [
			{ label: 'Edit variable', icon: 'pen', action: () => openEditor(row) },
			{
				label: 'Copy name',
				icon: 'copy',
				action: () => navigator.clipboard?.writeText(row.name)
			},
			{
				label: 'Copy value',
				icon: 'copy',
				// a secret's value never reaches the browser, so there is nothing to copy
				disabled: row.secret,
				action: () => navigator.clipboard?.writeText(row.value)
			},
			{ separator: true },
			{
				label: 'Remove variable',
				icon: 'trash',
				color: 'danger',
				action: () => remove(row)
			}
		];
	}

	const overrideRows = $derived(
		Object.entries(overrides).flatMap(([instance, names]) =>
			names.map((name) => ({ instance, name }))
		)
	);

	let selected: Set<string> = $state(new Set());

	/** The row the header's Actions dropdown acts on. */
	const one = $derived(variables.find((row: any) => selected.has(row.name)));
</script>

<svelte:head><title>Environment | Luna Console</title></svelte:head>

<PageHeader
	title="Environment"
	count={variables.length}
	description="Variables that config templates substitute as $&lbrace;NAME&rbrace; when plugins deploy — builtins like LUNA_INSTANCE and LUNA_FORWARDING_SECRET are computed per instance"
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="environment" />
		<Dropdown label="Actions" disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn variant="primary" icon="key" onclick={() => openEditor(null)}>Add variable</Btn>
	{/snippet}
</PageHeader>

<Panel flush>
	<ResourceTable
		tableId="environment"
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		rows={variables}
		getId={(row) => row.name}
		searchValue={(row) => `${row.name} ${row.secret ? 'secret' : row.value} ${row.description}`}
		searchPlaceholder="Find a variable"
		selectable="single"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.name}
		noun="variable"
		onRowClick={(row) => openEditor(row)}
		emptyTitle="No variables defined"
		emptyText="Add DB_HOST, LUNA_HTTP_PORT and friends — templates reference them as ${'${NAME}'}."
	>
		{#snippet cell(row, col)}
			{#if col === 'name'}
				<span class="mono"><b>{row.name}</b></span>
			{:else if col === 'value'}
				{#if row.secret}
					<StatusBadge state="warning" label="secret" />
					<span class="dim">••••••••</span>
				{:else}
					<span class="mono">{row.value}</span>
				{/if}
			{:else if col === 'description'}
				<span class="dim">{row.description || '–'}</span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

{#if overrideRows.length}
	<div class="gap"></div>
	<Panel
		title="Per-instance overrides"
		count={overrideRows.length}
		description="Values that replace the global one on a single instance"
	>
		{#each overrideRows as row}
			<div class="ovr">
				<span class="mono">{row.name}</span>
				<span class="dim">on</span>
				<a href="/instances/{row.instance}">{row.instance}</a>
				<Btn
					variant="icon"
					icon="trash"
					title="Remove override"
					onclick={async () => {
						await del(`/env?name=${encodeURIComponent(row.name)}&instance=${row.instance}`);
						await refresh();
					}}
				/>
			</div>
		{/each}
	</Panel>
{/if}

<Modal title={editing ? `Edit ${editing.name}` : 'Add variable'} bind:open={editOpen}>
	{#if !editing}
		<label class="field">
			<span class="lbl">Name</span>
			<span class="hint">ALL_UPPERCASE_WITH_UNDERSCORES; LUNA_* is reserved for builtins</span>
			<input class="input mono" bind:value={formName} placeholder="DB_HOST" />
		</label>
	{/if}
	<label class="field">
		<span class="lbl">Value</span>
		{#if editing?.secret}
			<span class="hint">Secrets are write-only — enter a new value to replace the stored one</span>
		{/if}
		<input class="input mono" bind:value={formValue} />
	</label>
	<label class="field">
		<span class="lbl">Description</span>
		<input class="input" bind:value={formDescription} placeholder="What reads this" />
	</label>
	<div class="field">
		<span class="lbl">Scope</span>
		<Select
			bind:value={formScope}
			width="100%"
			options={[
				{ value: '', label: 'Global — every instance' },
				...instanceNames.map((name) => ({ value: name, label: `Override on ${name} only` }))
			]}
		/>
	</div>
	<label class="secret-row">
		<Checkbox checked={formSecret} label="Secret" onchange={(on) => (formSecret = on)} />
		Secret — mask the value everywhere after saving
	</label>
	{#snippet footer()}
		<Btn onclick={() => (editOpen = false)}>Cancel</Btn>
		<Btn variant="primary" loading={saving} disabled={!formName} onclick={save}>Save</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.gap {
		height: 1rem;
	}

	.ovr {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.375rem 0;
		border-bottom: 0.1rem solid var(--border-divider);

		&:last-child {
			border-bottom: none;
		}
	}

	.secret-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.25rem;
		font-size: 0.875rem;
	}
</style>
