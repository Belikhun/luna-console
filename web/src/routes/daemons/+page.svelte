<script lang="ts">
	import { onMount } from 'svelte';
	import { api, del } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import type { Column } from '$lib/components/table';

	interface DaemonRow {
		name: string;
		mode: 'primary' | 'follower';
		host: string | null;
		online: boolean;
		version: string | null;
		connectedAt: number | null;
		lastSeen: string | null;
		stats: {
			load1: number;
			memUsedMb: number;
			memTotalMb: number;
			states: Record<string, string>;
		} | null;
		instances: string[];
	}

	let daemons: DaemonRow[] = $state([]);
	let loaded = $state(false);
	let removeTarget: DaemonRow | undefined = $state();
	let removeOpen = $state(false);
	let removing = $state(false);

	const columns: Column[] = [
		{ id: 'state', label: 'State', width: 120 },
		{ id: 'name', label: 'Daemon', sortable: true },
		{ id: 'mode', label: 'Mode', width: 110, sortable: true },
		{ id: 'host', label: 'Host', width: 170 },
		{ id: 'instances', label: 'Instances' },
		{ id: 'load', label: 'Load', width: 90, align: 'right' },
		{ id: 'memory', label: 'Memory', width: 140 },
		{ id: 'seen', label: 'Last seen', width: 170 },
		{ id: 'actions', label: '', width: 60, align: 'right' }
	];

	async function refresh(): Promise<void> {
		const data = await api('/daemons');

		daemons = data.daemons;
		loaded = true;
	}

	onMount(refresh);

	function openRemove(row: DaemonRow): void {
		removeTarget = row;
		removeOpen = true;
	}

	async function remove(): Promise<void> {
		if (!removeTarget) {
			return;
		}

		removing = true;

		try {
			await del(`/daemons/${encodeURIComponent(removeTarget.name)}`);

			Notify.success(`Removed daemon registration "${removeTarget.name}"`);
			removeOpen = false;

			await refresh();
		} catch (err) {
			Notify.error('Could not remove the daemon', { detail: (err as Error).message });
		}

		removing = false;
	}

	function seenLabel(row: DaemonRow): string {
		if (row.online) {
			return 'now';
		}

		if (!row.lastSeen) {
			return 'never';
		}

		return new Date(row.lastSeen).toLocaleString();
	}
</script>

<svelte:head><title>Daemons | MRDS Console</title></svelte:head>

<PageHeader
	title="Daemons"
	count={daemons.length}
	description="Machines running an mrds daemon — the primary owns the registry, plugins and schedules; followers manage the instances assigned to them and mirror everything else from the primary"
>
	{#snippet actions()}
		<Btn variant="icon" icon="sync" title="Refresh" onclick={refresh} />
	{/snippet}
</PageHeader>

<Panel flush>
	<DataTable
		{columns}
		rows={daemons}
		getId={(row) => row.name}
		sortValue={(row, col) => (col === 'state' ? String(row.online) : ((row as any)[col] ?? ''))}
	>
		{#snippet cell(row, col)}
			{#if col === 'state'}
				<StatusBadge
					state={row.online ? 'ok' : 'stopped'}
					label={row.online ? 'Online' : 'Offline'}
				/>
			{:else if col === 'name'}
				<b>{row.name}</b>
			{:else if col === 'mode'}
				{row.mode}
			{:else if col === 'host'}
				{#if row.host}
					<span class="mono">{row.host}</span>
				{:else}
					<span class="dim">—</span>
				{/if}
			{:else if col === 'instances'}
				{#if row.instances.length}
					{#each row.instances as name, i}
						{#if i > 0}<span class="dim">, </span>{/if}
						<a href="/instances/{name}">{name}</a>
					{/each}
				{:else}
					<span class="dim">none</span>
				{/if}
			{:else if col === 'load'}
				{#if row.stats}
					<span class="mono">{row.stats.load1.toFixed(2)}</span>
				{:else}
					<span class="dim">—</span>
				{/if}
			{:else if col === 'memory'}
				{#if row.stats}
					<span class="mono">{row.stats.memUsedMb} / {row.stats.memTotalMb} MB</span>
				{:else}
					<span class="dim">—</span>
				{/if}
			{:else if col === 'seen'}
				{#if row.online}
					<StatusBadge state="ok" label="connected" />
				{:else}
					{seenLabel(row)}
				{/if}
			{:else if col === 'actions'}
				{#if row.mode === 'follower' && !row.online}
					<Btn
						variant="icon"
						icon="trash"
						title="Remove registration"
						onclick={() => openRemove(row)}
					/>
				{/if}
			{/if}
		{/snippet}
	</DataTable>

	{#if loaded && daemons.length === 1}
		<div class="hint">
			No followers yet — run <code>mrds daemon run</code> on another machine with
			<code>mode: "follower"</code> and this primary's address + token in its daemon config.
		</div>
	{/if}
</Panel>

<Modal title="Remove daemon registration" bind:open={removeOpen}>
	<p>
		Remove <b>{removeTarget?.name}</b> from the daemons registry? Its machine can re-register at
		any time by connecting again.
	</p>

	{#snippet footer()}
		<Btn onclick={() => (removeOpen = false)}>Cancel</Btn>
		<Btn variant="danger" loading={removing} onclick={remove}>Remove</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.hint {
		padding: 0.75rem 1rem;
		color: var(--text-secondary);
		font-size: 0.875rem;
		border-top: 0.1rem solid var(--border-divider);

		code {
			font-size: 0.8125rem;
		}
	}

	.mono {
		font-variant-numeric: tabular-nums;
	}

	.dim {
		color: var(--text-secondary);
	}
</style>
