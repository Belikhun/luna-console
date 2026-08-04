<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, del, post, put } from '$lib/api';
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
	import DistributionBar from '$lib/components/DistributionBar.svelte';
	import { checksFailed, checksPassed, diskPct, fmtGb, latencyTone, memPct } from '$lib/daemons';
	import { consumersLine, poolsPayload } from '$lib/pools';
	import type { PortPool } from '$core/types';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import type { DaemonDetail, DaemonRow, HealthSample, UpgradeCheck } from '$client/daemon';

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
	let checking = $state(false);
	let upgradeCheck = $state<UpgradeCheck | null>(null);

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

			await loadPools();
		} catch (err) {
			missing = true;
			Notify.error(`Could not load daemon ${name}`, { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	// -- port pools --------------------------------------------------------------
	// The catalog is cluster-wide; what belongs on this screen is the one column of
	// it this machine serves — its ranges, its usage, and the override that makes
	// them differ from everybody else's.

	interface OverrideDraft {
		from: string;
		to: string;
		reserved: string;
	}

	let catalog: PortPool[] = $state([]);
	let poolDefaults: PortPool[] = $state([]);
	let poolViews: any[] = $state([]);
	let poolConsumerMap: Record<string, any[]> = $state({});
	let overrideDrafts: Record<string, OverrideDraft> = $state({});
	let savingPools = $state(false);

	/** This machine's key in the registry's port namespace ("" = the primary). */
	const machineKey = $derived(row ? (row.mode === 'primary' ? '' : row.name) : null);

	async function loadPools(): Promise<void> {
		const data = await api('/ports');

		catalog = data.catalog;
		poolDefaults = data.defaults;
		poolConsumerMap = data.consumers;
		poolViews = (data.pools as any[]).filter((view) => view.machine === machineKey);

		const drafts: Record<string, OverrideDraft> = {};

		for (const pool of catalog) {
			const override = pool.overrides?.[machineKey ?? ''];

			drafts[pool.id] = {
				from: override?.range ? String(override.range[0]) : '',
				to: override?.range ? String(override.range[1]) : '',
				reserved: (override?.reserved ?? []).join(', ')
			};
		}

		overrideDrafts = drafts;
	}

	function parsePorts(text: string): number[] {
		return text
			.split(/[\s,]+/)
			.filter(Boolean)
			.map(Number)
			.filter((port) => Number.isInteger(port));
	}

	/** Usage view for one pool on this machine. */
	function viewOf(poolId: string): any | undefined {
		return poolViews.find((view) => view.pool.id === poolId);
	}

	function poolSegments(view: any): Array<{ key: string; label: string; count: number; color: string }> {
		return [
			{ key: 'used', label: 'allocated', count: view.used.length, color: 'var(--link)' },
			{ key: 'reserved', label: 'held back', count: view.reserved.length, color: 'var(--warning)' },
			{ key: 'pending', label: 'in flight', count: view.pending.length, color: 'var(--primary)' },
			{ key: 'free', label: 'free', count: view.free, color: 'var(--bg-track)' }
		];
	}

	const overridesDirty = $derived(
		catalog.some((pool) => {
			const draft = overrideDrafts[pool.id];
			const existing = pool.overrides?.[machineKey ?? ''];
			const from = existing?.range ? String(existing.range[0]) : '';
			const to = existing?.range ? String(existing.range[1]) : '';
			const held = (existing?.reserved ?? []).join(', ');

			return (
				(draft?.from ?? '') !== from ||
				(draft?.to ?? '') !== to ||
				(draft?.reserved ?? '').replace(/\s/g, '') !== held.replace(/\s/g, '')
			);
		})
	);

	/** Write this machine's overrides back into the cluster catalog. */
	async function savePools(): Promise<void> {
		if (machineKey === null) {
			return;
		}

		savingPools = true;

		const note = Notify.loading('Saving port pool ranges…');

		try {
			const updated: PortPool[] = catalog.map((pool) => {
				const draft = overrideDrafts[pool.id] ?? { from: '', to: '', reserved: '' };
				const overrides = { ...(pool.overrides ?? {}) };
				const hasRange = draft.from.trim() !== '' && draft.to.trim() !== '';
				const held = parsePorts(draft.reserved);

				if (hasRange || held.length) {
					overrides[machineKey] = {
						...(hasRange ? { range: [Number(draft.from), Number(draft.to)] as [number, number] } : {}),
						...(held.length ? { reserved: held } : {})
					};
				} else {
					delete overrides[machineKey];
				}

				return {
					...pool,
					...(Object.keys(overrides).length ? { overrides } : { overrides: undefined })
				};
			});

			const res = await put('/ports', { pools: poolsPayload(updated, poolDefaults) });

			note.set({
				level: 'success',
				message: `Port pool ranges saved for ${row?.name ?? 'this machine'}`,
				detail: res.warnings?.length ? res.warnings.join(' · ') : '',
				closeable: true
			});

			await loadPools();
		} catch (err) {
			note.set({
				level: 'error',
				message: 'Could not save the pool ranges',
				detail: (err as Error).message,
				closeable: true
			});
		}

		savingPools = false;
	}

	onMount(() => {
		// the fleet table deep-links into a tab
		const urlTab = page.url.searchParams.get('tab');

		if (urlTab) {
			tab = urlTab;
		}

		void refresh();

		// the daemon keeps this answer warm in the background, so the first look
		// at the page costs a socket round trip and nothing more
		void checkUpgrade(false);

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

			await goto('/machines');
		} catch (err) {
			Notify.error('Could not remove the daemon', { detail: (err as Error).message });
		}

		removing = false;
	}

	/**
	 * Ask the daemon what it could upgrade to. The primary's binary is preferred
	 * and the GitHub release is the fallback, but both are reported so the panel
	 * can say where an upgrade would come from before anyone commits to it.
	 */
	async function checkUpgrade(refresh: boolean): Promise<void> {
		// the route parameter, not `row` — this runs on mount, before the first
		// detail fetch has resolved
		if (!name) {
			return;
		}

		checking = true;

		try {
			const res = await post(`/daemons/${encodeURIComponent(name)}`, {
				action: 'check-upgrade',
				refresh
			});

			upgradeCheck = res.check;
		} catch (err) {
			// a manual check reports its failure; the one on mount stays quiet,
			// since the panel already says "not checked yet"
			if (refresh) {
				Notify.error('Could not check for updates', { detail: (err as Error).message });
			}
		}

		checking = false;
	}

	/**
	 * Replace this daemon's binary with the best offer. It exits as it answers,
	 * so the row goes offline for a moment and comes back on the new build.
	 */
	async function upgrade(): Promise<void> {
		if (!row) {
			return;
		}

		upgrading = true;

		const note = Notify.loading(`Upgrading ${row.name}…`);

		try {
			const res = await post(`/daemons/${encodeURIComponent(row.name)}`, {
				action: 'upgrade',
				force: !upgradeCheck?.offer
			});

			note.set({
				level: 'success',
				message: `${row.name}: ${res.result.from} → ${res.result.to}`,
				detail: `From the ${res.result.origin}. It is restarting on the new build and will reconnect shortly.`,
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

<svelte:head><title>{name} | Machines | Luna Console</title></svelte:head>

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
			<Btn icon="rotate" loading={checking} onclick={() => checkUpgrade(true)}>
				Check for updates
			</Btn>
			<Btn
				icon="download"
				disabled={!row!.online}
				title={!row!.online ? 'the daemon is not connected' : undefined}
				onclick={() => (upgradeOpen = true)}
			>
				{upgradeCheck?.offer ? 'Upgrade daemon' : 'Reinstall binary'}
			</Btn>
			{#if row!.mode === 'follower' && !row!.online}
				<Btn variant="danger" icon="trash" onclick={() => (removeOpen = true)}>
					Remove registration
				</Btn>
			{/if}
		{/snippet}
	</PageHeader>

	<OverviewBar title="Machine overview">
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
			<Panel title="Machine summary">
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
			<Panel
				title="Port pools on {row.name}"
				count={poolViews.length}
				description="Pools are defined once for the cluster, so a provision can land on any machine; here you set only the numbers this machine hands out. Blank inherits the pool's cluster-wide range."
			>
				{#snippet actions()}
					<Btn icon="sitemap" href="/network/pools">Edit catalog</Btn>
					<Btn
						variant="primary"
						icon="floppyDisk"
						disabled={!overridesDirty}
						loading={savingPools}
						onclick={savePools}
					>
						Save ranges
					</Btn>
				{/snippet}

				{#each catalog as pool (pool.id)}
					{@const view = viewOf(pool.id)}
					{@const draft = overrideDrafts[pool.id]}
					<div class="poolrow">
						<div class="pmeta">
							<b>{pool.id}</b>
							<span class="proto dim">{pool.protocol}</span>
							{#if view?.overridden}
								<span class="otag" title="this machine departs from the cluster range">override</span>
							{/if}
							<span class="pconsumers dim">{consumersLine(poolConsumerMap, pool.id)}</span>
						</div>

						{#if draft}
							<div class="pinputs">
								<input class="input mono" bind:value={draft.from} placeholder={String(pool.range[0])} />
								<span class="dash dim">–</span>
								<input class="input mono" bind:value={draft.to} placeholder={String(pool.range[1])} />
								<input
									class="input mono"
									bind:value={draft.reserved}
									placeholder="held back (none)"
								/>
							</div>
						{/if}

						{#if view}
							<div class="pusage">
								<DistributionBar segments={poolSegments(view)} legend={false} />
								<span class="dim">
									{view.used.length}/{view.capacity} used ·
									{#if view.next === null}
										<b class="bad">exhausted</b>
									{:else}
										next <b class="mono">{view.next}</b>
									{/if}
								</span>
							</div>
						{/if}
					</div>
				{/each}

				{#if !catalog.length}
					<p class="dim">No pools defined.</p>
				{/if}
			</Panel>
			<div class="gap"></div>
			<Panel
				title="Build and upgrades"
				description="The primary's own binary is preferred; the GitHub release is the fallback"
			>
				<div class="buildrow">
					<span class="blabel">Running</span>
					<span class="mono">{row.version ?? '–'}</span>
					{#if upgradeCheck}
						<span class="dim">{upgradeCheck.platform} · checked {fmtDateTime(upgradeCheck.checkedAt)}</span>
					{/if}
				</div>
				{#if upgradeCheck}
					{#each upgradeCheck.offers as offer}
						<div class="buildrow">
							<span class="blabel">{offer.channel === 'primary' ? 'Primary' : 'GitHub'}</span>
							<StatusBadge
								state={offer.newer ? 'warning' : 'passed'}
								label={offer.newer ? `${offer.version} available` : `${offer.version} — same build`}
							/>
							<span class="dim">
								{offer.origin} · {(offer.size / 1024 / 1024).toFixed(1)} MB
								{#if offer.pageUrl}
									· <a href={offer.pageUrl} target="_blank" rel="noreferrer">release notes</a>
								{/if}
							</span>
						</div>
					{/each}
					{#each upgradeCheck.notes as note}
						<div class="buildrow">
							<span class="blabel"></span>
							<span class="dim">{note}</span>
						</div>
					{/each}
					{#if upgradeCheck.offers.length === 0 && upgradeCheck.notes.length === 0}
						<p class="dim">No upgrade source answered.</p>
					{/if}
				{:else if checking}
					<p class="dim">Checking…</p>
				{:else}
					<p class="dim">Not checked yet.</p>
				{/if}
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
			{#if upgradeCheck?.offer}
				Replace this daemon's binary — it runs <b>{row.version}</b>, and the
				{upgradeCheck.offer.origin} has <b>{upgradeCheck.offer.version}</b>.
			{:else if upgradeCheck?.offers.length}
				Nothing newer is on offer: this daemon and the {upgradeCheck.offers[0]!.origin} both report
				<b>{row.version}</b>, so this only reinstalls the binary.
			{:else}
				No upgrade source has answered yet. Check for updates first, or upgrade anyway to make the
				daemon resolve a source itself.
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

	.buildrow {
		display: flex;
		gap: 0.875rem;
		align-items: baseline;
		padding: 0.5rem 0;
		border-bottom: 0.1rem solid var(--border-divider);

		&:last-child {
			border-bottom: none;
		}
	}

	// pool id + consumers | the machine's range fields | its usage
	.poolrow {
		display: grid;
		grid-template-columns: 1fr 20rem 14rem;
		gap: 0.875rem;
		align-items: center;
		padding: 0.5rem 0;
		border-bottom: 0.1rem solid var(--border-divider);

		&:last-child {
			border-bottom: none;
		}

		@include below($bp-medium) {
			grid-template-columns: 1fr;
		}
	}

	.pmeta {
		min-width: 0;

		b {
			color: var(--text-heading);
		}

		.proto {
			margin-left: 0.375rem;
			font-size: 0.75rem;
		}
	}

	.pconsumers {
		display: block;
		font-size: 0.75rem;
		@include ellipsis;
	}

	.otag {
		margin-left: 0.375rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-input);
		padding: 0 0.25rem;
		color: var(--link);
		font-size: 0.625rem;
		text-transform: uppercase;
	}

	.pinputs {
		display: grid;
		grid-template-columns: 5rem auto 5rem 1fr;
		gap: 0.375rem;
		align-items: center;
	}

	.pusage {
		font-size: 0.75rem;
	}

	// wide enough for "Primary"/"GitHub" so the values line up under each other
	.blabel {
		flex: none;
		width: 5rem;
		color: var(--text-secondary);
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
