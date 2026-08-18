<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { api, post } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Select from '$lib/components/Select.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify, type NotificationHandle } from '$lib/notifications.svelte';
	import { jobFlash } from '$lib/jobflash';

	/**
	 * Java runtimes: the JDKs luna has installed, per machine.
	 *
	 * One row per machine × runtime, because a runtime is not a cluster-wide
	 * object: the archive is arch-specific and lives under each machine's own
	 * cluster root, so "temurin@21 is installed" is only ever true of a machine.
	 * A machine that did not answer gets a row of its own saying so, rather than
	 * quietly contributing nothing; "unknown" and "nothing installed" lead to
	 * opposite actions.
	 */

	interface RuntimeRow {
		/** `<machine>:<id>`; unique per installation, not per runtime */
		id: string;
		runtimeId: string;
		machine: string;
		machineName: string;
		vendor: string;
		version: string;
		feature: number;
		platform: string;
		sizeBytes?: number;
		installedAt?: string;
		javaVersionLine?: string;
		usedBy: string[];
		/** the machine did not answer; nothing about it is actionable */
		unreachable: boolean;
	}

	interface CatalogRow {
		id: string;
		vendor: string;
		version: string;
		feature: number;
		lts?: boolean;
		size?: number;
	}

	let rows: RuntimeRow[] = $state([]);
	let machines: Array<{ key: string; name: string; primary: boolean }> = $state([]);
	let platforms: Record<string, string | null> = $state({});
	let loading = $state(false);
	let lastUpdated: number | null = $state(null);
	let selected: Set<string> = $state(new Set());

	let removeOpen = $state(false);
	/** the rows the remove dialog is about; set by the remove verbs, read on confirm */
	let removeRows: RuntimeRow[] = $state([]);
	let removeForce = $state(false);
	let busy = $state('');

	// install dialog
	let installOpen = $state(false);
	let installMachine = $state('');
	let installVendor = $state('any');
	let catalog: CatalogRow[] = $state([]);
	let catalogLoading = $state(false);
	let catalogError = $state('');
	let chosen = $state('');

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api('/runtimes');
			const consumers = (data.consumers ?? {}) as Record<string, Array<{ name: string; machine?: string; kind: string }>>;
			const next: RuntimeRow[] = [];

			machines = data.machineOptions ?? [];
			platforms = {};

			for (const entry of data.machines as Array<any>) {
				platforms[entry.machine] = entry.platform;

				if (entry.runtimes === null) {
					next.push({
						id: `${entry.machine}:?`,
						runtimeId: '',
						machine: entry.machine,
						machineName: entry.name,
						vendor: '',
						version: '',
						feature: 0,
						platform: '',
						usedBy: [],
						unreachable: true
					});

					continue;
				}

				for (const runtime of entry.runtimes as Array<any>) {
					next.push({
						id: `${entry.machine}:${runtime.id}`,
						runtimeId: runtime.id,
						machine: entry.machine,
						machineName: entry.name,
						vendor: runtime.vendor,
						version: runtime.version,
						feature: runtime.feature,
						platform: runtime.platform,
						sizeBytes: runtime.sizeBytes,
						installedAt: runtime.installedAt,
						javaVersionLine: runtime.javaVersionLine,
						usedBy: (consumers[runtime.id] ?? [])
							.filter((consumer) => consumer.kind === 'profile' || consumer.machine === entry.machine)
							.map((consumer) => consumer.name),
						unreachable: false
					});
				}
			}

			rows = next;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.runtimes.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void refresh();
	});

	function fmtSize(bytes?: number): string {
		if (!bytes) {
			return '–';
		}

		return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
	}

	async function loadCatalog(): Promise<void> {
		catalogLoading = true;
		catalogError = '';

		try {
			const params = new URLSearchParams({ machine: installMachine });

			if (installVendor !== 'any') {
				params.set('vendor', installVendor);
			}

			const data = await api(`/runtimes/available?${params}`);

			catalog = data.runtimes ?? [];
		} catch (err) {
			catalog = [];
			catalogError = (err as Error).message;
		} finally {
			catalogLoading = false;
		}
	}

	/** Opening the dialog defaults to the primary and fetches its catalog. */
	function openInstall(): void {
		installMachine = machines.find((machine) => machine.primary)?.name ?? machines[0]?.name ?? '';
		installVendor = 'any';
		chosen = '';
		installOpen = true;
		void loadCatalog();
	}

	async function startInstall(): Promise<void> {
		const id = chosen;
		const machine = installMachine;

		installOpen = false;

		await jobFlash({
			title: t('web.runtimes.installing', { id, machine }),
			start: () => post('/runtimes', { action: 'install', machine, id }),
			success: () => ({
				message: t('web.runtimes.installed', { id, machine })
			}),
			failure: (detail) => ({ message: t('web.runtimes.installFailed', { id, machine }), detail })
		});

		await refresh();
	}

	/** Run a bulk verb behind one notification card, reporting per target. */
	async function run(
		label: string,
		pending: string,
		fn: (note: NotificationHandle) => Promise<void>
	): Promise<void> {
		busy = label;

		const note = Notify.loading(pending);

		try {
			await fn(note);

			if (note.level === 'loading') {
				note.set({ level: 'success', message: pending, closeable: true });
			}
		} catch (err) {
			note.set({ level: 'error', message: pending, detail: (err as Error).message, closeable: true });
		}

		busy = '';
		await refresh();
	}

	function removeMany(targets: RuntimeRow[], force: boolean): Promise<void> {
		return run(
			'remove',
			t('web.runtimes.removingCount', { count: targets.length }),
			async (note) => {
				const failed: string[] = [];

				for (const row of targets) {
					try {
						await post('/runtimes', {
							action: 'remove',
							machine: row.machineName,
							id: row.runtimeId,
							force
						});
					} catch (err) {
						failed.push(`${row.runtimeId} (${row.machineName}): ${(err as Error).message}`);
					}
				}

				const done = targets.length - failed.length;

				note.set({
					level: failed.length === 0 ? 'success' : done > 0 ? 'warning' : 'error',
					message: t('web.runtimes.removedCount', { done, total: targets.length }),
					detail: failed.join(' · '),
					closeable: true
				});

				selected = new Set();
			}
		);
	}

	const columns: Column[] = $derived([
		{ id: 'runtime', label: t('web.runtimes.colRuntime'), sortable: true, width: 220 },
		{ id: 'vendor', label: t('web.runtimes.colVendor'), sortable: true, width: 130 },
		{ id: 'feature', label: t('web.runtimes.colFeature'), sortable: true, width: 100 },
		{ id: 'machine', label: t('web.runtimes.colMachine'), sortable: true, width: 150 },
		{ id: 'platform', label: t('web.runtimes.colPlatform'), sortable: true, width: 140 },
		{ id: 'size', label: t('web.runtimes.colSize'), sortable: true, width: 100, align: 'right' },
		{ id: 'usedBy', label: t('web.runtimes.colUsedBy') },
		{ id: 'reported', label: t('web.runtimes.colReported'), hidden: true }
	]);

	const filters: TableFilterGroup<RuntimeRow>[] = $derived([
		{
			id: 'machine',
			label: t('web.runtimes.filterMachine'),
			options: [
				{ value: 'any', label: t('web.runtimes.anyMachine') },
				...machines.map((machine) => ({
					value: machine.key || 'primary',
					label: machine.name,
					match: (row: RuntimeRow) => row.machine === machine.key
				}))
			]
		},
		{
			id: 'vendor',
			label: t('web.runtimes.filterVendor'),
			options: [
				{ value: 'any', label: t('web.runtimes.anyVendor') },
				{ value: 'temurin', label: 'Temurin', match: (row) => row.vendor === 'temurin' },
				{ value: 'temurin-jre', label: 'Temurin JRE', match: (row) => row.vendor === 'temurin-jre' },
				{ value: 'graalvm-ce', label: 'GraalVM CE', match: (row) => row.vendor === 'graalvm-ce' }
			]
		},
		{
			id: 'usage',
			label: t('web.runtimes.filterUsage'),
			options: [
				{ value: 'any', label: t('web.runtimes.anyUsage') },
				{ value: 'used', label: t('web.runtimes.inUse'), match: (row) => row.usedBy.length > 0 },
				{ value: 'idle', label: t('web.runtimes.unused'), match: (row) => !row.unreachable && row.usedBy.length === 0 }
			]
		}
	]);

	/** Verbs over the current selection; a row's own menu forwards it. */
	function runtimeActions(targets: RuntimeRow[]): ContextMenuItem[] {
		const real = targets.filter((row) => !row.unreachable);
		const used = real.filter((row) => row.usedBy.length > 0);
		const free = real.filter((row) => row.usedBy.length === 0);

		return [
			{
				label: t('web.runtimes.copyId'),
				icon: 'copy',
				disabled: real.length !== 1,
				hint: real.length !== 1 ? t('web.runtimes.pickOne') : undefined,
				action: () => navigator.clipboard?.writeText(real[0]!.runtimeId)
			},
			{ separator: true },
			{
				label: t('web.runtimes.remove', { count: free.length }),
				icon: 'trash',
				color: 'danger',
				disabled: free.length === 0,
				// the runtime that is in use is usually the one an operator meant to
				// keep, so the verb targets the free ones and says how many that is
				hint: free.length === 0 ? t('web.runtimes.allInUse') : undefined,
				action: () => {
					removeRows = free;
					removeForce = false;
					removeOpen = true;
				}
			},
			{
				label: t('web.runtimes.removeForce', { count: used.length }),
				icon: 'triangleExclamation',
				color: 'danger',
				disabled: used.length === 0,
				hint: used.length === 0 ? t('web.runtimes.noneInUse') : undefined,
				action: () => {
					removeRows = used;
					removeForce = true;
					removeOpen = true;
				}
			}
		];
	}

	function rowActions(row: RuntimeRow): ContextMenuItem[] {
		const inSelection = selected.has(row.id) && selected.size > 1;

		return runtimeActions(inSelection ? selRows : [row]);
	}

	const selRows = $derived(rows.filter((row) => selected.has(row.id)));

	/** Distinct runtimes, for the header count; rows outnumber them per machine. */
	const runtimeCount = $derived(new Set(rows.filter((row) => !row.unreachable).map((row) => row.runtimeId)).size);

	const installPlatform = $derived(
		platforms[machines.find((machine) => machine.name === installMachine)?.key ?? ''] ?? null
	);
