<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { api, del, post } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { checksFailed, checksPassed, diskPct, fmtGb, latencyTone, memPct } from '$lib/daemons';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import type { DaemonRow } from '$client/daemon';

	let daemons: DaemonRow[] = $state([]);
	let loaded = $state(false);
	let loading = $state(false);
	let lastUpdated: number | null = $state(null);
	let removeTarget: DaemonRow | undefined = $state();
	let removeOpen = $state(false);
	let removing = $state(false);
	let joinOpen = $state(false);

	const filters: TableFilterGroup<DaemonRow>[] = [
		{
			id: 'state',
			label: 'Filter state',
			options: [
				{ value: 'any', label: 'Any state' },
				{ value: 'online', label: 'Online', match: (row) => row.online },
				{ value: 'offline', label: 'Offline', match: (row) => !row.online },
				{
					value: 'degraded',
					label: 'Degraded',
					match: (row) => row.online && checksFailed(row) > 0
				}
			]
		},
		{
			id: 'mode',
			label: 'Filter role',
			options: [
				{ value: 'any', label: 'Any role' },
				{ value: 'primary', label: 'Primary', match: (row) => row.mode === 'primary' },
				{ value: 'follower', label: 'Follower', match: (row) => row.mode === 'follower' }
			]
		}
	];

	function rowActions(row: DaemonRow): ContextMenuItem[] {
		return [
			{
				label: 'Open daemon',
				icon: 'circleInfo',
				action: () => goto(`/machines/${row.name}`)
			},
			{
				label: 'Monitoring',
				icon: 'chartLine',
				action: () => goto(`/machines/${row.name}?tab=monitoring`)
			},
			{
				label: 'Events',
				icon: 'clockRotateLeft',
				action: () => goto(`/machines/${row.name}?tab=events`)
			},
			{
				label: row.outdated ? 'Upgrade daemon' : 'Reinstall binary',
				icon: 'download',
				disabled: row.mode !== 'follower' || !row.online,
				hint:
					row.mode !== 'follower'
						? 'the primary is the source of the binary'
						: !row.online
							? 'the daemon is not connected'
							: undefined,
				action: () => goto(`/machines/${row.name}`)
			},
			{ separator: true },
			{
				label: 'Copy routing host',
				icon: 'copy',
				disabled: !row.host,
				action: () => navigator.clipboard?.writeText(row.host ?? '')
			},
			{
				label: 'Copy IP addresses',
				icon: 'copy',
				disabled: row.addresses.length === 0,
				action: () => navigator.clipboard?.writeText(row.addresses.join(', '))
			},
			{ separator: true },
			{
				label: 'Remove registration',
				icon: 'trash',
				color: 'danger',
				// the primary is not a registration, and a live follower would just
				// re-register on its next heartbeat
				disabled: row.mode !== 'follower' || row.online || row.instances.length > 0,
				hint:
					row.mode !== 'follower'
						? 'this is the primary daemon, not a registration'
						: row.online
							? 'the daemon is connected — stop it first'
							: row.instances.length > 0
								? `it still owns ${row.instances.join(', ')}`
								: undefined,
				action: () => openRemove(row)
			}
		];
	}

	const columns: Column[] = [
		{ id: 'state', label: 'State', width: 110 },
		{ id: 'name', label: 'Daemon', width: 150, sortable: true },
		{ id: 'checks', label: 'Status check', width: 180, sortable: true },
		{ id: 'mode', label: 'Mode', width: 90, sortable: true },
		{ id: 'host', label: 'Host', width: 130 },
		{ id: 'instances', label: 'Instances' },
		{ id: 'cpu', label: 'CPU', width: 130, sortable: true },
		{ id: 'memory', label: 'Memory', width: 165, sortable: true },
		{ id: 'disk', label: 'Disk', width: 175, sortable: true },
		{ id: 'latency', label: 'Latency', width: 115, align: 'right', sortable: true },
		{ id: 'seen', label: 'Last seen', width: 160 },
		{ id: 'version', label: 'Version', width: 170, sortable: true, hidden: true }
	];

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api('/daemons');

			daemons = data.daemons;
			lastUpdated = Date.now();
			loaded = true;
		} catch (err) {
			Notify.error('Could not load the machines', { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void refresh();

		// the hub already holds every daemon's latest heartbeat, so the fleet's
		// health arrives as a stream rather than a poll per machine
		const stream = new EventSource('/api/daemons/stream');

		stream.onmessage = (event) => {
			const frame = JSON.parse(event.data);

			if (Array.isArray(frame.daemons)) {
				daemons = frame.daemons;
				lastUpdated = Date.now();
				loaded = true;
			}
		};

		return () => stream.close();
	});

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
		if (!row.lastSeen) {
			return 'never';
		}

		return new Date(row.lastSeen).toLocaleString();
	}

	/** The daemon.json a new follower needs, filled in from this primary's row. */
	const joinConfig = $derived.by(() => {
		const primary = daemons.find((row) => row.mode === 'primary');
		const listen = primary?.host ?? '0.0.0.0:8331';
		const port = listen.slice(listen.lastIndexOf(':') + 1);
		const address = `${primary?.addresses[0] ?? '10.0.0.10'}:${port}`;

		return JSON.stringify(
			{
				mode: 'follower',
				root: '/srv/luna',
				primary: { address },
				token: '<the cluster token>'
			},
			null,
			2
		);
	});

	/** Sort keys for the health columns, which render as bars rather than text. */
	function sortValue(row: DaemonRow, col: string): string | number {
		if (col === 'version') {
			return row.version ?? '';
		}

		// sorts by trouble first, which is the reason to sort on this column
		if (col === 'checks') {
			return checksFailed(row) * 100 + (row.checks.length - checksPassed(row));
		}

		if (col === 'state') {
			return String(row.online);
		}

		if (col === 'cpu') {
			return row.health?.cpuPct ?? -1;
		}

		if (col === 'memory') {
			return memPct(row.health) ?? -1;
		}

		if (col === 'disk') {
			return diskPct(row.health) ?? -1;
		}

		if (col === 'latency') {
			return row.latencyMs ?? -1;
		}

		return (row as unknown as Record<string, string>)[col] ?? '';
	}

	let selected: Set<string> = $state(new Set());
	let upgradeOpen = $state(false);
	let upgrading = $state(false);
	let upgradeTargets: DaemonRow[] = $state([]);

	/** The row the header's Actions dropdown acts on — only ever a single row. */
	const one = $derived(
		selected.size === 1 ? daemons.find((row) => selected.has(row.name)) : undefined
	);

	const selRows = $derived(daemons.filter((row) => selected.has(row.name)));

	/**
	 * A daemon can be handed an upgrade when it is a connected follower: the
	 * primary is the source of the binary, and an offline follower has no link to
	 * forward the request down.
	 */
	function upgradable(row: DaemonRow): boolean {
		return row.mode === 'follower' && row.online;
	}

	const selUpgradable = $derived(selRows.filter(upgradable));
	const outdatedRows = $derived(daemons.filter((row) => row.outdated && upgradable(row)));

	/** Open the confirmation for a set of targets, ignoring an empty one. */
	function askUpgrade(targets: DaemonRow[]): void {
		if (targets.length === 0) {
			return;
		}

		upgradeTargets = targets;
		upgradeOpen = true;
	}

	/**
	 * Upgrade each target in turn, reporting per-target outcomes.
	 *
	 * Sequential on purpose: every one of these exits as it answers and comes
	 * back on the new build, and taking the whole fleet down at once would leave
	 * nothing serving while they restart.
	 */
	async function runUpgrade(): Promise<void> {
		const targets = upgradeTargets;

		upgrading = true;
		upgradeOpen = false;

		const note = Notify.loading(`Upgrading ${targets.length} daemon(s)…`, { progress: 0 });
		const done: string[] = [];
		const failed: string[] = [];

		for (const [index, row] of targets.entries()) {
			note.set({
				message: `Upgrading ${row.name}… (${index + 1}/${targets.length})`,
				progress: Math.round((index / targets.length) * 100)
			});

			try {
				const res = await post(`/daemons/${encodeURIComponent(row.name)}`, {
					action: 'upgrade',
					force: !row.outdated
				});

				done.push(`${row.name}: ${res.result.from} → ${res.result.to}`);
			} catch (err) {
				failed.push(`${row.name}: ${(err as Error).message}`);
			}
		}

		note.set({
			level: failed.length ? (done.length ? 'warning' : 'error') : 'success',
			message: failed.length
				? `${done.length} upgraded, ${failed.length} failed`
				: `${done.length} daemon(s) upgraded`,
			detail: [...done, ...failed].join('\n'),
			progress: 100,
			closeable: true
		});

		upgrading = false;
		selected = new Set();

		await refresh();
	}
