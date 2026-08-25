<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
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
	import DataTable from '$lib/components/DataTable.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { jobFlash } from '$lib/jobflash';
	import DistributionBar from '$lib/components/DistributionBar.svelte';
	import {
		checksFailed,
		checksPassed,
		diskPct,
		fmtGb,
		latencyTone,
		linkBadge,
		memPct,
		swapPct
	} from '$lib/daemons';
	import { consumersLine, poolsPayload } from '$lib/pools';
	import type { PortPool } from '$core/types';
	import type { InfoCell } from '$lib/components/grid';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import type {
		DaemonDetail,
		DaemonRow,
		HealthSample,
		UpgradeCheck,
		UpgradeResult
	} from '$client/daemon';

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

			await Promise.all([loadPools(), loadEnvironment()]);
		} catch (err) {
			missing = true;
			Notify.error(t('web.machineDetail.loadFailed', { name }), { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	// -- port pools --------------------------------------------------------------
	// The catalog is cluster-wide; what belongs on this screen is the one column of
	// it this machine serves; its ranges, its usage, and the override that makes
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
			{ key: 'used', label: t('web.machineDetail.allocated'), count: view.used.length, color: 'var(--link)' },
			{ key: 'reserved', label: t('web.machineDetail.heldBack'), count: view.reserved.length, color: 'var(--warning)' },
			{ key: 'pending', label: t('web.machineDetail.inFlight'), count: view.pending.length, color: 'var(--primary)' },
			{ key: 'free', label: t('web.machineDetail.free'), count: view.free, color: 'var(--bg-track)' }
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

		const note = Notify.loading(t('web.machineDetail.savingPools'));

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
				message: t('web.machineDetail.poolsSaved', { name: row?.name ?? t('web.machineDetail.thisMachine') }),
				detail: res.warnings?.length ? res.warnings.join(' · ') : '',
				closeable: true
			});

			await loadPools();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.machineDetail.couldNotSaveThePool'),
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

			Notify.success(t('web.machines.removedRegistration', { name: row.name }));

			await goto('/machines');
		} catch (err) {
			Notify.error(t('web.machines.removeFailed'), { detail: (err as Error).message });
		}

		removing = false;
	}

	/**
	 * Ask the daemon what it could upgrade to. The primary's binary is preferred
	 * and the GitHub release is the fallback, but both are reported so the panel
	 * can say where an upgrade would come from before anyone commits to it.
	 */
	async function checkUpgrade(refresh: boolean): Promise<void> {
		// the route parameter, not `row`; this runs on mount, before the first
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
				Notify.error(t('web.machineDetail.checkFailed'), { detail: (err as Error).message });
			}
		}

		checking = false;
	}

	/**
	 * Replace this daemon's binary with the best offer. Fetching it outlasts a
	 * request, so it runs as a job and the card carries its progress tree; the
	 * daemon exits as the job settles, so the row goes offline for a moment and
	 * comes back on the new build.
	 */
	async function upgrade(): Promise<void> {
		if (!row) {
			return;
		}

		const target = row.name;

		upgrading = true;
		upgradeOpen = false;

		await jobFlash({
			title: t('web.machineDetail.upgrading', { name: target }),
			start: () =>
				post(`/daemons/${encodeURIComponent(target)}`, {
					action: 'upgrade',
					force: !upgradeCheck?.offer
				}),
			success: (result) => {
				const outcome = result as UpgradeResult;

				return {
					message: `${target}: ${outcome.from} → ${outcome.to}`,
					detail: t('web.machineDetail.upgradedFrom', { origin: outcome.origin })
				};
			},
			failure: () => ({ message: t('web.machineDetail.upgradeFailed', { name: target }) })
		});

		upgrading = false;

		await refresh();
	}

	const health = $derived(row?.health ?? null);
	const failed = $derived(row ? checksFailed(row) : 0);
	const passed = $derived(row ? checksPassed(row) : 0);
	const badge = $derived(row ? linkBadge(row) : { state: 'unknown', label: 'Unknown' });

	const summaryCells: InfoCell[] = $derived.by(() => {
		if (!row) {
			return [];
		}

		return [
			{ id: 'state', label: t('web.machineDetail.daemonState') },
			{ label: t('web.machineDetail.role'), value: row.mode },
			{ label: t('web.machineDetail.routingHost'), value: row.host, copyable: !!row.host, style: 'mono' },
			{ label: t('web.machineDetail.ipAddresses'), value: row.addresses.join(', ') || null, style: 'mono' },
			{ label: t('web.machineDetail.clusterRoot'), value: row.root, copyable: !!row.root, style: 'mono' },
			{ id: 'version', label: t('web.machineDetail.daemonVersion') },
			{ label: t('web.machineDetail.protocol'), value: row.protocol === null ? null : String(row.protocol) },
			{ label: t('web.machineDetail.daemonUptime'), value: fmtDuration(row.uptimeMs) },
			{ label: t('web.machineDetail.hostUptime'), value: health ? fmtDuration(health.uptimeSec * 1000) : null },
			{
				label: t('web.machineDetail.connectedSince'),
				value: row.connectedAt ? fmtDateTime(row.connectedAt) : null
			},
			{ id: 'beat', label: t('web.machineDetail.lastHeartbeat') },
			{ id: 'latency', label: t('web.machineDetail.linkLatency') },
			{ label: t('web.machineDetail.loadAverage'), value: health ? `${health.load1.toFixed(2)} · ${health.load5.toFixed(2)} · ${health.load15.toFixed(2)}` : null },
			{ label: t('web.machineDetail.instancesOwned'), value: String(row.instances.length) }
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
	// undefined rather than 0 for a sample with no swap to report, so the series
	// breaks where the measurement is missing instead of drawing a floor
	const swapPoints = $derived(
		history.map((sample) => ({
			t: sample.t,
			v: sample.swapTotalMb ? (sample.swapUsedMb ?? 0) : undefined
		}))
	);
	const latencyPoints = $derived(history.map((sample) => ({ t: sample.t, v: sample.latencyMs })));
	const instancePoints = $derived(
		history.map((sample) => ({ t: sample.t, v: sample.instancesRssMb }))
	);

	const hasLatencySeries = $derived(latencyPoints.some((point) => point.v != null));
	const hasSwapSeries = $derived(swapPoints.some((point) => point.v != null));

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

	const instanceCols: Column[] = $derived([
		{ id: 'instance', label: t('web.machineDetail.instance2'), sortable: true },
		{ id: 'state', label: t('web.machineDetail.state'), width: 130, sortable: true },
		{ id: 'rss', label: t('web.machineDetail.residentMemory'), width: 240, sortable: true },
		{ id: 'reach', label: t('web.machineDetail.reachableFromThePrimary') }
	]);

	function instanceActions(entry: { instance: string }): ContextMenuItem[] {
		return [
			{
				label: `Open ${entry.instance}`,
				icon: 'server',
				action: () => goto(`/instances/${entry.instance}`)
			},
			{
				label: t('web.machineDetail.monitoring'),
				icon: 'chartLine',
				action: () => goto(`/instances/${entry.instance}?tab=monitoring`)
			},
			{
				label: t('web.machineDetail.serialConsole'),
				icon: 'code',
				action: () => goto(`/instances/${entry.instance}/console`)
			}
		];
	}

	const eventCols: Column[] = $derived([
		{ id: 'time', label: t('web.machineDetail.time'), width: 190 },
		{ id: 'kind', label: t('web.machineDetail.type'), width: 120 },
		{ id: 'message', label: t('web.machineDetail.event2') }
	]);

	// -- environment ---------------------------------------------------------------
	// Machine-scoped overrides: the values every instance on THIS host resolves in
	// place of the cluster-wide ones. The global values themselves belong to the
	// environment screen, so this tab shows only what departs from them.

	interface MachineVar {
		name: string;
		/** The value instances on this machine resolve */
		value: string;
		secret: boolean;
		/** Where that value comes from: this machine, or inherited from the cluster */
		source: 'global' | 'machine';
		/** The cluster-wide value a machine override shadows, when there is one */
		global: string | null;
		globalSecret: boolean;
	}

	let machineVars: MachineVar[] = $state([]);
	/** Secrets revealed this session, dropped on reload */
	let revealedVars: Record<string, string> = $state({});

	let overrideRemoveOpen = $state(false);
	/** the override the remove dialog is about; set by the remove verb, read on confirm */
	let overrideToRemove = $state<MachineVar | null>(null);

	async function loadEnvironment(): Promise<void> {
		if (!name) {
			return;
		}

		const data = await api('/env');

		const globals = new Map<string, { value: string; secret: boolean }>(
			(data.variables as Array<{ name: string; value: string; secret: boolean }>).map((entry) => [
				entry.name,
				{ value: entry.value, secret: entry.secret }
			])
		);

		// this machine's own overrides, keyed for the merge below
		const own = new Map<string, { value: string; secret: boolean }>(
			(data.overrides as Array<any>)
				.filter((entry) => entry.scope === 'machine' && entry.target === name)
				.map((entry) => [entry.name, { value: entry.value, secret: entry.secret }])
		);

		// every value instances on this host resolve: the cluster-wide set with this
		// machine's overrides applied over it, plus anything defined only here. The
		// source column is what tells the two apart; a table of overrides alone
		// could not answer "what does this machine actually see".
		const names = new Set([...globals.keys(), ...own.keys()]);

		machineVars = [...names]
			.map((varName) => {
				const override = own.get(varName);
				const global = globals.get(varName);

				return {
					name: varName,
					value: override ? override.value : (global?.value ?? ''),
					secret: !!(override?.secret ?? global?.secret),
					source: override ? ('machine' as const) : ('global' as const),
					global: global ? global.value : null,
					globalSecret: !!global?.secret
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** How many of the rows are this machine's own departures from the cluster. */
	const machineOwnCount = $derived(machineVars.filter((entry) => entry.source === 'machine').length);

	async function revealVar(entry: MachineVar): Promise<void> {
		try {
			// an inherited value's secret lives at the global scope, so that is where
			// the reveal has to look; asking this machine for it would 404
			const result = await post(`/env/${encodeURIComponent(entry.name)}/reveal`, {
				machine: entry.source === 'machine' ? name : undefined
			});

			revealedVars = { ...revealedVars, [entry.name]: result.value };
		} catch (err) {
			Notify.error(`Could not reveal ${entry.name}`, { detail: (err as Error).message });
		}
	}

	function hideVar(varName: string): void {
		const next = { ...revealedVars };

		delete next[varName];
		revealedVars = next;
	}

	function removeVar(entry: MachineVar): void {
		overrideToRemove = entry;
		overrideRemoveOpen = true;
	}

	async function removeVarConfirmed(): Promise<void> {
		const entry = overrideToRemove;

		if (!entry) {
			return;
		}

		try {
			await del(`/env?name=${encodeURIComponent(entry.name)}&machine=${encodeURIComponent(name!)}`);
			Notify.success(`${entry.name} override removed`, {
				detail: t('web.machineDetail.instancesOnThisMachineKeep')
			});
			await loadEnvironment();
		} catch (err) {
			Notify.error(`Could not remove ${entry.name}`, { detail: (err as Error).message });
		}
	}

	const envCols: Column[] = $derived([
		{ id: 'name', label: t('web.machineDetail.variable2'), sortable: true, width: 240 },
		{ id: 'value', label: t('web.machineDetail.valueOnThisMachine') },
		{ id: 'source', label: t('web.machineDetail.source'), sortable: true, width: 120 },
		{ id: 'global', label: t('web.machineDetail.clusterWideValue') }
	]);

	const envFilters: TableFilterGroup<MachineVar>[] = $derived([
		{
			id: 'source',
			label: t('web.machineDetail.filterSourceScope'),
			options: [
				{ value: 'any', label: t('web.machineDetail.anySource') },
				{
					value: 'machine',
					label: t('web.machineDetail.thisMachineOnly'),
					match: (entry) => entry.source === 'machine'
				},
				{ value: 'global', label: t('web.machineDetail.inherited'), match: (entry) => entry.source === 'global' }
			]
		}
	]);

	function envActions(entry: MachineVar): ContextMenuItem[] {
		const own = entry.source === 'machine';

		return [
			{
				label: t('web.machineDetail.openVariableDetails'),
				icon: 'circleInfo',
				action: () => goto(`/environment/${encodeURIComponent(entry.name)}`)
			},
			{
				label: own ? 'Edit this override' : 'Override for this machine',
				icon: own ? 'pen' : 'layerGroup',
				action: () =>
					goto(
						`/environment/new?name=${encodeURIComponent(entry.name)}&machine=${encodeURIComponent(name!)}`
					)
			},
			{
				label: revealedVars[entry.name] !== undefined ? 'Hide value' : 'Reveal value',
				icon: revealedVars[entry.name] !== undefined ? 'eyeSlash' : 'eye',
				disabled: !entry.secret,
				action: () =>
					revealedVars[entry.name] !== undefined ? hideVar(entry.name) : revealVar(entry)
			},
			{ separator: true },
			{
				label: t('web.machineDetail.removeOverride'),
				icon: 'trash',
				color: 'danger',
				// an inherited value has nothing to remove here; it lives at the cluster
				// level, and deleting it from this screen would surprise every machine
				disabled: !own,
				action: () => removeVar(entry)
			}
		];
	}
</script>

<svelte:head><title>{name} | Machines | Luna Console</title></svelte:head>

{#if missing && !row}
	<PageHeader title={name ?? ''} />
	<Flash kind="error">{t('web.machineDetail.noDaemonNamed')} <b>{name}</b> {t('web.machineDetail.isRegisteredInThis')}</Flash>
{:else if row}
	<PageHeader title={row.name}>
		{#snippet extra()}
			<StatusBadge state={badge.state} label={badge.label} />
		{/snippet}
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="daemon-detail" />
			<Btn icon="rotate" loading={checking} onclick={() => checkUpgrade(true)}>
				{t('web.machineDetail.checkForUpdates')}
			</Btn>
			<!-- a quarantined daemon keeps this: the upgrade is the one op its link
			     still accepts, and the only way it rejoins the cluster -->
			<Btn
				icon="download"
				disabled={row!.state === 'offline'}
				title={row!.state === 'offline'
					? 'the daemon is not connected'
					: (row!.quarantine ?? undefined)}
				onclick={() => (upgradeOpen = true)}
			>
				{upgradeCheck?.offer ? 'Upgrade daemon' : 'Reinstall binary'}
			</Btn>
			{#if row!.mode === 'follower' && row!.state === 'offline'}
				<Btn variant="danger" icon="trash" onclick={() => (removeOpen = true)}>
					{t('web.machineDetail.removeRegistration')}
				</Btn>
			{/if}
		{/snippet}
	</PageHeader>

	<OverviewBar title={t('web.machineDetail.machineOverview')}>
		<OverviewCell label={t('web.machineDetail.status')}>
			<StatusBadge state={badge.state} label={badge.label} />
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
		<OverviewCell label={t('web.machineDetail.instances')}>
			{row.instances.length}
			<span class="dim">
				({Object.values(health?.states ?? {}).filter((state) => state === 'running').length} running)
			</span>
		</OverviewCell>
		<OverviewCell label={t('web.machineDetail.linkLatency')}>
			{#if row.latencyMs === null}
				<span class="dim">{row.mode === 'primary' ? 'local daemon' : '–'}</span>
			{:else}
				{row.latencyMs} ms
			{/if}
		</OverviewCell>
		<OverviewCell label={t('web.machineDetail.daemonUptime')}>
			{fmtDuration(row.uptimeMs)}
		</OverviewCell>
	</OverviewBar>

	<Tabs
		tabs={[
			{ id: 'details', label: t('web.machineDetail.details') },
			{ id: 'checks', label: `Health checks (${row.checks.length})` },
			{ id: 'monitoring', label: t('web.machineDetail.monitoring') },
			{ id: 'pools', label: `Port pools (${catalog.length})` },
			{ id: 'environment', label: `Environment (${machineVars.length})` },
			{ id: 'instances', label: t('web.machineDetail.instances') },
			{ id: 'events', label: t('web.machineDetail.events') }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'details'}
			{#if row.quarantine}
				<Flash kind="error">
					{row.quarantine}. {t('web.machineDetail.quarantineFix')}
				</Flash>
				<div class="gap"></div>
			{:else if !row.online}
				<Flash kind="warning">
					{t('web.machineDetail.thisDaemonIsNot')}
				</Flash>
				<div class="gap"></div>
			{/if}
			<Panel title={t('web.machineDetail.machineSummary')}>
				<InfoGrid cells={summaryCells}>
					{#snippet custom(cell)}
						{#if cell.id === 'state'}
							<StatusBadge state={badge.state} label={badge.label} />
						{:else if cell.id === 'version'}
							<span class="mono">{row!.version ?? '–'}</span>
							{#if row!.outdated}
								<StatusBadge state="warning" label={t('web.machineDetail.behindThePrimary')} />
							{/if}
						{:else if cell.id === 'beat'}
							{#if row!.mode === 'primary'}
								<span class="dim">{t('web.machineDetail.thisDaemonNothingTo')}</span>
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
				title={t('web.machineDetail.buildAndUpgrades')}
				description={t('web.machineDetail.thePrimarySOwnBinary')}
			>
				<div class="buildrow">
					<span class="blabel">{t('web.machineDetail.running')}</span>
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
								label={offer.newer ? `${offer.version} available` : `${offer.version}; same build`}
							/>
							<span class="dim">
								{offer.origin} · {(offer.size / 1024 / 1024).toFixed(1)} MB
								{#if offer.pageUrl}
									· <a href={offer.pageUrl} target="_blank" rel="noreferrer">{t('web.machineDetail.releaseNotes')}</a>
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
						<p class="dim">{t('web.machineDetail.noUpgradeSourceAnswered')}</p>
					{/if}
				{:else if checking}
					<p class="dim">{t('web.machineDetail.checking')}</p>
				{:else}
					<p class="dim">{t('web.machineDetail.notCheckedYet')}</p>
				{/if}
			</Panel>
		{:else if tab === 'checks'}
			<Panel
				title={t('web.machineDetail.healthChecks')}
				count={row.checks.length}
				description={t('web.machineDetail.runByThePrimaryS')}
			>
				{#each row.checks as check}
					<div class="checkrow">
						<StatusBadge
							state={check.ok === undefined ? 'unknown' : check.ok ? 'passed' : 'failed'}
						/>
						<b>{check.name}</b>
						<span class="dim">{check.detail}</span>
					</div>
				{:else}
					<p class="dim">{t('web.machineDetail.thisDaemonReportsNo')}</p>
				{/each}
			</Panel>

			{#if row.reach?.length}
				<div class="gap"></div>
				<Panel
					title={t('web.machineDetail.reachabilityFromThePrimary')}
					count={row.reach.length}
					description={t('web.machineDetail.eachRunningInstanceSPort')}
				>
					{#each row.reach as probe}
						<div class="checkrow">
							<StatusBadge state={probe.ok ? 'passed' : 'failed'} />
							<b>{probe.instance}</b>
							<span class="mono dim">{probe.address}</span>
						</div>
					{/each}
				</Panel>
			{/if}
		{:else if tab === 'pools'}
			<Panel
				title="Port pools on {row.name}"
				count={poolViews.length}
				description={t('web.machineDetail.poolsAreDefinedOnceFor')}
			>
				{#snippet actions()}
					<Btn icon="sitemap" href="/network/pools">{t('web.machineDetail.editCatalog')}</Btn>
					<Btn
						variant="primary"
						icon="floppyDisk"
						disabled={!overridesDirty}
						loading={savingPools}
						onclick={savePools}
					>
						{t('web.machineDetail.saveRanges')}
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
								<span class="otag" title={t('web.machineDetail.thisMachineDepartsFromThe')}>{t('web.machineDetail.override')}</span>
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
									placeholder={t('web.machineDetail.heldBackNone')}
								/>
							</div>
						{/if}

						{#if view}
							<div class="pusage">
								<DistributionBar segments={poolSegments(view)} legend={false} />
								<span class="dim">
									{view.used.length}/{view.capacity} used ·
									{#if view.next === null}
										<b class="bad">{t('web.machineDetail.exhausted')}</b>
									{:else}
										next <b class="mono">{view.next}</b>
									{/if}
								</span>
							</div>
						{/if}
					</div>
				{/each}

				{#if !catalog.length}
					<p class="dim">{t('web.machineDetail.noPoolsDefined')}</p>
				{/if}
			</Panel>
		{:else if tab === 'environment'}
			<Panel
				title="Environment on {row.name}"
				count={machineVars.length}
				description={t('web.machineDetail.everyValueInstancesOnThis')}
				flush
			>
				{#snippet actions()}
					<span class="dim ownnote">{machineOwnCount} defined on this machine</span>
					<Btn icon="key" href="/environment">{t('web.machineDetail.allVariables')}</Btn>
					<Btn
						variant="primary"
						icon="plus"
						href="/environment/new?machine={encodeURIComponent(row!.name)}"
					>
						{t('web.machineDetail.addAnOverride')}
					</Btn>
				{/snippet}

				{#if machineVars.length}
					<ResourceTable
						tableId="machine-environment"
						columns={envCols}
						filters={envFilters}
						rows={machineVars}
						getId={(entry) => entry.name}
						searchValue={(entry) =>
							`${entry.name} ${entry.secret ? 'secret' : entry.value} ${entry.source}`}
						searchPlaceholder={t('web.machineDetail.findAVariable')}
						rowActions={envActions}
						rowLabel={(entry) => entry.name}
						noun={t('web.machineDetail.variable')}
						onRowClick={(entry) => goto(`/environment/${encodeURIComponent(entry.name)}`)}
						emptyTitle={t('web.machineDetail.noVariablesDefined')}
						emptyText={t('web.machineDetail.nothingIsDefinedClusterWide')}
					>
						{#snippet cell(entry, col)}
							{#if col === 'name'}
								<a class="mono" href="/environment/{encodeURIComponent(entry.name)}">
									<b>{entry.name}</b>
								</a>
							{:else if col === 'value'}
								{#if !entry.secret}
									<span class="mono">{entry.value || '(empty)'}</span>
								{:else if revealedVars[entry.name] !== undefined}
									<span class="mono">{revealedVars[entry.name] || '(empty)'}</span>
									<button class="peek" onclick={() => hideVar(entry.name)}>{t('web.machineDetail.hide')}</button>
								{:else}
									<StatusBadge state="warning" label={t('web.machineDetail.secret')} />
									<span class="dim">••••••••</span>
									<button
										class="peek"
										title={t('web.machineDetail.revealThisValueTheRead')}
										onclick={() => revealVar(entry)}
									>
										reveal
									</button>
								{/if}
							{:else if col === 'source'}
								<span class="scope {entry.source}">{entry.source}</span>
							{:else if col === 'global'}
								{#if entry.source === 'global'}
									<span class="dim">{t('web.machineDetail.inheritedNoOverrideHere')}</span>
								{:else if entry.global === null}
									<span class="dim">{t('web.machineDetail.notDefinedClusterWide')}</span>
								{:else if entry.globalSecret}
									<span class="dim">{t('web.machineDetail.shadows')}</span>
								{:else}
									<span class="dim">{t('web.machineDetail.shadows2')} <span class="mono">{entry.global || '(empty)'}</span></span>
								{/if}
							{/if}
						{/snippet}
					</ResourceTable>
				{:else}
					<p class="none dim">
						{t('web.machineDetail.nothingIsDefinedCluster')}
					</p>
				{/if}
			</Panel>
		{:else if tab === 'monitoring'}
			<Panel title={t('web.machineDetail.hostHealth')} description={t('web.machineDetail.sampledEvery5sOnThe')}>
				<div class="gauges">
					<Gauge label={t('web.machineDetail.cpu')} value={health?.cpuPct ?? null} footnote={health ? `load ${health.load1.toFixed(2)}` : undefined} />
					<Gauge
						label={t('web.machineDetail.memory')}
						value={memPct(health)}
						footnote={health ? `${(health.memUsedMb / 1024).toFixed(1)} / ${(health.memTotalMb / 1024).toFixed(0)} GB` : undefined}
					/>
					<!-- swap sits beside memory rather than replacing part of it: the two
					     answer different questions, and a host that looks comfortable on
					     memory while paging steadily is exactly the case worth seeing -->
					<Gauge
						label={t('web.machineDetail.swap')}
						value={swapPct(health)}
						footnote={health?.swapTotalMb
							? `${((health.swapUsedMb ?? 0) / 1024).toFixed(1)} / ${(health.swapTotalMb / 1024).toFixed(0)} GB`
							: t('web.machineDetail.noSwapConfigured')}
					/>
					<Gauge
						label={t('web.machineDetail.disk')}
						value={diskPct(health)}
						footnote={health && health.diskTotalBytes > 0
							? `${fmtGb(health.diskUsedBytes)} / ${fmtGb(health.diskTotalBytes)}`
							: undefined}
					/>
					{#if row.mode === 'follower'}
						<Gauge
							label={t('web.machineDetail.linkLatency')}
							value={row.latencyMs}
							max={LATENCY_SCALE_MS}
							unit=" ms"
							color={latencyTone(row.latencyMs)}
							footnote="heartbeat round-trip"
						/>
					{/if}
					<Gauge
						label={t('web.machineDetail.instanceMemory')}
						value={health?.instancesRssMb ?? null}
						max={health?.memTotalMb || 1}
						display={health ? `${(health.instancesRssMb / 1024).toFixed(1)} GB` : undefined}
						footnote="resident, all owned instances"
					/>
				</div>
			</Panel>
			<div class="gap"></div>
			<div class="charts">
				<Sparkline points={cpuPoints} label={t('web.machineDetail.cpuUtilization')} unit="%" color="#42b4ff" maxY={100} />
				<Sparkline points={memPoints} label={t('web.machineDetail.memoryUsed')} unit=" MB" color="#bf7edb" />
				{#if hasSwapSeries}
					<Sparkline
						points={swapPoints}
						label={t('web.machineDetail.swapUsed')}
						unit=" MB"
						color="#d98b8b"
					/>
				{/if}
				<Sparkline points={diskPoints} label={t('web.machineDetail.diskUsed')} unit="%" color="#ff9d5c" maxY={100} />
				<Sparkline
					points={instancePoints}
					label={t('web.machineDetail.instanceMemoryResident')}
					unit=" MB"
					color="#2bb534"
				/>
				{#if hasLatencySeries}
					<Sparkline points={latencyPoints} label={t('web.machineDetail.heartbeatLatency')} unit=" ms" color="#e0ca57" />
				{/if}
			</div>
			<p class="dim note">
				{#if row.mode === 'primary'}
					{t('web.machineDetail.sampledLocallyByThis')}
				{:else}
					Sampled on {row.name} and carried to the primary on each heartbeat; latency is measured
					{t('web.machineDetail.byThePrimaryAs')}
				{/if}
			</p>
		{:else if tab === 'instances'}
			<Panel
				title="Instances on {row.name}"
				count={instanceRows.length}
				description={t('web.machineDetail.memoryAsTheDaemonS')}
				flush
			>
				<ResourceTable
					tableId="daemon-instances"
					columns={instanceCols}
					rows={instanceRows}
					getId={(entry) => entry.instance}
					searchValue={(entry) => `${entry.instance} ${entry.state}`}
					searchPlaceholder={t('web.machineDetail.findAnInstance')}
					searchWidth="18rem"
					rowActions={instanceActions}
					rowLabel={(entry) => entry.instance}
					noun={t('web.machineDetail.instance')}
					pageSize={15}
					emptyTitle={t('web.machineDetail.noInstancesAreAssignedTo')}
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
								<span class="dim">{t('web.machineDetail.notProbedOnlyRunning')}</span>
							{/if}
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
		{:else if tab === 'events'}
			<Panel
				title={t('web.machineDetail.daemonEvents')}
				count={events.length}
				description={t('web.machineDetail.linkHeartbeatAndReachabilityEvents')}
				flush
			>
				<ResourceTable
					tableId="daemon-events"
					searchValue={(event) => `${event.kind} ${event.message}`}
					searchPlaceholder={t('web.machineDetail.findAnEvent')}
					searchWidth="20rem"
					noun={t('web.machineDetail.event')}
					pageSize={20}
					columns={eventCols}
					rows={events}
					getId={(event) => String(event.t) + event.message}
					emptyTitle={t('web.machineDetail.noEventsRecordedForThis')}
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
				Replace this daemon's binary; it runs <b>{row.version}</b>, and the
				{upgradeCheck.offer.origin} has <b>{upgradeCheck.offer.version}</b>.
			{:else if upgradeCheck?.offers.length}
				Nothing newer is on offer: this daemon and the {upgradeCheck.offers[0]!.origin} both report
				<b>{row.version}</b>, so this only reinstalls the binary.
			{:else}
				{t('web.machineDetail.noUpgradeSourceHas')}
			{/if}
		</p>
		<p class="dim">
			{t('web.machineDetail.theDaemonVerifiesThe')}
		</p>

		{#snippet footer()}
			<Btn onclick={() => (upgradeOpen = false)}>{t('web.machineDetail.cancel')}</Btn>
			<Btn variant="primary" loading={upgrading} onclick={upgrade}>{t('web.machineDetail.upgrade')}</Btn>
		{/snippet}
	</Modal>

	<Modal title={t('web.machineDetail.removeDaemonRegistration')} bind:open={removeOpen}>
		<p>
			Remove <b>{row.name}</b> from the daemons registry? Its machine can re-register at any time
			{t('web.machineDetail.byConnectingAgain')}
		</p>

		{#snippet footer()}
			<Btn onclick={() => (removeOpen = false)}>{t('web.machineDetail.cancel')}</Btn>
			<Btn variant="danger" loading={removing} onclick={remove}>{t('web.machineDetail.remove')}</Btn>
		{/snippet}
	</Modal>
{/if}

<ConfirmModal
	bind:open={overrideRemoveOpen}
	title={t('web.machineDetail.removeOverrideTitle', { name: overrideToRemove?.name ?? '' })}
	lead={t('web.machineDetail.removeOverrideLead', {
		name: overrideToRemove?.name ?? '',
		machine: name ?? ''
	})}
	notes={[t('web.machineDetail.removeOverrideNote')]}
	confirmLabel={t('web.common.remove')}
	onconfirm={() => void removeVarConfirmed()}
/>

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

	.ownnote {
		font-size: 0.75rem;
	}

	// one colour per layer, matching the environment screens
	.scope {
		font-size: 0.75rem;

		&.global {
			color: var(--link);
		}

		&.machine {
			color: var(--warning);
		}
	}

	.peek {
		@include bare-button;

		margin-left: 0.5rem;
		color: var(--link);
		font-size: 0.75rem;

		&:hover {
			text-decoration: underline;
		}
	}

	.none {
		margin: 0;
		padding: 1rem 1.25rem;
		font-size: 0.8125rem;
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