</script>

<svelte:head><title>{t('web.nav.javaRuntimes')} | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.nav.javaRuntimes')}
	count={runtimeCount}
	description={t('web.runtimes.pageDescription')}
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="runtimes" />
		<Dropdown
			label={t('web.common.actions')}
			disabled={selRows.length === 0 || !!busy}
			menu={selRows.length ? runtimeActions(selRows) : []}
		/>
		<Btn variant="primary" icon="download" onclick={openInstall}>
			{t('web.runtimes.installRuntime')}
		</Btn>
	{/snippet}
</PageHeader>

<Panel flush>
	<ResourceTable
		tableId="runtime-java"
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		{filters}
		{rows}
		getId={(row) => row.id}
		searchValue={(row) =>
			`${row.runtimeId} ${row.vendor} ${row.version} ${row.machineName} ${row.platform} ${row.usedBy.join(' ')}`}
		searchPlaceholder={t('web.runtimes.searchPlaceholder')}
		selectable="multi"
		bind:selected
		{rowActions}
		rowLabel={(row) => `${row.runtimeId} (${row.machineName})`}
		rowLocked={(row) => row.unreachable}
		noun={t('web.runtimes.noun')}
		emptyTitle={t('web.runtimes.emptyTitle')}
		emptyText={t('web.runtimes.emptyText')}
	>
		{#snippet cell(row, col)}
			{#if row.unreachable}
				{#if col === 'runtime'}
					<StatusBadge state="warning" label={t('web.runtimes.unreachable')} />
				{:else if col === 'machine'}
					<a href="/machines/{row.machineName}">{row.machineName}</a>
				{:else if col === 'usedBy'}
					<span class="dim">{t('web.runtimes.unreachableHint')}</span>
				{/if}
			{:else if col === 'runtime'}
				<span class="mono"><b>{row.runtimeId}</b></span>
			{:else if col === 'vendor'}
				{row.vendor}
			{:else if col === 'feature'}
				{row.feature}
			{:else if col === 'machine'}
				<a href="/machines/{row.machineName}">{row.machineName}</a>
			{:else if col === 'platform'}
				<span class="mono">{row.platform}</span>
			{:else if col === 'size'}
				{fmtSize(row.sizeBytes)}
			{:else if col === 'usedBy'}
				{#if row.usedBy.length}
					{row.usedBy.join(', ')}
				{:else}
					<span class="dim">{t('web.runtimes.nobody')}</span>
				{/if}
			{:else if col === 'reported'}
				<span class="dim mono">{row.javaVersionLine ?? '–'}</span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<Modal title={t('web.runtimes.installRuntime')} bind:open={installOpen} wide>
	<div class="install">
		<div class="pickers">
			<Select
				label={t('web.runtimes.machine')}
				bind:value={installMachine}
				width="14rem"
				options={machines.map((machine) => ({ value: machine.name, label: machine.name }))}
				onchange={() => {
					chosen = '';
					void loadCatalog();
				}}
			/>
			<Select
				label={t('web.runtimes.vendor')}
				bind:value={installVendor}
				width="12rem"
				options={[
					{ value: 'any', label: t('web.runtimes.anyVendor') },
					{ value: 'temurin', label: 'Temurin (JDK)' },
					{ value: 'temurin-jre', label: 'Temurin (JRE)' },
					{ value: 'graalvm-ce', label: 'GraalVM CE' }
				]}
				onchange={() => {
					chosen = '';
					void loadCatalog();
				}}
			/>
			<label class="platform">
				<span class="lbl">{t('web.runtimes.colPlatform')}</span>
				<input
					class="input mono"
					readonly
					tabindex="-1"
					value={installPlatform ?? t('web.runtimes.platformUnknown')}
				/>
			</label>
		</div>

		{#if catalogLoading}
			<p class="dim">{t('web.runtimes.loadingCatalog')}</p>
		{:else if catalogError}
			<p class="err">{catalogError}</p>
		{:else if !catalog.length}
			<p class="dim">{t('web.runtimes.catalogEmpty')}</p>
		{:else}
			<div class="catalog">
				{#each catalog as entry (entry.id)}
					<label class="opt" class:on={chosen === entry.id}>
						<input type="radio" name="runtime" value={entry.id} bind:group={chosen} />
						<span class="mono id">{entry.id}</span>
						{#if entry.lts}
							<StatusBadge state="success" label="LTS" />
						{/if}
						<span class="dim size">{entry.size ? `${(entry.size / 1024 / 1024).toFixed(0)} MB` : '–'}</span>
					</label>
				{/each}
			</div>
		{/if}
	</div>

	{#snippet footer()}
		<Btn onclick={() => (installOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" icon="download" disabled={!chosen} onclick={startInstall}>
			{t('web.runtimes.install')}
		</Btn>
	{/snippet}
</Modal>

<ConfirmModal
	bind:open={removeOpen}
	title={t('web.runtimes.removeTitle')}
	lead={removeForce
		? t('web.runtimes.removeForceLead', { count: removeRows.length })
		: t('web.runtimes.removeLead', { count: removeRows.length })}
	notes={removeForce ? [t('web.runtimes.removeForceNote')] : []}
	confirmLabel={t('web.common.remove')}
	onconfirm={() => void removeMany(removeRows, removeForce)}
/>

<style lang="scss">
	.install {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.pickers {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	// the machine decides the platform, so it is shown rather than asked for; it
	// wears Select's inline-label treatment (the label astride the top rule, its
	// own background painting out the border) so the three fields share one edge
	.platform {
		position: relative;
		display: inline-flex;
		flex-direction: column;
		padding-top: 0.5rem;

		.lbl {
			position: absolute;
			top: 0;
			left: 0.5625rem;
			height: 1rem;
			padding: 0 0.25rem 0.125rem;
			background: var(--bg-panel);
			border-radius: 0.125rem;
			font-size: 0.75rem;
			line-height: 0.875rem;
			color: var(--text-heading);
			font-weight: 700;
			white-space: nowrap;
		}

		// same fill and rule as the selects beside it; what marks it inert is the
		// dimmed value and the missing caret, not a different-looking box
		input {
			width: 10rem;
			min-height: var(--control-h);
			background: var(--bg-panel);
			border-color: var(--border-field);
			color: var(--text-dim);
			cursor: default;
		}
	}

	.catalog {
		display: flex;
		flex-direction: column;
		max-height: 22rem;
		overflow-y: auto;
		border: 0.1rem solid var(--border);
		border-radius: 0.25rem;
	}

	.opt {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0.75rem;
		cursor: pointer;

		&:hover {
			background: var(--surface-2);
		}

		&.on {
			background: var(--surface-2);
		}
	}

	.id {
		flex: 1;
	}

	.size {
		font-size: 0.75rem;
	}

	.err {
		color: var(--danger);
	}
</style>