</script>

<svelte:head><title>Machines | Luna Console</title></svelte:head>

<PageHeader
	title="Machines"
	count="{selected.size ? `${selected.size}/` : ''}{daemons.length}"
	description="Machines running a luna daemon — the primary owns the registry, plugins and schedules; followers manage the instances assigned to them and mirror everything else from the primary. Health streams in on each daemon's heartbeat."
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="daemons" />
		<Dropdown
			label="Upgrade"
			disabled={upgrading || (selUpgradable.length === 0 && outdatedRows.length === 0)}
			items={[
				{
					label: `Upgrade selected (${selUpgradable.length})`,
					icon: 'download',
					disabled: selUpgradable.length === 0,
					hint:
						selected.size === 0
							? 'select one or more machines first'
							: 'the primary is the source of the binary, and an offline follower cannot be reached',
					action: () => askUpgrade(selUpgradable)
				},
				{
					label: `Upgrade all outdated (${outdatedRows.length})`,
					icon: 'circleUp',
					disabled: outdatedRows.length === 0,
					hint: 'every connected follower already runs this primary’s build',
					action: () => askUpgrade(outdatedRows)
				}
			]}
		/>
		<Dropdown label="Actions" disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn variant="primary" icon="plus" onclick={() => (joinOpen = true)}>Add a follower</Btn>
	{/snippet}
