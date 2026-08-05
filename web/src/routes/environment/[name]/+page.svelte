<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, del, post } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * One environment variable, as an object rather than a table row: the scopes
	 * that define it, everywhere it is referenced from, what each instance actually
	 * resolves it to, and its change trail.
	 *
	 * The screen exists because changing a shared value is the risky part — an
	 * operator about to edit a database password should be able to see the 12 files
	 * and 8 instances that read it *before* saving, not after.
	 */

	interface ScopeRow {
		scope: 'global' | 'machine' | 'instance';
		target: string | null;
		targetLabel: string | null;
		value: string;
	}

	interface ReferenceRow {
		kind: 'managed-file' | 'plugin-template';
		instance?: string;
		file: string;
		count?: number;
		plugin?: string;
		key?: string;
	}

	interface ConsumerRow {
		instance: string;
		value: string;
		scope: string;
		machine: string;
		machineLabel: string;
	}

	interface HistoryRow {
		t: number;
		action: 'set' | 'unset' | 'reveal';
		scope: string;
		target?: string;
		targetLabel: string | null;
	}

	interface Detail {
		name: string;
		builtin: boolean;
		secret: boolean;
		description: string;
		updatedAt: string | null;
		defined: boolean;
		machines: Array<{ key: string; name: string; primary: boolean }>;
		scopes: ScopeRow[];
		references: ReferenceRow[];
		consumers: ConsumerRow[];
		history: HistoryRow[];
	}

	const name = $derived(page.params.name!);

	let detail = $state<Detail | null>(null);
	let loading = $state(false);
	let missing = $state(false);
	let lastUpdated: number | null = $state(null);
	let tab = $state('details');

	/**
	 * Values revealed this session, keyed by scope. Kept in memory only — a reload
	 * masks everything again, so a secret never lingers on a screen someone walked
	 * away from.
	 */
	let revealed: Record<string, string> = $state({});

	function scopeKey(row: { scope: string; target?: string | null }): string {
		return `${row.scope}:${row.target ?? ''}`;
	}

	async function refresh(): Promise<void> {
		loading = true;

		try {
			detail = await api(`/env/${encodeURIComponent(name)}`);
			lastUpdated = Date.now();
			missing = false;
		} catch (err) {
			missing = true;
			Notify.error(`Could not load ${name}`, { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void refresh();
	});

	/** Ask the server for one scope's real value, which records the read. */
	async function reveal(row: ScopeRow): Promise<void> {
		try {
			const result = await post(`/env/${encodeURIComponent(name)}/reveal`, {
				machine: row.scope === 'machine' ? row.targetLabel : undefined,
				instance: row.scope === 'instance' ? row.target : undefined
			});

			revealed = { ...revealed, [scopeKey(row)]: result.value };
		} catch (err) {
			Notify.error('Could not reveal the value', { detail: (err as Error).message });
		}
	}

	function hide(row: ScopeRow): void {
		const next = { ...revealed };

		delete next[scopeKey(row)];
		revealed = next;
	}

	async function removeScope(row: ScopeRow): Promise<void> {
		const where =
			row.scope === 'global'
				? 'from every instance in the cluster'
				: `from ${row.scope} ${row.targetLabel}`;

		if (!confirm(`Remove ${name} ${where}?`)) {
			return;
		}

		const query =
			row.scope === 'machine'
				? `&machine=${encodeURIComponent(row.targetLabel ?? '')}`
				: row.scope === 'instance'
					? `&instance=${encodeURIComponent(row.target ?? '')}`
					: '';

		try {
			await del(`/env?name=${encodeURIComponent(name)}${query}`);
			Notify.success(`${name} removed ${where}`, {
				detail: 'Instances keep the old value until they restart.'
			});

			// the whole variable may be gone now
			await refresh();

			if (row.scope === 'global' && !detail?.scopes.length) {
				await goto('/environment');
			}
		} catch (err) {
			Notify.error(`Could not remove ${name}`, { detail: (err as Error).message });
		}
	}

	function editHref(row?: ScopeRow): string {
		const params = new URLSearchParams({ name });

		if (row?.scope === 'machine') {
			params.set('machine', row.targetLabel ?? '');
		}

		if (row?.scope === 'instance') {
			params.set('instance', row.target ?? '');
		}

		return `/environment/new?${params}`;
	}

	const scopeColumns: Column[] = [
		{ id: 'scope', label: 'Scope', sortable: true, width: 120 },
		{ id: 'target', label: 'Applies to', sortable: true, width: 200 },
		{ id: 'value', label: 'Value' }
	];

	const refColumns: Column[] = [
		{ id: 'where', label: 'Where', sortable: true, width: 200 },
		{ id: 'file', label: 'File', sortable: true },
		{ id: 'detail', label: '', width: 180 }
	];

	const consumerColumns: Column[] = [
		{ id: 'instance', label: 'Instance', sortable: true, width: 180 },
		{ id: 'machine', label: 'Machine', sortable: true, width: 180 },
		{ id: 'scope', label: 'Source', sortable: true, width: 130 },
		{ id: 'value', label: 'Value' }
	];

	const historyColumns: Column[] = [
		{ id: 'time', label: 'When', width: 200 },
		{ id: 'action', label: 'Change', width: 140 },
		{ id: 'scope', label: 'Scope', width: 130 },
		{ id: 'target', label: 'Applies to' }
	];

	function scopeActions(row: ScopeRow): ContextMenuItem[] {
		return [
			{ label: 'Edit this value', icon: 'pen', action: () => goto(editHref(row)) },
			{
				label: revealed[scopeKey(row)] ? 'Hide value' : 'Reveal value',
				icon: revealed[scopeKey(row)] ? 'eyeSlash' : 'eye',
				disabled: !detail?.secret,
				action: () => (revealed[scopeKey(row)] ? hide(row) : reveal(row))
			},
			{
				label: 'Copy value',
				icon: 'copy',
				disabled: detail?.secret && !revealed[scopeKey(row)],
				action: () =>
					navigator.clipboard?.writeText(revealed[scopeKey(row)] ?? row.value)
			},
			{ separator: true },
			{
				label: 'Remove this value',
				icon: 'trash',
				color: 'danger',
				action: () => removeScope(row)
			}
		];
	}

	function referenceActions(row: ReferenceRow): ContextMenuItem[] {
		if (row.kind === 'managed-file' && row.instance) {
			return [
				{
					label: `Open in ${row.instance}'s files`,
					icon: 'fileCode',
					action: () => goto(`/instances/${row.instance}/files`)
				}
			];
		}

		return [
			{
				label: `Open plugin ${row.plugin}`,
				icon: 'plug',
				action: () => goto(`/plugins?q=${encodeURIComponent(row.plugin ?? '')}`)
			}
		];
	}

	const summaryCells: InfoCell[] = $derived(
		!detail
			? []
			: [
					// no `id`: InfoGrid hands every identified cell to the `custom` snippet,
					// and this one wants its plain value rendering
					{ label: 'Name', value: detail.name, style: 'mono', copyable: true },
					{ id: 'kind', label: 'Kind' },
					{
						label: 'Description',
						value: detail.description || '–',
						colSpan: 2
					},
					{
						label: 'Last changed',
						value: detail.updatedAt ? fmtDateTime(Date.parse(detail.updatedAt)) : '–'
					},
					{ id: 'scopes', label: 'Defined at' },
					{ id: 'refs', label: 'Referenced by' },
					{ id: 'consumers', label: 'Resolved by' }
				]
	);

	const managedRefs = $derived(detail?.references.filter((row) => row.kind === 'managed-file') ?? []);
	const pluginRefs = $derived(detail?.references.filter((row) => row.kind === 'plugin-template') ?? []);
</script>

<svelte:head><title>{name} | Luna Console</title></svelte:head>

{#if missing}
	<PageHeader title={name} description="Environment variable" />
	<Flash kind="error">
		{name} is not defined at any scope, and no builtin goes by that name.
		<a href="/environment">Back to the environment</a>
	</Flash>
{:else if detail}
	<PageHeader
		title={detail.name}
		description={detail.description ||
			(detail.builtin
				? 'A builtin — computed per instance rather than stored'
				: 'Environment variable')}
		info
	>
		{#snippet extra()}
			{#if detail!.secret}
				<StatusBadge
					state="warning"
					label="secret"
					detail="The value is withheld from every listing. Revealing it is recorded in the change trail below."
				/>
			{/if}
			{#if detail!.builtin}
				<StatusBadge state="info" label="builtin" detail="Computed per instance at resolve time — it cannot be set or removed." />
			{/if}
			{#if detail!.consumers.length === 0}
				<StatusBadge
					state="failed"
					label="unresolvable"
					detail="No scope defines this name, so any file referencing it refuses to render."
				/>
			{/if}
		{/snippet}
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="env-detail" />
			<Btn icon="layerGroup" href={editHref()} disabled={detail!.builtin}>Add an override</Btn>
			<Btn variant="primary" icon="pen" href={editHref()} disabled={detail!.builtin}>Edit value</Btn>
		{/snippet}
	</PageHeader>

	<OverviewBar title="Variable overview">
		<OverviewCell label="Scopes defining it">
			{detail.scopes.length}
			{#if detail.scopes.length}
				<span class="dim">({detail.scopes.map((row) => row.scope).join(', ')})</span>
			{/if}
		</OverviewCell>
		<OverviewCell label="Config files reading it">
			{managedRefs.length}
			{#if pluginRefs.length}
				<span class="dim">+ {pluginRefs.length} plugin template(s)</span>
			{/if}
		</OverviewCell>
		<OverviewCell label="Instances resolving it">
			{detail.consumers.length}
		</OverviewCell>
		<OverviewCell label="Recorded changes">
			{detail.history.length}
		</OverviewCell>
	</OverviewBar>

	<Tabs
		tabs={[
			{ id: 'details', label: 'Details' },
			{ id: 'usage', label: 'Usage' },
			{ id: 'resolution', label: 'Resolution' },
			{ id: 'history', label: 'History' }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'details'}
			<Panel title="Summary">
				<InfoGrid cells={summaryCells}>
					{#snippet custom(cell)}
						{#if cell.id === 'kind'}
							{#if detail!.builtin}
								<span>Builtin</span>
							{:else if detail!.secret}
								<span>Secret</span>
							{:else}
								<span>Plain value</span>
							{/if}
						{:else if cell.id === 'scopes'}
							{detail!.scopes.length} scope(s)
						{:else if cell.id === 'refs'}
							{detail!.references.length} reference(s)
						{:else if cell.id === 'consumers'}
							{detail!.consumers.length} instance(s)
						{/if}
					{/snippet}
				</InfoGrid>
			</Panel>

			<div class="gap"></div>

			<Panel
				title="Values by scope"
				count={detail.scopes.length}
				description="A narrower scope overrides a wider one for the instances it covers — builtin < global < machine < instance"
				flush
			>
				{#if detail.scopes.length}
					<DataTable
						columns={scopeColumns}
						rows={detail.scopes}
						getId={(row) => scopeKey(row)}
						rowActions={scopeActions}
						rowLabel={(row) => `${row.scope} ${row.targetLabel ?? ''}`}
					>
						{#snippet cell(row, col)}
							{#if col === 'scope'}
								<span class="scope {row.scope}">{row.scope}</span>
							{:else if col === 'target'}
								{#if row.scope === 'instance'}
									<a href="/instances/{row.target}">{row.target}</a>
								{:else if row.scope === 'machine'}
									<a href="/machines/{row.targetLabel}">{row.targetLabel}</a>
								{:else}
									<span class="dim">every instance</span>
								{/if}
							{:else if col === 'value'}
								{#if !detail!.secret}
									<span class="mono">{row.value || '(empty)'}</span>
								{:else if revealed[scopeKey(row)] !== undefined}
									<span class="mono">{revealed[scopeKey(row)] || '(empty)'}</span>
									<button class="peek" onclick={() => hide(row)} title="Hide again">
										<Icon name="eyeSlash" size="0.75rem" style="solid" />
									</button>
								{:else}
									<span class="dim">••••••••</span>
									<button class="peek" onclick={() => reveal(row)} title="Reveal this value">
										<Icon name="eye" size="0.75rem" style="solid" />
										reveal
									</button>
								{/if}
							{/if}
						{/snippet}
					</DataTable>
				{:else if detail.builtin}
					<p class="none dim">
						This is a builtin: it is computed for each instance at resolve time and stored nowhere.
						See what an instance resolves under the Resolution tab.
					</p>
				{:else}
					<p class="none dim">No scope defines this variable.</p>
				{/if}
			</Panel>

			{#if detail.secret}
				<div class="gap"></div>
				<Flash kind="info">
					Secret values are withheld from every listing and never sent to a browser until you
					reveal one, which is recorded under History. Masking is a console concern: the value is
					still written into each instance's <span class="mono">.luna-env</span> (mode 0600) and
					into whatever config file references it.
				</Flash>
			{/if}
		{:else if tab === 'usage'}
			<Panel
				title="Managed config files"
				count={managedRefs.length}
				description="Files luna renders from a template on every start, whose template references this variable"
				flush
			>
				{#if managedRefs.length}
					<DataTable
						columns={refColumns}
						rows={managedRefs}
						getId={(row) => `${row.instance}:${row.file}`}
						rowActions={referenceActions}
						rowLabel={(row) => row.file}
					>
						{#snippet cell(row, col)}
							{#if col === 'where'}
								<a href="/instances/{row.instance}/files">{row.instance}</a>
							{:else if col === 'file'}
								<span class="mono">{row.file}</span>
							{:else if col === 'detail'}
								<span class="dim">{row.count} occurrence{row.count === 1 ? '' : 's'}</span>
							{/if}
						{/snippet}
					</DataTable>
				{:else}
					<p class="none dim">
						No managed config file references this variable. Instances still export it into their
						JVM at startup — see Resolution.
					</p>
				{/if}
			</Panel>

			<div class="gap"></div>

			<Panel
				title="Plugin config templates"
				count={pluginRefs.length}
				description="Per-plugin config ops from the lockfile, applied to every instance the plugin targets"
				flush
			>
				{#if pluginRefs.length}
					<DataTable
						columns={refColumns}
						rows={pluginRefs}
						getId={(row) => `${row.plugin}:${row.file}:${row.key ?? ''}`}
						rowActions={referenceActions}
						rowLabel={(row) => row.plugin ?? row.file}
					>
						{#snippet cell(row, col)}
							{#if col === 'where'}
								<b>{row.plugin}</b>
							{:else if col === 'file'}
								<span class="mono">{row.file}</span>
							{:else if col === 'detail'}
								<span class="mono dim">{row.key ?? 'whole file'}</span>
							{/if}
						{/snippet}
					</DataTable>
				{:else}
					<p class="none dim">No plugin config template references this variable.</p>
				{/if}
			</Panel>
		{:else if tab === 'resolution'}
			<Panel
				title="What each instance resolves"
				count={detail.consumers.length}
				description="Every instance exports this into its JVM at startup; the scope column is the layer that won for that instance"
				flush
			>
				{#if detail.consumers.length}
					<DataTable
						columns={consumerColumns}
						rows={detail.consumers}
						getId={(row) => row.instance}
						rowLabel={(row) => row.instance}
						rowActions={(row) => [
							{
								label: `Open ${row.instance}`,
								icon: 'server',
								action: () => goto(`/instances/${row.instance}`)
							},
							{
								label: 'Override for this instance',
								icon: 'layerGroup',
								action: () =>
									goto(`/environment/new?name=${encodeURIComponent(name)}&instance=${row.instance}`)
							}
						]}
					>
						{#snippet cell(row, col)}
							{#if col === 'instance'}
								<a href="/instances/{row.instance}">{row.instance}</a>
							{:else if col === 'machine'}
								<a href="/machines/{row.machineLabel}">{row.machineLabel}</a>
							{:else if col === 'scope'}
								<span class="scope {row.scope}">{row.scope}</span>
							{:else if col === 'value'}
								{#if detail!.secret}
									<span class="dim">••••••••</span>
								{:else}
									<span class="mono">{row.value || '(empty)'}</span>
								{/if}
							{/if}
						{/snippet}
					</DataTable>
				{:else}
					<p class="none dim">
						No instance resolves this name — every reference to it refuses to render until a scope
						defines it.
					</p>
				{/if}
			</Panel>
		{:else if tab === 'history'}
			<Panel
				title="Change trail"
				count={detail.history.length}
				description="Recorded in the environment store, so it survives a daemon restart. Values are never recorded — only that a scope changed, and that a secret was revealed in the console."
				flush
			>
				{#if detail.history.length}
					<DataTable
						columns={historyColumns}
						rows={detail.history}
						getId={(row) => `${row.t}:${row.action}:${row.scope}:${row.target ?? ''}`}
					>
						{#snippet cell(row, col)}
							{#if col === 'time'}
								<span class="dim">{fmtDateTime(row.t)}</span>
							{:else if col === 'action'}
								<StatusBadge
									state={row.action === 'unset'
										? 'warning'
										: row.action === 'reveal'
											? 'info'
											: 'ok'}
									label={row.action === 'set'
										? 'value set'
										: row.action === 'unset'
											? 'removed'
											: 'revealed'}
								/>
							{:else if col === 'scope'}
								<span class="scope {row.scope}">{row.scope}</span>
							{:else if col === 'target'}
								{#if row.scope === 'global'}
									<span class="dim">every instance</span>
								{:else}
									<span>{row.targetLabel ?? row.target}</span>
								{/if}
							{/if}
						{/snippet}
					</DataTable>
				{:else}
					<p class="none dim">
						Nothing recorded yet. The trail starts when a value is set, removed or revealed
						through luna.
					</p>
				{/if}
			</Panel>
		{/if}
	</div>
{/if}

<style lang="scss">
	.tabbody {
		margin-top: 1rem;
	}

	.gap {
		height: 1rem;
	}

	.none {
		margin: 0;
		padding: 1rem 1.25rem;
		font-size: 0.8125rem;
	}

	// the scope vocabulary is coloured the same way everywhere it appears
	.scope {
		font-size: 0.75rem;

		&.global {
			color: var(--link);
		}

		&.machine {
			color: var(--warning);
		}

		&.instance {
			color: var(--success);
		}

		&.builtin {
			color: var(--text-secondary);
		}
	}

	.peek {
		@include bare-button;

		display: inline-flex;
		align-items: center;
		gap: 0.25rem;

		margin-left: 0.5rem;
		color: var(--link);
		font-size: 0.75rem;

		&:hover {
			text-decoration: underline;
		}
	}
</style>
