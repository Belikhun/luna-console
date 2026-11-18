<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { copyText } from '$lib/clipboard';
	import { fmtCpuPct, fmtDateTime, fmtDuration } from '$lib/format';
	import { Notify } from '$lib/notifications.svelte';
	import { resourceId } from '$shared/iam/resources';
	import type { ResourceView } from '$core/resources';
	import Btn from '$lib/components/Btn.svelte';
	import CopyValue from '$lib/components/CopyValue.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import DistributionBar from '$lib/components/DistributionBar.svelte';
	import EventsTable from '$lib/components/EventsTable.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import MiniSpark from '$lib/components/MiniSpark.svelte';
	import OwnerCell from '$lib/components/OwnerCell.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ResourceIdValue from '$lib/components/ResourceIdValue.svelte';
	import SoftwareLabel from '$lib/components/SoftwareLabel.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import TagChips from '$lib/components/TagChips.svelte';
	import UptimeTimeline from '$lib/components/UptimeTimeline.svelte';
	import type { Series } from '$lib/components/chart';
	import type { DistributionSegment } from '$lib/components/distribution';
	import type { InfoCell } from '$lib/components/grid';
	import { INSTANCE_TAB_LABELS, instanceTabPath, type InstanceTab } from '$lib/components/instancetabs';
	import { channelOf } from '$lib/components/software';
	import type { Column } from '$lib/components/table';
	import type { UptimeDayPoint } from '$lib/components/uptime';
	import {
		checkSummary,
		historySeries,
		MB,
		msptTone,
		networkTone,
		tpsTone,
		uptimeWindow,
		type InstanceEvent,
		type InstanceHistory
	} from '../details';
	import { cpuTone, extraPorts, newestEvents, stateSince, type InstanceDetail } from './detailstab';
	import { attentionReasons } from './monitoring';

	/**
	 * The instance screen's Details tab: what needs attention first, then how the
	 * server is doing and what it is using, its checks and newest events, where
	 * it answers, what it runs, and who made it. Every panel that has a fuller
	 * tab behind it carries the way there.
	 */
	let {
		inst,
		displayState,
		history,
		events,
		uptimeDays,
		loaded,
		meta,
		hostName,
		usesJava,
		tabs
	}: {
		inst: InstanceDetail;
		/** The state the badge shows; `paused` refines `running` */
		displayState: string;
		/** The sampled hour, oldest first */
		history: InstanceHistory;
		events: InstanceEvent[];
		/** The long uptime record, oldest first; null until the first metrics call lands */
		uptimeDays: UptimeDayPoint[] | null;
		/** The first metrics call has answered */
		loaded: boolean;
		/** Who created the instance and its tags; null until the record loads */
		meta: ResourceView | null;
		/** The primary's name, which an instance without an owner runs on */
		hostName: string;
		/** Whether Java profiles and runtimes mean anything for this software */
		usesJava: boolean;
		/** The tabs this instance has; a panel only links to one that exists */
		tabs: InstanceTab[];
	} = $props();

	/** How many events the summary shows; the full list is one tab away. */
	const EVENT_COUNT = 6;

	const name = $derived(inst.name);
	const live = $derived(inst.state === 'running');
	const isProxy = $derived(name === 'proxy');
	const machine = $derived(inst.daemon ?? hostName);

	const tabHref = (tab: InstanceTab): string => instanceTabPath(name, tab);
	const hasTab = (tab: InstanceTab): boolean => tabs.includes(tab);

	// -- attention -----------------------------------------------------------------------

	const reasons = $derived(attentionReasons(inst, history, events));
	const critical = $derived(reasons.some((reason) => reason.severity === 'critical'));

	// -- status --------------------------------------------------------------------------

	const since = $derived(live ? null : stateSince(events, inst.state));
	const startedAt = $derived(live && inst.uptimeMs ? Date.now() - inst.uptimeMs : null);
	const uptime = $derived(uptimeDays ? uptimeWindow(uptimeDays, 30) : null);
	const telemetryAge = $derived(inst.lastHeartbeatMs ? Date.now() - inst.lastHeartbeatMs : null);

	const statusCells: InfoCell[] = $derived([
		{ id: 'state', label: t('web.instances.colState') },
		{ id: 'started', label: t('web.instanceOverview.started') },
		// the proxy is what judges the others; it has no standing of its own
		...(isProxy ? [] : [{ id: 'network', label: t('web.instances.networkStatus'), help: t('web.instanceOverview.networkHelp') }]),
		{ id: 'players', label: t('web.instances.colPlayers') },
		{ id: 'uptime30', label: t('web.instances.detail.uptime30') },
		{ id: 'telemetry', label: t('web.instances.telemetry'), help: t('web.instanceOverview.telemetryHelp') }
	]);

	// -- resource use --------------------------------------------------------------------

	const spark = $derived({
		cpu: historySeries(history, 'cpu', 'percent'),
		memory: historySeries(history, 'rssMb', 'bytes', MB),
		tps: historySeries(history, 'tps', 'count'),
		mspt: historySeries(history, 'msptMean', 'ms'),
		heap: historySeries(history, 'heapUsedMb', 'bytes', MB),
		players: historySeries(history, 'players', 'count')
	});

	/**
	 * Entities split by whether they are ticked: an entity that is not ticked
	 * costs next to nothing, so a total cannot tell a busy farm from a hall of
	 * item frames.
	 */
	const entitySegments: DistributionSegment[] = $derived.by(() => {
		const segments: DistributionSegment[] = [];

		if (inst.tickingEntities != null) {
			segments.push({
				key: 'ticking',
				label: t('web.instances.tickingEntities'),
				count: inst.tickingEntities,
				color: 'var(--warning)'
			});
		}

		if (inst.nonTickingEntities != null) {
			segments.push({
				key: 'nonticking',
				label: t('web.instances.nonTickingEntities'),
				count: inst.nonTickingEntities,
				color: 'var(--link)'
			});
		}

		return segments;
	});

	const resourceCells: InfoCell[] = $derived([
		{ id: 'cpu', label: t('web.instances.cpuUtilization') },
		{ id: 'memory', label: t('web.instances.residentMemory') },
		...(inst.heapUsedMb != null && inst.heapMaxMb != null ? [{ id: 'heap', label: t('web.instances.jvmHeap') }] : []),
		...(inst.tps != null ? [{ id: 'tps', label: t('web.instances.tickRate') }] : []),
		...(inst.msptMean != null ? [{ id: 'mspt', label: t('web.instances.tickDuration') }] : []),
		...(inst.chunks != null || entitySegments.length > 0
			? [{ id: 'world', label: t('web.instances.worldLoad'), colSpan: 'all' as const }]
			: [])
	]);

	// -- checks and events ---------------------------------------------------------------

	const checks = $derived(checkSummary(inst.checks));

	const checkCols: Column[] = $derived([
		{ id: 'result', label: t('web.instanceOverview.checkResult'), width: 130 },
		{ id: 'name', label: t('web.instanceOverview.check'), width: 200 },
		{ id: 'detail', label: t('web.instanceOverview.checkDetail'), minWidth: 200 }
	]);

	const recent = $derived(newestEvents(events, EVENT_COUNT));

	// -- addresses -----------------------------------------------------------------------

	const ports = $derived(extraPorts(inst));
	const hosts = $derived(inst.proxy?.forcedHosts ?? []);

	const addressCells: InfoCell[] = $derived([
		{ label: t('web.instances.gameAddress'), value: inst.address, copyable: true, style: 'mono' },
		{
			label: t('web.instances.colMachine'),
			value: machine || null,
			href: machine ? `/machines/${encodeURIComponent(machine)}` : undefined,
			leaves: true
		},
		{ id: 'registration', label: t('web.instances.proxyRegistration') },
		...(isProxy ? [] : [{ id: 'hostnames', label: t('web.instanceOverview.hostnames'), help: t('web.instanceOverview.hostnamesHelp') }]),
		...(ports.length > 0 ? [{ id: 'ports', label: t('web.instanceOverview.extraPorts'), colSpan: 'all' as const }] : [])
	]);

	// -- software ------------------------------------------------------------------------

	const softwareCells: InfoCell[] = $derived([
		{ id: 'software', label: t('web.instances.colSoftware') },
		{ label: t('web.instances.protocol'), value: inst.pingVersion },
		{ label: t('web.instances.memoryHeap'), value: inst.memory },
		...(usesJava
			? [
				{
					label: t('web.instances.colProfile'),
					value: inst.profile,
					href: `/runtime/profiles?q=${encodeURIComponent(inst.profile)}`,
					leaves: true
				},
				{
					label: t('web.instanceOverview.javaRuntime'),
					value: inst.java ?? t('web.instanceOverview.machineDefault'),
					href: '/runtime/java',
					leaves: true
				}
			]
			: []),
		{ label: t('web.instances.colPid'), value: inst.javaPid, style: 'mono' as const }
	]);

	// -- about ---------------------------------------------------------------------------

	const aboutCells: InfoCell[] = $derived([
		{ id: 'resourceId', label: t('web.resourceId.label') },
		// chat is permitted on its own, so a policy reading this server's chat names this id
		{ id: 'chatResourceId', label: t('web.resourceId.chatLabel'), help: t('web.resourceId.chatHint') },
		{ id: 'createdBy', label: t('web.resourceMeta.createdBy') },
		{
			label: t('web.resourceMeta.createdAt'),
			value: meta?.createdAt ? fmtDateTime(meta.createdAt) : null,
			time: meta?.createdAt || null
		},
		{
			label: t('web.instances.directory'),
			value: inst.dir,
			copyable: true,
			style: 'mono',
			href: `/instances/${encodeURIComponent(name)}/files`,
			leaves: true,
			colSpan: 2
		},
		{ id: 'tags', label: t('web.resourceMeta.tags'), colSpan: 2 }
	]);

	// -- launch command ------------------------------------------------------------------

	// read on demand: a line of forty flags is reference, not something to scan past
	let commandOpen = $state(false);

	async function copyCommand(): Promise<void> {
		if (await copyText(inst.javaCommand)) {
			Notify.success(t('web.instanceOverview.commandCopied'));
		}
	}
