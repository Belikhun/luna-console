<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';

	import { t } from '$lib/i18n.svelte';
	import { ApiError, api, del, post } from '$lib/api';
	import { fmtBytes, fmtDuration } from '$lib/format';
	import Btn from '$lib/components/Btn.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { jobFlash } from '$lib/jobflash';
	import { checksFailed, checksPassed, diskPct, latencyTone, linkBadge, memPct } from '$lib/daemons';
	import { withCopyResourceId } from '$lib/resourceid';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import type { InstanceEvent } from '$lib/components/events';
	import type { DaemonDetail, DaemonRow, HealthSample, UpgradeCheck, UpgradeResult } from '$client/daemon';
	import { resourceId } from '$shared/iam/resources';
	import {
		MACHINE_TABS,
		MB,
		checkRows,
		instanceSegments,
		machineHref,
		parseMachineTab,
		removeRefusal,
		roleLabel,
		shareColor
	} from '../machines';
	import { machineEnvironment, type MachineVar, type PortsAnswer } from './machine';
	import ChecksTab from './ChecksTab.svelte';
	import DetailsTab from './DetailsTab.svelte';
	import EnvironmentTab from './EnvironmentTab.svelte';
	import EventsTab from './EventsTab.svelte';
	import InstancesTab from './InstancesTab.svelte';
	import MonitoringTab from './MonitoringTab.svelte';
	import PoolsTab from './PoolsTab.svelte';

	/**
	 * One machine of the cluster: a strip of how it stands, then a tab per
	 * question. Details is the summary; Monitoring the hour its daemon keeps;
	 * Instances what runs there; Health checks what the primary verifies; Port
	 * pools and Environment what the machine departs from the cluster with;
	 * Events its history. The tab is the address's (`?tab=`), so a reload and a
	 * shared link land on the same one.
	 */

	const name = $derived(page.params.name ?? '');
	const tab = $derived(parseMachineTab(page.url.searchParams.get('tab')));

	let row = $state.raw<DaemonRow | null>(null);
	let history = $state.raw<HealthSample[]>([]);
	let events = $state.raw<InstanceEvent[]>([]);
	let ports = $state.raw<PortsAnswer | null>(null);
	let vars = $state.raw<MachineVar[]>([]);
	let envLoaded = $state(false);

	let loaded = $state(false);
	let loading = $state(false);
	let missing = $state(false);
	let failure = $state('');
	let lastUpdated: number | null = $state(null);

	let removeOpen = $state(false);
	let upgradeOpen = $state(false);
	let upgrading = $state(false);
	let checking = $state(false);
	let upgradeCheck = $state.raw<UpgradeCheck | null>(null);

	let eventsTab = $state<EventsTab>();

	async function refresh(): Promise<void> {
		const asked = name;

		if (!asked) {
			return;
		}

		loading = true;

		try {
			const detail: DaemonDetail = await api(`/daemons/${encodeURIComponent(asked)}`);

			if (asked !== name) {
				return;
			}

			row = detail.row;
			history = detail.history;
			events = detail.events;
			missing = false;
			failure = '';
			lastUpdated = Date.now();
		} catch (err) {
			if (asked !== name) {
				return;
			}

			// a machine that was never there is said once, in the page's place; a
			// read that fails later keeps the last figures and says why above them
			if (err instanceof ApiError && err.status === 404) {
				missing = true;
				row = null;
			} else {
				failure = (err as Error).message;
			}
		} finally {
			if (asked === name) {
				loading = false;
				loaded = true;
			}
		}

		await Promise.all([loadPorts(), loadEnvironment(), eventsTab?.load()]);
	}

	// the port map and the environment are other screens' data, guarded by their
	// own permissions; an account without them still gets the rest of this one
	async function loadPorts(): Promise<void> {
		try {
			ports = await api('/ports');
		} catch {
			// the tab keeps what it had
		}
	}

	async function loadEnvironment(): Promise<void> {
		const asked = name;

		try {
			const data = await api('/env');

			if (asked === name) {
				vars = machineEnvironment(data, asked);
			}
		} catch {
			// the tab keeps what it had
		} finally {
			envLoaded = true;
		}
	}

	/**
	 * Ask the daemon what it could upgrade to. The primary's binary is preferred
	 * and the GitHub release is the fallback, but both are reported so the panel
	 * can say where an upgrade would come from before anyone commits to it.
	 */
	async function checkUpgrade(fresh: boolean): Promise<void> {
		const asked = name;

		if (!asked) {
			return;
		}

		checking = true;

		try {
			const res = await post(`/daemons/${encodeURIComponent(asked)}`, {
				action: 'check-upgrade',
				refresh: fresh
			});

			if (asked === name) {
				upgradeCheck = res.check;
			}
		} catch (err) {
			// a manual check reports its failure; the one on arrival stays quiet,
			// since the panel already says nothing has been checked yet
			if (fresh) {
				Notify.error(t('web.machineDetail.checkFailed'), { detail: (err as Error).message });
			}
		}

		checking = false;
	}

	// another machine's address is another screen: nothing of the previous one stays
	$effect(() => {
		void name;

		untrack(() => {
			row = null;
			history = [];
			events = [];
			vars = [];
			envLoaded = false;
			loaded = false;
			missing = false;
			failure = '';
			upgradeCheck = null;

			void refresh();

			// the daemon keeps this answer warm in the background, so the first
			// look at the page costs a socket round trip and nothing more
			void checkUpgrade(false);
		});
	});

	async function remove(): Promise<void> {
		if (!row) {
			return;
		}

		try {
			await del(`/daemons/${encodeURIComponent(row.name)}`);

			Notify.success(t('web.machines.removedRegistration', { name: row.name }));

			await goto('/machines');
		} catch (err) {
			Notify.error(t('web.machines.removeFailed'), { detail: (err as Error).message });
		}
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
			failure: () => ({ message: t('web.machines.upgradeFailed', { name: target }) })
		});

		upgrading = false;

		await refresh();
	}

	// -- the strip and the header -------------------------------------------------------

	const health = $derived(row?.health ?? null);
	const failed = $derived(row ? checksFailed(row) : 0);
	const passed = $derived(row ? checksPassed(row) : 0);
	const badge = $derived(row ? linkBadge(row) : { state: 'unknown', label: '' });
	const memoryShare = $derived(memPct(health));
	const diskShare = $derived(diskPct(health));

	/** This machine's key in the port registry ("" is the primary). */
	const machineKey = $derived(row?.mode === 'primary' ? '' : name);

	function headerActions(machine: DaemonRow): ContextMenuItem[] {
		const removal = removeRefusal(machine);

		return withCopyResourceId(
			menuGroups(
				[
					{
						id: 'copy-host',
						label: t('web.machines.copyRoutingHost'),
						icon: 'copy',
						disabled: !machine.host,
						action: () => navigator.clipboard?.writeText(machine.host ?? '')
					},
					{
						id: 'copy-addresses',
						label: t('web.machines.copyIpAddresses'),
						icon: 'copy',
						disabled: machine.addresses.length === 0,
						action: () => navigator.clipboard?.writeText(machine.addresses.join(', '))
					}
				],
				[
					{
						label: t('web.machines.removeRegistration'),
						icon: 'trash',
						color: 'danger',
						disabled: !!removal,
						hint: removal,
						action: () => {
							removeOpen = true;
						}
					}
				]
			),
			[resourceId('machine', machine.name)]
		);
	}

	const tabs = $derived(
		MACHINE_TABS.map((id) => {
			const label = t(`web.machineDetail.tab.${id}`);
			const count = !row
				? null
				: id === 'instances'
					? String(row.instances.length)
					: id === 'checks' && row.checks.length > 0
						? `${passed}/${row.checks.length}`
						: id === 'pools' && ports
							? String(ports.catalog.length)
							: id === 'environment' && envLoaded
								? String(vars.length)
								: null;

			return {
				id,
				label: count === null
					? label
					: `${label} (${count})`,
				href: machineHref(name, id)
			};
		})
	);
