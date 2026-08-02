<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import { fmtBytes } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import { Notify } from '$lib/notifications.svelte';

	let plan: any = $state(null);
	let busy = $state(false);
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let confirmOpen = $state(false);

	const columns: Column[] = [
		{ id: 'instance', label: 'Instance', sortable: true, width: 140 },
		{ id: 'kind', label: 'Kind', sortable: true, width: 140 },
		{ id: 'path', label: 'Path' },
		{ id: 'size', label: 'Size', sortable: true, width: 180 }
	];

	/** The junk kinds actually present, so the filter never offers an empty one. */
	const junkFilters: TableFilterGroup<any>[] = $derived([
		{
			id: 'kind',
			label: 'Filter kind',
			options: [
				{ value: 'any', label: 'Any kind' },
				...[...new Set(((plan?.junk ?? []) as any[]).map((item) => item.kind as string))]
					.sort()
					.map((kind) => ({
						value: kind,
						label: kind,
						match: (item: any) => item.kind === kind
					}))
			]
		}
	]);

	function junkActions(item: any): ContextMenuItem[] {
		return [
			{
				label: 'Copy path',
				icon: 'copy',
				action: () => navigator.clipboard?.writeText(item.path)
			},
			{
				label: `Open ${item.instance}`,
				icon: 'server',
				disabled: !item.instance || item.instance === '—',
				action: () => goto(`/instances/${item.instance}`)
			}
		];
	}

	async function refresh(): Promise<void> {
		loading = true;

		try {
			plan = (await api('/cleanup')).plan;
			lastUpdated = Date.now();
		} finally {
			loading = false;
		}
	}

	onMount(refresh);

	const byKind = $derived.by(() => {
		if (!plan) {
			return [];
		}

		const totals = new Map<string, { count: number; bytes: number }>();

		for (const item of plan.junk) {
			const cur = totals.get(item.kind) ?? { count: 0, bytes: 0 };

			totals.set(item.kind, { count: cur.count + 1, bytes: cur.bytes + item.bytes });
		}

		return [...totals.entries()];
	});

	const logBytes = $derived(
		plan ? plan.logs.reduce((total: number, log: any) => total + log.bytes, 0) : 0
	);

	const largestJunk = $derived(
		plan ? Math.max(1, ...plan.junk.map((item: any) => item.bytes)) : 1
	);

	/** junk + logs — plan.totalBytes only counts deletions, logs are archived */
	const planTotal = $derived(Math.max(1, (plan?.totalBytes ?? 0) + logBytes));

	const share = (bytes: number): string => `${Math.round((bytes / planTotal) * 100)}% of plan`;

	async function execute(): Promise<void> {
		confirmOpen = false;
		busy = true;

		const note = Notify.loading('Deleting junk and archiving logs…');

		try {
			const res = await post('/cleanup');

			note.set({
				level: 'success',
				message: `Freed ${fmtBytes(res.freedBytes)} across ${res.deleted} items`,
				detail: `Archived ${res.archivedLogs} log files into ${res.archives.length} monthly archive(s).`,
				closeable: true
			});

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: 'Cleanup failed',
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = false;
	}

	let selected: Set<string> = $state(new Set());

	/** The row the header's Actions dropdown acts on. */
	const one = $derived((plan?.junk ?? []).find((row: any) => selected.has(row.path)));
</script>

<svelte:head><title>Cleanup | MRDS Console</title></svelte:head>

<PageHeader
	title="Cleanup"
	description="Caches, stale Paper versions, leftovers and rotated logs — worlds, configs and plugins are never touched"
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="cleanup" />
		<Dropdown label="Actions" disabled={!one} menu={one ? junkActions(one) : []} />
		<Btn
			variant="primary"
			icon="broom"
			loading={busy}
			disabled={!plan || (plan.junk.length === 0 && plan.logs.length === 0)}
			onclick={() => (confirmOpen = true)}
		>
			Run cleanup
		</Btn>
	{/snippet}
</PageHeader>

{#if plan}
	<div class="cards">
		{#each byKind as [kind, totals]}
			<div class="card">
				<div class="num">{fmtBytes(totals.bytes)}</div>
				<div class="dim">{kind} · {totals.count} item(s)</div>
				<ProgressBar value={totals.bytes} max={planTotal} right={share(totals.bytes)} />
			</div>
		{/each}
		<div class="card">
			<div class="num">{plan.logs.length}</div>
			<div class="dim">rotated logs ({fmtBytes(logBytes)}) → monthly archives</div>
			<ProgressBar value={logBytes} max={planTotal} color="success" right={share(logBytes)} />
		</div>
		<div class="card">
			<div class="num total">{fmtBytes(plan.totalBytes)}</div>
			<div class="dim">total to free</div>
		</div>
	</div>

	{#each plan.notes as note}
		<p class="dim note">note: {note}</p>
	{/each}

	<Panel title="Planned deletions" count={plan.junk.length} flush>
		<ResourceTable
			tableId="cleanup-junk"
			{columns}
			rows={plan.junk}
			getId={(item) => item.path}
			searchValue={(item) => `${item.instance} ${item.kind} ${item.path}`}
			searchPlaceholder="Find a path"
			filters={junkFilters}
			selectable="single"
			bind:selected
			rowActions={junkActions}
			rowLabel={(item) => item.path}
			noun="entry"
			sortValue={(item, col) => (col === 'size' ? item.bytes : (item as any)[col])}
			maxHeight="46vh"
			emptyTitle="Nothing to delete"
		>
			{#snippet cell(item, col)}
				{#if col === 'instance'}
					{item.instance}
				{:else if col === 'kind'}
					{item.kind}
				{:else if col === 'path'}
					<span class="mono dim">{item.path}</span>
				{:else}
					<ProgressBar
						compact
						value={item.bytes}
						max={largestJunk}
						right={fmtBytes(item.bytes)}
					/>
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>
{/if}

<Modal title="Run cleanup" bind:open={confirmOpen}>
	<p>
		Deletes caches, stale Paper versions and leftovers ({plan
			? fmtBytes(plan.totalBytes)
			: ''}), and merges rotated logs into
		<code class="inline">logs/&lt;instance&gt;/&lt;YYYY-MM&gt;.log.gz</code>.
	</p>
	{#snippet footer()}
		<Btn onclick={() => (confirmOpen = false)}>Cancel</Btn>
		<Btn variant="primary" onclick={execute}>Clean up</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11.25rem, 1fr));
		gap: 0.75rem;
		margin-bottom: 0.75rem;
	}

	.card {
		background: var(--bg-panel);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);
		padding: 0.875rem 1rem;

		// the bar is a ProgressBar instance, hence :global
		:global(.pb) {
			margin-top: 0.625rem;
		}
	}

	.num {
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--text-heading);

		&.total {
			color: var(--success);
		}
	}

	.note {
		margin: 0.25rem 0 0.75rem;
	}
</style>