</script>

{#snippet dash()}
	<span class="dim">–</span>
{/snippet}

<!-- a live figure, a dim line of context under it, and the hour beside them -->
{#snippet figure(value: string, sub: string | null, series: Series, label: string, tone?: string, ceiling?: number, format?: (value: number) => string)}
	<span class="figure">
		<span class="stack">
			<span class="mono tone-{tone ?? 'plain'}">{value}</span>
			{#if sub}
				<span class="sub">{sub}</span>
			{/if}
		</span>
		{#if series.points.some(([, point]) => point !== null)}
			<MiniSpark {series} {label} width={5} height={1.75} {ceiling} formatValue={format} />
		{/if}
	</span>
{/snippet}

{#snippet cellBody(cell: InfoCell)}
	{#if cell.id === 'state'}
		<span class="stack">
			<StatusBadge state={displayState} />
			{#if live && inst.uptimeMs}
				<span class="sub">{t('web.instances.detail.upFor', { span: fmtDuration(inst.uptimeMs) })}</span>
			{:else if since !== null}
				<span class="sub">{t('web.instanceOverview.sinceLabel')} <DateTime at={since} /></span>
			{/if}
		</span>
	{:else if cell.id === 'started'}
		{#if startedAt === null}
			{@render dash()}
		{:else}
			<DateTime at={startedAt} text={fmtDateTime(startedAt)} />
		{/if}
	{:else if cell.id === 'network'}
		{#if inst.lunaStatus}
			<StatusBadge state={networkTone(inst.lunaStatus)} label={inst.lunaStatus} />
		{:else}
			<span class="dim">{t('web.instances.notReporting')}</span>
		{/if}
	{:else if cell.id === 'players'}
		{#if !inst.players}
			{@render dash()}
		{:else}
			<span class="figure">
				{#if hasTab('access')}
					<a class="mono" href={tabHref('access')}>{inst.players.online} / {inst.players.max}</a>
				{:else}
					<span class="mono">{inst.players.online} / {inst.players.max}</span>
				{/if}
				{#if spark.players.points.some(([, point]) => point !== null)}
					<MiniSpark
						series={spark.players}
						label={t('web.instances.colPlayers')}
						width={5}
						height={1.75}
						formatValue={(value) => String(Math.round(value))}
					/>
				{/if}
			</span>
		{/if}
	{:else if cell.id === 'uptime30'}
		{#if !uptime || uptime.pct === null}
			{@render dash()}
		{:else}
			<span class="uptime">
				<span class="mono">{`${Number(uptime.pct.toFixed(2))}%`}</span>
				<span class="strip">
					<UptimeTimeline days={uptime.days} count={14} compact height="0.875rem" label={t('web.instances.detail.uptime30')} />
				</span>
			</span>
		{/if}
	{:else if cell.id === 'telemetry'}
		{#if telemetryAge === null || !inst.lastHeartbeatMs}
			<span class="dim">{t('web.instances.notReporting')}</span>
		{:else}
			<DateTime at={inst.lastHeartbeatMs} text={t('web.instances.agoOf', { age: fmtDuration(telemetryAge) })} />
		{/if}
	{:else if cell.id === 'cpu'}
		{#if inst.cpu == null}
			{@render dash()}
		{:else}
			{@render figure(
				fmtCpuPct(inst.cpu),
				inst.cpuCores ? t('web.instances.detail.ofCores', { cores: String(inst.cpuCores) }) : null,
				spark.cpu,
				t('web.instances.cpuUtilization'),
				cpuTone(inst.cpu, inst.cpuCores),
				undefined,
				fmtCpuPct
			)}
		{/if}
	{:else if cell.id === 'memory'}
		{#if inst.rssMb == null}
			{@render dash()}
		{:else}
			{@render figure(
				`${(inst.rssMb / 1024).toFixed(1)} GB`,
				inst.hostMemMb ? t('web.instances.detail.ofMachine', { total: `${(inst.hostMemMb / 1024).toFixed(0)} GB` }) : null,
				spark.memory,
				t('web.instances.residentMemory'),
				undefined,
				inst.hostMemMb ? inst.hostMemMb * MB : undefined
			)}
		{/if}
	{:else if cell.id === 'heap' && inst.heapUsedMb != null && inst.heapMaxMb != null}
		{@render figure(
			`${(inst.heapUsedMb / 1024).toFixed(1)} GB`,
			t('web.instances.detail.ofMax', { max: `${(inst.heapMaxMb / 1024).toFixed(1)} GB` }),
			spark.heap,
			t('web.instances.jvmHeap'),
			inst.heapUsedMb / inst.heapMaxMb >= 0.9 ? 'warning' : undefined,
			inst.heapMaxMb * MB
		)}
	{:else if cell.id === 'tps' && inst.tps != null}
		{@render figure(
			inst.tps.toFixed(2),
			t('web.instances.detail.tpsCeiling'),
			spark.tps,
			t('web.instances.tickRate'),
			tpsTone(inst.tps),
			20,
			(value) => value.toFixed(2)
		)}
	{:else if cell.id === 'mspt' && inst.msptMean != null}
		{@render figure(
			`${inst.msptMean.toFixed(1)} ms`,
			inst.msptMax == null ? null : t('web.instances.detail.worstTick', { max: inst.msptMax.toFixed(1) }),
			spark.mspt,
			t('web.instances.tickDuration'),
			msptTone(inst.msptMean),
			undefined,
			(value) => `${value.toFixed(1)} ms`
		)}
	{:else if cell.id === 'world'}
		<span class="world">
			<span class="sub">
				{#if inst.chunks != null}
					{t('web.instances.chunksLoaded', { count: inst.chunks.toLocaleString() })}
				{/if}
				{#if inst.worlds.length > 0}
					· {t('web.instances.worldCount', { count: String(inst.worlds.length) })}
				{/if}
			</span>
			{#if entitySegments.length > 0}
				<DistributionBar segments={entitySegments} empty={t('web.instances.noEntities')} />
			{/if}
		</span>
	{:else if cell.id === 'registration'}
		{#if isProxy}
			<span class="dim">{t('web.instanceOverview.isTheProxy')}</span>
		{:else if inst.proxy?.register}
			<span class="stack">
				<StatusBadge state="passed" label={t('web.instanceOverview.registered')} />
				{#if inst.proxy.priority !== undefined}
					<span class="sub">{t('web.instanceOverview.tryPriority', { priority: String(inst.proxy.priority) })}</span>
				{/if}
			</span>
		{:else}
			<StatusBadge state="stopped" label={t('web.instanceOverview.notRegistered')} />
		{/if}
	{:else if cell.id === 'hostnames'}
		{#if hosts.length === 0}
			<span class="dim">{t('web.common.none')}</span>
		{:else}
			<span class="list">
				{#each hosts as host (host)}
					<CopyValue value={host} label={cell.label} />
				{/each}
			</span>
		{/if}
	{:else if cell.id === 'ports'}
		<span class="ports">
			{#each ports as port (port.key)}
				<span class="port">
					<span class="sub">{port.key}</span>
					<CopyValue value={port.address} label={port.key} />
				</span>
			{/each}
		</span>
	{:else if cell.id === 'software'}
		<SoftwareLabel software={inst.software} version={inst.mcVersion} channel={channelOf(inst.mcVersion)} />
	{:else if cell.id === 'resourceId'}
		<ResourceIdValue value={resourceId('instance', name)} label={cell.label} />
	{:else if cell.id === 'chatResourceId'}
		<ResourceIdValue value={resourceId('chat', name)} label={cell.label} />
	{:else if cell.id === 'createdBy'}
		<OwnerCell name={meta?.createdBy} />
	{:else if cell.id === 'tags'}
		{#if meta && Object.keys(meta.tags).length > 0}
			<TagChips tags={meta.tags} limit={6} />
		{:else}
			<span class="dim">{t('web.common.none')}</span>
		{/if}
	{/if}
{/snippet}

{#if reasons.length > 0}
	<Flash kind={critical ? 'error' : 'warning'}>
		{#snippet actions()}
			{#if hasTab('monitoring')}
				<Btn icon="chartLine" href={tabHref('monitoring')}>{t(INSTANCE_TAB_LABELS.monitoring)}</Btn>
			{/if}
		{/snippet}

		<div class="attention">
			<b>{t('web.monitor.attention')}</b>
			<ul>
				{#each reasons as reason, index (index)}
					<li>
						<span>{reason.text}</span>
						{#if reason.detail}
							<span class="detail">{reason.detail}</span>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	</Flash>
{/if}

<div class="stack-panels">
	<div class="pair">
		<Panel fill title={t('web.instances.detail.secStatus')}>
			{#snippet actions()}
				{#if hasTab('logs')}
					<Btn icon="fileLines" href={tabHref('logs')}>{t(INSTANCE_TAB_LABELS.logs)}</Btn>
				{/if}
			{/snippet}

			<InfoGrid cells={statusCells} columns={[2, 2, 1]} custom={cellBody} />
		</Panel>

		<Panel fill title={t('web.instanceOverview.resourceUse')} description={live ? t('web.instanceOverview.resourceUseHint') : undefined}>
			{#snippet actions()}
				{#if hasTab('monitoring')}
					<Btn icon="chartLine" href={tabHref('monitoring')}>{t(INSTANCE_TAB_LABELS.monitoring)}</Btn>
				{/if}
			{/snippet}

			{#if live}
				<InfoGrid cells={resourceCells} columns={[3, 2, 1]} custom={cellBody} />
			{:else}
				<p class="quiet">{t('web.instances.detail.liveWhileRunning')}</p>
			{/if}
		</Panel>
	</div>

	<div class="pair">
		<Panel
			fill
			flush
			title={t('web.instanceOverview.healthChecks')}
			count={live ? `${checks.passed}/${checks.total}` : undefined}
		>
			<DataTable
				columns={checkCols}
				rows={inst.checks}
				getId={(check) => check.name}
				emptyTitle={t('web.instanceOverview.noChecks')}
			>
				{#snippet cell(check, col)}
					{#if col === 'result'}
						<StatusBadge state={check.ok === undefined ? 'unknown' : check.ok ? 'passed' : 'failed'} />
					{:else if col === 'name'}
						<b>{check.name}</b>
					{:else if col === 'detail'}
						<span class="dim">{check.detail}</span>
					{/if}
				{/snippet}
			</DataTable>
		</Panel>

		<Panel fill flush title={t('web.instanceOverview.recentEvents')}>
			{#snippet actions()}
				{#if hasTab('checks')}
					<Btn icon="clockRotateLeft" href={tabHref('checks')}>{t('web.instanceOverview.allEvents')}</Btn>
				{/if}
			{/snippet}

			<EventsTable
				tableId="instance-recent-events"
				events={recent}
				loading={!loaded}
				brief
				maxHeight="none"
				emptyTitle={t('web.instanceDetail.noRecordedEventsThisSession')}
				emptyText={t('web.instances.events.noneHint')}
			/>
		</Panel>
	</div>

	<div class="pair">
		<Panel fill title={t('web.instanceOverview.addresses')}>
			{#snippet actions()}
				{#if hasTab('network')}
					<Btn icon="route" href={tabHref('network')}>{t(INSTANCE_TAB_LABELS.network)}</Btn>
				{/if}
			{/snippet}

			<InfoGrid cells={addressCells} columns={[2, 2, 1]} custom={cellBody} />
		</Panel>

		<Panel fill title={t('web.instances.detail.secSoftware')}>
			{#snippet actions()}
				{#if hasTab('config')}
					<Btn icon="sliders" href={tabHref('config')}>{t(INSTANCE_TAB_LABELS.config)}</Btn>
				{/if}
			{/snippet}

			<InfoGrid cells={softwareCells} columns={[3, 2, 1]} custom={cellBody} />
		</Panel>
	</div>

	<Panel title={t('web.instances.detail.secAbout')}>
		{#snippet actions()}
			{#if hasTab('tags')}
				<Btn icon="tags" href={tabHref('tags')}>{t(INSTANCE_TAB_LABELS.tags)}</Btn>
			{/if}
		{/snippet}

		<InfoGrid cells={aboutCells} columns={[4, 2, 1]} custom={cellBody} />
	</Panel>

	<Panel
		collapsible
		bind:open={commandOpen}
		title={t('web.instanceDetail.launchCommand')}
		description={t('web.instanceOverview.launchCommandHint')}
	>
		{#snippet actions()}
			<Btn icon="copy" onclick={copyCommand}>{t('web.common.copy')}</Btn>
		{/snippet}

		<code class="command mono">{inst.javaCommand}</code>
	</Panel>
</div>

<style lang="scss">
	.stack-panels {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	// two across, level with each other; one under the other on a narrow screen
	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 1rem;
		align-items: stretch;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	// what is wrong, a line per reason, and the way to the charts that show it
	.attention {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 1rem;

		ul {
			display: flex;
			flex: 1 1 20rem;
			flex-direction: column;
			gap: 0.125rem;
			margin: 0;
			padding: 0;
			list-style: none;
		}

		li {
			display: flex;
			flex-wrap: wrap;
			gap: 0 0.75rem;
		}

		.detail {
			opacity: 0.75;
		}
	}

	.quiet {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	// a value and one dim line of context under it, as the table's cells stack
	.stack {
		display: inline-flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.125rem;
		min-width: 0;
		max-width: 100%;
	}

	.sub {
		max-width: 100%;
		color: var(--text-secondary);
		font-size: 0.75rem;
		line-height: 1rem;
	}

	// the number, then the hour's small chart beside it
	.figure {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
		max-width: 100%;
	}

	.uptime {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;

		.strip {
			width: 6rem;
		}
	}

	.world {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		width: 100%;
	}

	.list {
		display: inline-flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
	}

	// each extra port under the binding that asked for it
	.ports {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 2rem;
	}

	.port {
		display: inline-flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.command {
		display: block;
		padding: 0.75rem 1rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.5rem;
		background: var(--bg-terminal);
		font-size: 0.75rem;
		line-height: 1.6;
		white-space: pre-wrap;
		word-break: break-all;
	}

	.tone-warning {
		color: var(--warning);
	}

	.tone-critical {
		color: var(--error);
	}

	.tone-good {
		color: var(--success);
	}
</style>