</script>

<svelte:head><title>{name} | {t('web.machines.title')} | Luna Console</title></svelte:head>

{#if missing}
	<PageHeader title={name} />
	<Flash kind="error">{t('web.machineDetail.notFound', { name })}</Flash>
{:else if !row}
	<PageHeader title={name} />

	{#if failure}
		<Flash kind="error">{t('web.common.loadFailedNamed', { name })}: {failure}</Flash>
	{/if}
{:else}
	<PageHeader title={row.name}>
		{#snippet extra()}
			<StatusBadge state={badge.state} label={badge.label} detail={row?.quarantine ?? undefined} />
			<span class="role dim">{roleLabel(row!)}</span>
		{/snippet}
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="daemon-detail" />
			<Dropdown label={t('web.common.actions')} header={row!.name} menu={headerActions(row!)} />
			<Btn icon="rotate" loading={checking} onclick={() => checkUpgrade(true)}>
				{t('web.machineDetail.checkForUpdates')}
			</Btn>
			<!-- a quarantined daemon keeps this: the upgrade is the one request its
			     link still accepts, and the only way it rejoins the cluster -->
			<Btn
				variant={upgradeCheck?.offer ? 'primary' : 'normal'}
				icon="download"
				disabled={row!.state === 'offline' || upgrading}
				title={row!.state === 'offline'
					? t('web.machines.refusal.notConnected')
					: (row!.quarantine ?? undefined)}
				onclick={() => (upgradeOpen = true)}
			>
				{upgradeCheck?.offer ? t('web.machines.upgradeDaemon') : t('web.machines.reinstallBuild')}
			</Btn>
		{/snippet}
	</PageHeader>

	{#if failure}
		<Flash kind="error">{t('web.common.loadFailedNamed', { name })}: {failure}</Flash>
	{/if}

	<OverviewBar title={t('web.machineDetail.overview')}>
		<OverviewCell
			label={t('web.machines.colChecks')}
			progress={row.checks.length ? passed / row.checks.length : undefined}
			progressColor={failed ? 'var(--warning)' : 'var(--success)'}
		>
			{#if row.checks.length === 0}
				<span class="dim">–</span>
			{:else}
				<StatusBadge
					state={failed ? 'failed' : 'passed'}
					label={failed
						? t('web.machines.checksFailing', { count: String(failed) })
						: t('web.machines.checksPassed', { passed: String(passed), total: String(row.checks.length) })}
					detail={checkRows(row)}
				/>
			{/if}
		</OverviewCell>
		<OverviewCell
			label={t('web.fleet.instances')}
			segments={instanceSegments([row])}
			segmentsEmpty={t('web.fleet.noInstances')}
		/>
		<OverviewCell
			label={t('web.machines.colCpu')}
			progress={health ? Math.min(1, health.cpuPct / 100) : undefined}
			progressColor={health ? shareColor(health.cpuPct / 100) : undefined}
		>
			{#if health}
				<span class="mono">{t('web.machineDetail.cpuAndLoad', { cpu: health.cpuPct.toFixed(1), load: health.load1.toFixed(2) })}</span>
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell
			label={t('web.fleet.memory')}
			progress={memoryShare === null ? undefined : memoryShare / 100}
			progressColor={memoryShare === null ? undefined : shareColor(memoryShare / 100)}
		>
			{#if health}
				<span class="mono">{t('web.machines.usedOf', {
					used: fmtBytes(health.memUsedMb * MB),
					total: fmtBytes(health.memTotalMb * MB)
				})}</span>
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		<OverviewCell
			label={t('web.fleet.disk')}
			progress={diskShare === null ? undefined : diskShare / 100}
			progressColor={diskShare === null ? undefined : shareColor(diskShare / 100)}
		>
			{#if health && health.diskTotalBytes > 0}
				<span class="mono">{t('web.machines.usedOf', {
					used: fmtBytes(health.diskUsedBytes),
					total: fmtBytes(health.diskTotalBytes)
				})}</span>
			{:else}
				<span class="dim">–</span>
			{/if}
		</OverviewCell>
		{#if row.mode === 'follower'}
			<OverviewCell label={t('web.fleet.latency')}>
				{#if row.latencyMs === null}
					<span class="dim">–</span>
				{:else}
					<span class="mono" data-tone={latencyTone(row.latencyMs)}>{Math.round(row.latencyMs)} ms</span>
				{/if}
			</OverviewCell>
		{/if}
		<OverviewCell label={t('web.machineDetail.daemonUptime')}>
			{#if row.uptimeMs === null}
				<span class="dim">–</span>
			{:else}
				{fmtDuration(row.uptimeMs)}
			{/if}
		</OverviewCell>
	</OverviewBar>

	<Tabs {tabs} active={tab} />

	<div class="tabbody">
		{#if tab === 'details'}
			<DetailsTab {row} {history} {events} check={upgradeCheck} {checking} />
		{:else if tab === 'monitoring'}
			<MonitoringTab {row} {history} {loaded} />
		{:else if tab === 'instances'}
			<InstancesTab {row} {history} />
		{:else if tab === 'checks'}
			<ChecksTab {row} />
		{:else if tab === 'pools'}
			<PoolsTab name={row.name} {machineKey} {ports} onsaved={loadPorts} />
		{:else if tab === 'environment'}
			<EnvironmentTab name={row.name} {vars} loaded={envLoaded} onchanged={loadEnvironment} />
		{:else}
			<EventsTab bind:this={eventsTab} name={row.name} />
		{/if}
	</div>

	<Modal title={t('web.machineDetail.upgradeTitle', { name: row.name })} bind:open={upgradeOpen}>
		<p>
			{#if upgradeCheck?.offer}
				{t('web.machineDetail.upgradeOffer', {
					current: row.version ?? '–',
					origin: upgradeCheck.offer.origin,
					version: upgradeCheck.offer.version
				})}
			{:else if upgradeCheck?.offers.length}
				{t('web.machineDetail.upgradeSame', {
					origin: upgradeCheck.offers[0]!.origin,
					version: row.version ?? '–'
				})}
			{:else}
				{t('web.machineDetail.upgradeUnchecked')}
			{/if}
		</p>
		<p class="dim">{t('web.machineDetail.upgradeNote')}</p>

		{#snippet footer()}
			<Btn onclick={() => (upgradeOpen = false)}>{t('web.common.cancel')}</Btn>
			<Btn variant="primary" icon="download" loading={upgrading} onclick={upgrade}>{t('web.machines.upgrade')}</Btn>
		{/snippet}
	</Modal>

	<ConfirmModal
		bind:open={removeOpen}
		title={t('web.machines.removeTitle', { name: row.name })}
		lead={t('web.machines.removeLead', { name: row.name })}
		notes={[t('web.machines.removeNote')]}
		confirmLabel={t('web.common.remove')}
		onconfirm={() => void remove()}
	/>
{/if}

<style lang="scss">
	.tabbody {
		padding-top: 1rem;
	}

	.role {
		font-size: 0.875rem;
	}

	.mono {
		&[data-tone='warning'] {
			color: var(--warning);
		}

		&[data-tone='danger'] {
			color: var(--error);
		}
	}
</style>
