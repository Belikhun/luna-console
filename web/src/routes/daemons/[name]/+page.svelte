<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, del, post } from '$lib/api';
	import { fmtDateTime, fmtDuration } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Gauge from '$lib/components/Gauge.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { checksFailed, checksPassed, diskPct, fmtGb, latencyTone, memPct } from '$lib/daemons';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import type { DaemonDetail, DaemonRow, HealthSample } from '$client/daemon';

	/** History and events are re-read on this cadence; the row itself streams. */
	const POLL_MS = 15_000;

	/** A LAN heartbeat lives well under this, so it is the dial's full scale. */
	const LATENCY_SCALE_MS = 100;

	const name = $derived(page.params.name);

	let row = $state<DaemonRow | null>(null);
	let history: HealthSample[] = $state([]);
	let events: DaemonDetail['events'] = $state([]);
	let loading = $state(false);
	let lastUpdated: number | null = $state(null);
	let missing = $state(false);
	let tab = $state('details');
	let removeOpen = $state(false);
	let removing = $state(false);
	let upgradeOpen = $state(false);
	let upgrading = $state(false);

	async function refresh(): Promise<void> {
		if (!name) {
			return;
		}

		loading = true;

		try {
			const detail: DaemonDetail = await api(`/daemons/${encodeURIComponent(name)}`);

			row = detail.row;
			history = detail.history;
			events = detail.events;
			lastUpdated = Date.now();
			missing = false;
		} catch (err) {
			missing = true;
			Notify.error(`Could not load daemon ${name}`, { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		// the fleet table deep-links into a tab
		const urlTab = page.url.searchParams.get('tab');

		if (urlTab) {
			tab = urlTab;
		}

		void refresh();

		const poll = setInterval(refresh, POLL_MS);

		// the fleet stream carries this daemon's row on every heartbeat, so the
		// gauges stay live between the slower history polls
		const stream = new EventSource('/api/daemons/stream');

		stream.onmessage = (event) => {
			const frame = JSON.parse(event.data);
			const found = (frame.daemons as DaemonRow[] | undefined)?.find(
				(entry) => entry.name === name
			);

			if (found) {
				row = found;
				lastUpdated = Date.now();
			}
		};

		return () => {
			clearInterval(poll);
			stream.close();
		};
	});

	async function remove(): Promise<void> {
		if (!row) {
			return;
		}

		removing = true;

		try {
			await del(`/daemons/${encodeURIComponent(row.name)}`);

			Notify.success(`Removed daemon registration "${row.name}"`);

			await goto('/daemons');
		} catch (err) {
			Notify.error('Could not remove the daemon', { detail: (err as Error).message });
		}

		removing = false;
	}

	/**
	 * Replace this follower's binary with the primary's. It exits as it answers,
	 * so the row goes offline for a moment and comes back on the new build.
	 */
	async function upgrade(): Promise<void> {
		if (!row) {
			return;
		}

		upgrading = true;

		const note = Notify.loading(`Upgrading ${row.name}…`);

		try {
			const res = await post(`/daemons/${encodeURIComponent(row.name)}`, { action: 'upgrade' });

			note.set({
				level: 'success',
				message: `${row.name}: ${res.result.from} → ${res.result.to}`,
				detail: 'It is restarting on the new build and will reconnect shortly.',
				closeable: true
			});

			upgradeOpen = false;
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not upgrade ${row.name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}

		upgrading = false;
	}

	const health = $derived(row?.health ?? null);
	const failed = $derived(row ? checksFailed(row) : 0);
	const passed = $derived(row ? checksPassed(row) : 0);

	const summaryCells: InfoCell[] = $derived.by(() => {
		if (!row) {
			return [];
		}

		return [
			{ id: 'state', label: 'Daemon state' },
			{ label: 'Role', value: row.mode },
			{ label: 'Routing host', value: row.host, copyable: !!row.host, style: 'mono' },
			{ label: 'IP addresses', value: row.addresses.join(', ') || null, style: 'mono' },
			{ label: 'Cluster root', value: row.root, copyable: !!row.root, style: 'mono' },
			{ id: 'version', label: 'Daemon version' },
			{ label: 'Protocol', value: row.protocol === null ? null : String(row.protocol) },
			{ label: 'Daemon uptime', value: fmtDuration(row.uptimeMs) },
			{ label: 'Host uptime', value: health ? fmtDuration(health.uptimeSec * 1000) : null },
			{
				label: 'Connected since',
				value: row.connectedAt ? fmtDateTime(row.connectedAt) : null
			},
			{ id: 'beat', label: 'Last heartbeat' },
			{ id: 'latency', label: 'Link latency' },
			{ label: 'Load average', value: health ? `${health.load1.toFixed(2)} · ${health.load5.toFixed(2)} · ${health.load15.toFixed(2)}` : null },
			{ label: 'Instances owned', value: String(row.instances.length) }
		];
	});

	const cpuPoints = $derived(history.map((sample) => ({ t: sample.t, v: sample.cpuPct })));
	const memPoints = $derived(history.map((sample) => ({ t: sample.t, v: sample.memUsedMb })));
	const diskPoints = $derived(
		history.map((sample) => ({
			t: sample.t,
			v:
				sample.diskTotalBytes > 0
					? Math.round((sample.diskUsedBytes / sample.diskTotalBytes) * 1000) / 10
					: undefined
		}))
	);
	const latencyPoints = $derived(history.map((sample) => ({ t: sample.t, v: sample.latencyMs })));
	const instancePoints = $derived(
		history.map((sample) => ({ t: sample.t, v: sample.instancesRssMb }))
	);

	const hasLatencySeries = $derived(latencyPoints.some((point) => point.v != null));

	/** Owned instances joined with the memory and state the daemon reported. */
	const instanceRows = $derived.by(() => {
		if (!row) {
			return [];
		}

		return row.instances.map((instance) => ({
			instance,
			state: health?.states[instance] ?? 'unknown',
			rssMb: health?.instanceRssMb[instance] ?? null,
			reach: row!.reach?.find((result) => result.instance === instance) ?? null
		}));
	});

	const instanceCols: Column[] = [
		{ id: 'instance', label: 'Instance', sortable: true },
		{ id: 'state', label: 'State', width: 130, sortable: true },
		{ id: 'rss', label: 'Resident memory', width: 240, sortable: true },
		{ id: 'reach', label: 'Reachable from the primary' }
	];

	function instanceActions(entry: { instance: string }): ContextMenuItem[] {
		return [
			{
				label: `Open ${entry.instance}`,
				icon: 'server',
				action: () => goto(`/instances/${entry.instance}`)
			},
			{
				label: 'Monitoring',
				icon: 'chartLine',
				action: () => goto(`/instances/${entry.instance}?tab=monitoring`)
			},
			{
				label: 'Serial console',
				icon: 'code',
				action: () => goto(`/instances/${entry.instance}/console`)
			}
		];
	}

	const eventCols: Column[] = [
		{ id: 'time', label: 'Time', width: 190 },
		{ id: 'kind', label: 'Type', width: 120 },
		{ id: 'message', label: 'Event' }
	];
</script>

<svelte:head><title>{name} | Daemons | MRDS Console</title></svelte:head>

{#if missing && !row}
	<PageHeader title={name ?? ''} />
	<Flash kind="error">No daemon named <b>{name}</b> is registered in this cluster.</Flash>
{:else if row}
	<PageHeader title={row.name}>
		{#snippet extra()}
			<StatusBadge
				state={row!.online ? (failed ? 'warning' : 'ok') : 'stopped'}
				label={row!.online ? (failed ? 'Degraded' : 'Online') : 'Offline'}
			/>
		{/snippet}
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="daemon-detail" />
			{#if row!.mode === 'follower'}
				<Btn
					icon="download"
					disabled={!row!.online}
					title={!row!.online ? 'the daemon is not connected' : undefined}
					onclick={() => (upgradeOpen = true)}
				>
					{row!.outdated ? 'Upgrade daemon' : 'Reinstall binary'}
				</Btn>
			{/if}
			{#if row!.mode === 'follower' && !row!.online}
				<Btn variant="danger" icon="trash" onclick={() => (removeOpen = true)}>
					Remove registration
				</Btn>
			{/if}
		{/snippet}
	</PageHeader>

	<OverviewBar title="Daemon overview">
		<OverviewCell label="Status">
			<StatusBadge
				state={row.online ? (failed ? 'warning' : 'ok') : 'stopped'}
				label={row.online ? (failed ? 'Degraded' : 'Online') : 'Offline'}
			/>
		</OverviewCell>
		<OverviewCell
			label="Health checks ({row.checks.length})"
			progress={row.checks.length ? passed / row.checks.length : 0}
			progressColor={failed ? 'var(--warning)' : 'var(--success)'}
		>
			<span style="color:var(--success)">{passed} passed</span>
			<span class="dim">|</span>
			<span class:bad={failed > 0}>{failed} failing</span>
		</OverviewCell>
		<OverviewCell label="Instances">
			{row.instances.length}
			<span class="dim">
				({Object.values(health?.states ?? {}).filter((state) => state === 'running').length} running)
			</span>
		</OverviewCell>
		<OverviewCell label="Link latency">
			{#if row.latencyMs === null}
				<span class="dim">{row.mode === 'primary' ? 'local daemon' : '–'}</span>
			{:else}
				{row.latencyMs} ms
			{/if}
		</OverviewCell>
		<OverviewCell label="Daemon uptime">
			{fmtDuration(row.uptimeMs)}
		</OverviewCell>
	</OverviewBar>

	<Tabs
		tabs={[
			{ id: 'details', label: 'Details' },
			{ id: 'monitoring', label: 'Monitoring' },
			{ id: 'instances', label: 'Instances' },
			{ id: 'events', label: 'Events' }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'details'}
			{#if !row.online}
				<Flash kind="warning">
					This daemon is not connected. Everything below is the last state the primary recorded
					for it.
				</Flash>
				<div class="gap"></div>
			{/if}
			<Panel title="Daemon summary">
				<InfoGrid cells={summaryCells}>
					{#snippet custom(cell)}
						{#if cell.id === 'state'}
							<StatusBadge
								state={row!.online ? 'ok' : 'stopped'}
								label={row!.online ? 'Connected' : 'Disconnected'}
							/>
						{:else if cell.id === 'version'}
							<span class="mono">{row!.version ?? '–'}</span>
							{#if row!.outdated}
								<StatusBadge state="warning" label="behind the primary" />
							{/if}
						{:else if cell.id === 'beat'}
							{#if row!.mode === 'primary'}
								<span class="dim">this daemon — nothing to heartbeat</span>
							{:else if row!.lastBeatMs === null}
								<span class="dim">{row!.lastSeen ? fmtDateTime(Date.parse(row!.lastSeen)) : '–'}</span>
							{:else}
								{Math.round(row!.lastBeatMs / 1000)}s ago
							{/if}
						{:else if cell.id === 'latency'}
							{#if row!.latencyMs === null}
								<span class="dim">{row!.mode === 'primary' ? 'local daemon' : '–'}</span>
							{:else}
								<ProgressBar
									compact
									value={row!.latencyMs}
									max={LATENCY_SCALE_MS}
									color={latencyTone(row!.latencyMs)}
									right="{row!.latencyMs} ms"
									width="10rem"
								/>
							{/if}
						{/if}
					{/snippet}
				</InfoGrid>
			</Panel>
			<div class="gap"></div>
			<Panel title="Health checks" count={row.checks.length}>
				{#each row.checks as check}
					<div class="checkrow">
						<StatusBadge
							state={check.ok === undefined ? 'unknown' : check.ok ? 'passed' : 'failed'}
						/>
						<b>{check.name}</b>
						<span class="dim">{check.detail}</span>
					</div>
				{:else}
					<p class="dim">This daemon reports no checks — the primary's hub is what runs them.</p>
				{/each}
			</Panel>
		{:else if tab === 'monitoring'}
			<Panel title="Host health" description="Sampled every 5s on the daemon's own machine">
				<div class="gauges">
					<Gauge label="CPU" value={health?.cpuPct ?? null} footnote={health ? `load ${health.load1.toFixed(2)}` : undefined} />
					<Gauge
						label="Memory"
						value={memPct(health)}
						footnote={health ? `${(health.memUsedMb / 1024).toFixed(1)} / ${(health.memTotalMb / 1024).toFixed(0)} GB` : undefined}
					/>
					<Gauge
						label="Disk"
						value={diskPct(health)}
						footnote={health && health.diskTotalBytes > 0
							? `${fmtGb(health.diskUsedBytes)} / ${fmtGb(health.diskTotalBytes)}`
							: undefined}
					/>
					{#if row.mode === 'follower'}
						<Gauge
							label="Link latency"
							value={row.latencyMs}
							max={LATENCY_SCALE_MS}
							unit=" ms"
							color={latencyTone(row.latencyMs)}
							footnote="heartbeat round-trip"
						/>
					{/if}
					<Gauge
						label="Instance memory"
						value={health?.instancesRssMb ?? null}
						max={health?.memTotalMb || 1}
						display={health ? `${(health.instancesRssMb / 1024).toFixed(1)} GB` : undefined}
						footnote="resident, all owned instances"
					/>
				</div>
			</Panel>
			<div class="gap"></div>
			<div class="charts">
				<Sparkline points={cpuPoints} label="CPU utilization" unit="%" color="#42b4ff" maxY={100} />
				<Sparkline points={memPoints} label="Memory used" unit=" MB" color="#bf7edb" />
				<Sparkline points={diskPoints} label="Disk used" unit="%" color="#ff9d5c" maxY={100} />
				<Sparkline
					points={instancePoints}
					label="Instance memory (resident)"
					unit=" MB"
					color="#2bb534"
				/>
				{#if hasLatencySeries}
					<Sparkline points={latencyPoints} label="Heartbeat latency" unit=" ms" color="#e0ca57" />
				{/if}
			</div>
			<p class="dim note">
				{#if row.mode === 'primary'}
					Sampled locally by this daemon (last hour kept in memory).
				{:else}
					Sampled on {row.name} and carried to the primary on each heartbeat — latency is measured
					by the primary as the round-trip of that same packet.
				{/if}
			</p>
		{:else if tab === 'instances'}
			<Panel
				title="Instances on {row.name}"
				count={instanceRows.length}
				description="Memory as the daemon's own sampler measured it; reachability is a TCP probe from the primary"
				flush
			>
				<ResourceTable
					tableId="daemon-instances"
					columns={instanceCols}
					rows={instanceRows}
					getId={(entry) => entry.instance}
					searchValue={(entry) => `${entry.instance} ${entry.state}`}
					searchPlaceholder="Find an instance"
					searchWidth="18rem"
					rowActions={instanceActions}
					rowLabel={(entry) => entry.instance}
					noun="instance"
					pageSize={15}
					emptyTitle="No instances are assigned to this daemon"
					sortValue={(entry, col) =>
						col === 'rss' ? (entry.rssMb ?? -1) : ((entry as any)[col] ?? '')}
				>
					{#snippet cell(entry, col)}
						{#if col === 'instance'}
							<a href="/instances/{entry.instance}">{entry.instance}</a>
						{:else if col === 'state'}
							<StatusBadge state={entry.state} />
						{:else if col === 'rss'}
							{#if entry.rssMb === null}
								<span class="dim">—</span>
							{:else}
								<ProgressBar
									compact
									transition={false}
									value={entry.rssMb}
									max={health?.memTotalMb || entry.rssMb}
									color="auto"
									right="{(entry.rssMb / 1024).toFixed(1)} GB"
								/>
							{/if}
						{:else if col === 'reach'}
							{#if entry.reach}
								<StatusBadge
									state={entry.reach.ok ? 'passed' : 'failed'}
									label={entry.reach.ok ? 'Answering' : 'No answer'}
								/>
								<span class="dim mono">{entry.reach.address}</span>
							{:else}
								<span class="dim">not probed (only running instances are)</span>
							{/if}
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
		{:else if tab === 'events'}
			<Panel
				title="Daemon events"
				count={events.length}
				description="Link, heartbeat and reachability events recorded for this daemon"
				flush
			>
				<ResourceTable
					tableId="daemon-events"
					searchValue={(event) => `${event.kind} ${event.message}`}
					searchPlaceholder="Find an event"
					searchWidth="20rem"
					noun="event"
					pageSize={20}
					columns={eventCols}
					rows={events}
					getId={(event) => String(event.t) + event.message}
					emptyTitle="No events recorded for this daemon"
					maxHeight="60vh"
				>
					{#snippet cell(event, col)}
						{#if col === 'time'}
							<span class="mono dim">{fmtDateTime(event.t)}</span>
						{:else if col === 'kind'}
							<StatusBadge
								state={event.kind === 'error'
									? 'failed'
									: event.kind === 'state'
										? 'warning'
										: 'ok'}
								label={event.kind}
							/>
						{:else}
							{event.message}
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
		{/if}
	</div>

	<Modal title="Upgrade {row.name}" bind:open={upgradeOpen}>
		<p>
			Replace this daemon's binary with the one the primary is running
			{#if row.outdated}
				— it is on <b>{row.version}</b>, the primary is not.
			{:else}
				. Both report <b>{row.version}</b>, so this only reinstalls it.
			{/if}
		</p>
		<p class="dim">
			The daemon verifies the download, swaps it over its own path and exits, so its service
			manager starts the new build. Instances it owns keep running — they live in their own
			screen sessions, not inside the daemon.
		</p>

		{#snippet footer()}
			<Btn onclick={() => (upgradeOpen = false)}>Cancel</Btn>
			<Btn variant="primary" loading={upgrading} onclick={upgrade}>Upgrade</Btn>
		{/snippet}
	</Modal>

	<Modal title="Remove daemon registration" bind:open={removeOpen}>
		<p>
			Remove <b>{row.name}</b> from the daemons registry? Its machine can re-register at any time
			by connecting again.
		</p>

		{#snippet footer()}
			<Btn onclick={() => (removeOpen = false)}>Cancel</Btn>
			<Btn variant="danger" loading={removing} onclick={remove}>Remove</Btn>
		{/snippet}
	</Modal>
{/if}

<style lang="scss">
	.tabbody {
		margin-top: 1rem;
	}

	.gap {
		height: 1rem;
	}

	.gauges {
		display: flex;
		flex-wrap: wrap;
		gap: 1.5rem;
		justify-content: flex-start;
	}

	.charts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: 1rem;
	}

	.checkrow {
		display: flex;
		gap: 0.875rem;
		align-items: baseline;
		padding: 0.5rem 0;
		border-bottom: 0.1rem solid var(--border-divider);

		&:last-child {
			border-bottom: none;
		}
	}

	.note {
		margin-top: 0.625rem;
	}

	.mono {
		font-variant-numeric: tabular-nums;
	}

	.dim {
		color: var(--text-secondary);
	}

	.bad {
		color: var(--error);
	}
</style>