</PageHeader>

<Panel flush>
	<ResourceTable
		tableId="daemons"
		{columns}
		rows={daemons}
		getId={(row) => row.name}
		searchValue={(row) =>
			`${row.name} ${row.mode} ${row.host ?? ''} ${row.addresses.join(' ')} ${row.instances.join(' ')}`}
		searchPlaceholder="Find a daemon by name, address or instance"
		{filters}
		selectable="multi"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.name}
		noun="machine"
		{sortValue}
		onRowClick={(row) => goto(`/machines/${row.name}`)}
		emptyTitle="No machines registered"
	>
		{#snippet cell(row, col)}
			{#if col === 'state'}
				{@const failed = checksFailed(row)}
				<StatusBadge
					state={row.online ? (failed ? 'warning' : 'ok') : 'stopped'}
					label={row.online ? (failed ? 'Degraded' : 'Online') : 'Offline'}
				/>
			{:else if col === 'name'}
				<a href="/machines/{row.name}" onclick={(event) => event.stopPropagation()}>
					<b>{row.name}</b>
				</a>
			{:else if col === 'checks'}
				{#if row.checks.length === 0}
					<span class="dim">–</span>
				{:else}
					{@const passed = checksPassed(row)}
					{@const failed = checksFailed(row)}
					<StatusBadge
						state={failed ? 'failed' : 'passed'}
						label="{passed}/{row.checks.length} checks passed"
						detail={row.checks.map((check) => ({
							state: check.ok === undefined ? 'pending' : check.ok ? 'passed' : 'failed',
							label: check.name,
							detail: check.detail
						}))}
					/>
				{/if}
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
						<a href="/instances/{name}" onclick={(event) => event.stopPropagation()}>{name}</a>
					{/each}
				{:else}
					<span class="dim">none</span>
				{/if}
			{:else if col === 'cpu'}
				{#if row.health}
					<ProgressBar
						compact
						transition={false}
						value={row.health.cpuPct}
						color="auto"
						right="{row.health.cpuPct}%"
					/>
				{:else}
					<span class="dim">—</span>
				{/if}
			{:else if col === 'memory'}
				{#if row.health}
					<ProgressBar
						compact
						transition={false}
						value={row.health.memUsedMb}
						max={row.health.memTotalMb}
						color="auto"
						right="{(row.health.memUsedMb / 1024).toFixed(1)} / {(
							row.health.memTotalMb / 1024
						).toFixed(0)} GB"
					/>
				{:else}
					<span class="dim">—</span>
				{/if}
			{:else if col === 'disk'}
				{#if row.health && row.health.diskTotalBytes > 0}
					<ProgressBar
						compact
						transition={false}
						value={row.health.diskUsedBytes}
						max={row.health.diskTotalBytes}
						color="auto"
						right="{fmtGb(row.health.diskUsedBytes)} / {fmtGb(row.health.diskTotalBytes)}"
					/>
				{:else}
					<span class="dim">—</span>
				{/if}
			{:else if col === 'latency'}
				{#if row.latencyMs === null}
					<span class="dim">{row.mode === 'primary' ? 'local' : '—'}</span>
				{:else}
					<span class="mono" data-tone={latencyTone(row.latencyMs)}>{row.latencyMs}ms</span>
				{/if}
			{:else if col === 'version'}
				<span class="mono">{row.version ?? '—'}</span>
				{#if row.outdated}
					<StatusBadge state="warning" label="old" />
				{/if}
			{:else if col === 'seen'}
				{#if row.online}
					<span class="dim">
						{row.lastBeatMs === null
							? 'this daemon'
							: `beat ${Math.round(row.lastBeatMs / 1000)}s ago`}
					</span>
				{:else}
					{seenLabel(row)}
				{/if}
			{/if}
		{/snippet}
	</ResourceTable>

	{#if loaded && daemons.length === 1}
		<div class="hint">
			No followers yet — run <code>luna daemon run</code> on another machine with
			<code>mode: "follower"</code> and this primary's address + token in its daemon config.
		</div>
	{/if}
</Panel>

<Modal title="Add a follower daemon" bind:open={joinOpen} wide>
	<p>
		Install the same <code class="inline">luna</code> binary on the other machine, drop this
		config at <code class="inline">/etc/luna/daemon.json</code> (or
		<code class="inline">~/.config/luna/daemon.json</code>), then run
		<code class="inline">luna daemon service install</code> there.
	</p>
	<pre class="code mono">{joinConfig}</pre>
	<p class="dim">
		The token is the cluster secret this primary already uses — generate one with
		<code class="inline">luna daemon token</code> if you have not yet, and set the same value on
		both machines. The follower registers itself on first connection and appears in this table;
		nothing needs to be created here.
	</p>
	{#snippet footer()}
		<Btn onclick={() => (joinOpen = false)}>Close</Btn>
		<Btn
			variant="primary"
			icon="copy"
			onclick={() => navigator.clipboard?.writeText(joinConfig)}
		>
			Copy config
		</Btn>
	{/snippet}
</Modal>

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

<Modal title="Upgrade {upgradeTargets.length} daemon(s)" bind:open={upgradeOpen}>
	<p>
		Each of these takes the primary's binary when there is one and the GitHub release
		otherwise, then exits so its service restarts it on the new build. They go offline for a
		moment and reconnect on their own.
	</p>
	<ul class="targets">
		{#each upgradeTargets as target (target.name)}
			<li>
				<b>{target.name}</b>
				<span class="dim">{target.version ?? 'unknown build'}</span>
				{#if !target.outdated}
					<span class="dim">— already on this build, it will be reinstalled</span>
				{/if}
			</li>
		{/each}
	</ul>

	{#snippet footer()}
		<Btn onclick={() => (upgradeOpen = false)}>Cancel</Btn>
		<Btn variant="primary" icon="download" loading={upgrading} onclick={runUpgrade}>
			Upgrade
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.targets {
		margin: 0.75rem 0 0;
		padding: 0 0 0 1.25rem;
		font-size: 0.875rem;

		li {
			padding: 0.125rem 0;
		}
	}

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

		&[data-tone='warning'] {
			color: var(--warning);
		}

		&[data-tone='danger'] {
			color: var(--error);
		}
	}

	.dim {
		color: var(--text-secondary);
	}

	.code {
		margin: 0.75rem 0;
		padding: 0.75rem 1rem;
		background: var(--bg-terminal);
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.5rem;
		font-size: 0.75rem;
		line-height: 1.6;
		white-space: pre-wrap;
	}
</style>
