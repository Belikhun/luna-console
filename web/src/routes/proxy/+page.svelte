<script lang="ts">
	import { onMount } from 'svelte';
	import { api, post } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import type { Column } from '$lib/components/table';

	/** One row of the sync preview: what velocity.toml has vs what it should have. */
	interface RouteRow {
		server: string;
		address: string;
		state: 'sync' | 'change' | 'add' | 'remove';
		to?: string;
	}

	let data: any = $state(null);
	let reload = $state(true);
	let busy = $state(false);

	const columns: Column[] = [
		{ id: 'server', label: 'Server', width: 180 },
		{ id: 'address', label: 'Address', width: 220 },
		{ id: 'state', label: 'State' }
	];

	const rows = $derived.by(() => {
		if (!data) {
			return [];
		}

		const out: RouteRow[] = [];
		const desired = data.desired as Record<string, string>;
		const onDisk = data.onDisk as Record<string, string>;

		for (const [name, address] of Object.entries(onDisk)) {
			if (desired[name] === address) {
				out.push({ server: name, address, state: 'sync' });
			} else if (desired[name]) {
				out.push({ server: name, address, state: 'change', to: desired[name] });
			} else {
				out.push({ server: name, address, state: 'remove' });
			}
		}

		for (const name of Object.keys(desired).filter((entry) => !(entry in onDisk))) {
			out.push({ server: name, address: '', state: 'add', to: desired[name] });
		}

		return out;
	});

	const forcedHostsLabel = $derived.by(() => {
		if (!data) {
			return '';
		}

		const entries = Object.entries(data.forcedHosts as Record<string, string[]>);

		return entries.map(([host, servers]) => `${host} → ${servers}`).join(' · ') || '(none)';
	});

	async function refresh(): Promise<void> {
		data = await api('/proxy');
	}

	onMount(refresh);

	async function apply(): Promise<void> {
		busy = true;

		const note = Notify.loading('Writing velocity.toml…');

		try {
			const res = await post('/proxy', { reload });

			note.set({
				level: 'success',
				message: `velocity.toml ${res.changed ? 'updated' : 'already in sync'}`,
				detail: res.reloaded ? 'Proxy reloaded.' : '',
				closeable: true
			});

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: 'Could not apply proxy configuration',
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = false;
	}
</script>

<svelte:head><title>Proxy routing | MRDS Console</title></svelte:head>

<PageHeader
	title="Proxy routing"
	description="velocity.toml [servers] and [forced-hosts] are generated from cluster.json — review and apply"
>
	{#snippet actions()}
		<label class="reload">
			<Checkbox
				checked={reload}
				label="Run velocity reload after apply"
				onchange={(value) => (reload = value)}
			/>
			Run <code class="inline">velocity reload</code> after apply
		</label>
		<Btn variant="primary" loading={busy} disabled={!data} onclick={apply}>Sync velocity.toml</Btn>
	{/snippet}
</PageHeader>

{#if data}
	{#if data.changed}
		<Flash kind="warning">
			velocity.toml differs from cluster.json — review the changes below and apply.
		</Flash>
	{:else}
		<Flash kind="success">velocity.toml matches the instance registry.</Flash>
	{/if}

	<div class="cols">
		<Panel title="Registered servers" flush>
			<DataTable {columns} {rows} getId={(row) => row.server}>
				{#snippet cell(row, col)}
					{#if col === 'server'}
						{row.server}
					{:else if col === 'address'}
						<span class="mono">{row.address || '–'}</span>
					{:else if row.state === 'sync'}
						<span class="ok">in sync</span>
					{:else if row.state === 'change'}
						<span class="warn">→ {row.to}</span>
					{:else if row.state === 'add'}
						<span class="ok">will be added ({row.to})</span>
					{:else}
						<span class="err">not in registry (will be removed)</span>
					{/if}
				{/snippet}
			</DataTable>
			<div class="meta dim">
				try order: {data.tryList.join(' → ') || '(empty)'}<br />
				forced hosts: {forcedHostsLabel}
			</div>
		</Panel>
		<Panel title="Generated TOML sections" flush>
			<pre class="code mono">{data.preview}</pre>
		</Panel>
	</div>
{/if}

<style lang="scss">
	.reload {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		font-size: 0.875rem;
	}

	.cols {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;

		@include below($bp-wide) {
			grid-template-columns: 1fr;
		}
	}

	.code {
		margin: 0;
		padding: 0.875rem 1rem;
		font-size: 0.75rem;
		overflow-x: auto;
		background: var(--bg-terminal);
		min-height: 100%;
	}

	.ok {
		color: var(--success);
	}

	.warn {
		color: var(--warning);
	}

	.err {
		color: var(--error);
	}

	.meta {
		padding: 0.75rem 1rem;
		border-top: 0.1rem solid var(--border-divider);
		font-size: 0.75rem;
	}
</style>
