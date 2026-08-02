<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post, patch, del } from '$lib/api';
	import { fmtDuration, fmtBytes, fmtDateTime } from '$lib/format';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Select from '$lib/components/Select.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import SettingsForm from '$lib/components/SettingsForm.svelte';
	import ProgressTree from '$lib/components/ProgressTree.svelte';
	import GroupsField from '$lib/components/GroupsField.svelte';
	import Alerts from '$lib/components/Alerts.svelte';
	import ScheduleQuickModal from '$lib/components/ScheduleQuickModal.svelte';
	import { followJob, type JobView } from '$lib/jobs';

	/** how often the header's status and metrics are re-read */
	const POLL_MS = 4000;

	const LOG_LINE_CHOICES = [100, 200, 500, 1000];

	/** headroom over the busiest sample, so the player chart never clips */
	const PLAYER_HEADROOM = 1.2;

	const name = $derived(page.params.name);

	let inst: any = $state(null);
	let tab = $state('details');

	let cfgData: any = $state(null);
	let cfgMemory = $state('');
	let cfgProfile = $state('');
	let cfgVersion = $state('');
	let cfgJavaArgs = $state('');
	let cfgSettings: Record<string, string> = $state({});
	let cfgPluginGroups: string[] = $state([]);
	let paperVersions: string[] = $state([]);
	let saving = $state(false);
	let versionJob: JobView | null = $state(null);
	let deleteOpen = $state(false);
	let scheduleOpen = $state(false);
	let deleteText = $state('');
	let purge = $state(false);
	let versionConflict: any[] = $state([]);

	let instPlugins: any[] = $state([]);
	let pluginTotals = $state({ warnings: 0, errors: 0, sessionComplete: true });
	let metrics: { history: any[]; events: any[] } = $state({ history: [], events: [] });
	let logData: { content: string; archives: any[] } = $state({ content: '', archives: [] });
	let logLines = $state(200);

	let loading = $state(true);
	let lastUpdated: number | null = $state(null);

	async function refresh(): Promise<void> {
		// the poll can outlive the route by a tick during a client-side navigation,
		// at which point page.params.name is already gone
		if (!name) {
			return;
		}

		loading = true;

		try {
			inst = await api(`/instances/${name}`);
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(`Could not load ${name}`, { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	/** Each tab loads its own data the first time it is shown, and on refresh. */
	async function loadTab(which: string): Promise<void> {
		if (which === 'plugins') {
			const data = await api(`/instances/${name}/plugins`);

			instPlugins = data.plugins;
			pluginTotals = {
				warnings: data.warnings,
				errors: data.errors,
				sessionComplete: data.sessionComplete
			};
		}

		if (which === 'monitoring' || which === 'checks') {
			metrics = await api(`/instances/${name}/metrics`);
		}

		if (which === 'logs') {
			logData = await api(`/instances/${name}/logs?lines=${logLines}`);
		}

		if (which === 'config') {
			cfgData = await api(`/instances/${name}/config`);
			cfgMemory = cfgData.memory;
			cfgProfile = cfgData.profile;
			cfgVersion = cfgData.mcVersion ?? '';
			cfgJavaArgs = (cfgData.javaArgs ?? []).join(' ');
			cfgSettings = { ...cfgData.settings };
			cfgPluginGroups = [...(cfgData.pluginGroups ?? [])];

			if (!paperVersions.length) {
				paperVersions = (await api('/paper')).versions;
			}
		}
	}

	onMount(() => {
		// the instances table deep-links into a tab, and into the delete dialog
		const urlTab = page.url.searchParams.get('tab');

		if (urlTab) {
			tab = urlTab;
		}

		if (page.url.searchParams.get('delete')) {
			deleteOpen = true;
		}

		void refresh();

		const poll = setInterval(refresh, POLL_MS);

		return () => clearInterval(poll);
	});

	$effect(() => {
		void tab;
		void loadTab(tab);
	});

	async function stateAction(action: string): Promise<void> {
		const note = Notify.loading(`Sending ${action} to ${name}…`);

		try {
			await post(`/instances/${name}/state`, { action });
			note.set({ level: 'success', message: `${name}: ${action} accepted`, closeable: true });
			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not ${action} ${name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	/** Only settings the user actually moved are sent, so a save says what it changed. */
	const settingEdits = $derived.by(() => {
		const out: Record<string, string> = {};

		for (const spec of (cfgData?.schema ?? []) as any[]) {
			const value = cfgSettings[spec.key];

			if (!spec.managed && value !== undefined && value !== cfgData.settings[spec.key]) {
				out[spec.key] = value;
			}
		}

		return out;
	});

	const settingEditCount = $derived(Object.keys(settingEdits).length);

	const javaArgsDirty = $derived(cfgData !== null && cfgJavaArgs.trim() !== (cfgData.javaArgs ?? []).join(' '));

	const groupsDirty = $derived.by(() => {
		if (!cfgData) {
			return false;
		}

		const before: string[] = cfgData.pluginGroups ?? [];

		return (
			before.length !== cfgPluginGroups.length ||
			cfgPluginGroups.some((group) => !before.includes(group))
		);
	});

	/** Follow a version-change job to its end, keeping its tree on screen. */
	async function trackVersionJob(job: JobView, note: ReturnType<typeof Notify.loading>): Promise<void> {
		versionJob = job;

		const done = await followJob(job.id, (view) => {
			versionJob = view;
			note.set({ progress: Math.round(view.progress.progress * 100) });
		});

		const result = done.result as { from: string | null; to: string; build: number };

		note.set({
			level: 'success',
			message: `${name}: ${result.from ?? '?'} → ${result.to}`,
			detail: `Paper build ${result.build}. Restart the instance to run it.`,
			progress: null,
			closeable: true
		});

		await refresh();
		await loadTab('config');
	}

	async function saveConfig(): Promise<void> {
		saving = true;
		versionConflict = [];
		versionJob = null;

		const note = Notify.loading(`Saving configuration for ${name}…`);

		try {
			const body: any = {
				memory: cfgMemory,
				profile: cfgProfile,
				settings: settingEdits
			};

			if (javaArgsDirty) {
				body.javaArgs = cfgJavaArgs;
			}

			if (groupsDirty) {
				body.pluginGroups = cfgPluginGroups;
			}

			if (cfgVersion && cfgVersion !== cfgData.mcVersion) {
				body.mcVersion = cfgVersion;
			}

			const res = await patch(`/instances/${name}/config`, body);

			// a 409 with `incompatible` is the server-version gate, not a failure
			if (res.ok === false && res.incompatible) {
				versionConflict = res.incompatible;

				note.set({
					level: 'warning',
					message: `${res.incompatible.length} plugin(s) are incompatible with ${cfgVersion}`,
					detail: 'Review the conflict below before forcing the version change.',
					closeable: true
				});

				saving = false;

				return;
			}

			note.set({
				level: 'success',
				message: `Saved: ${res.changed.join(', ') || 'no changes'}`,
				detail: res.changed.length ? 'Applies on the next restart.' : '',
				closeable: true
			});

			// a version change downloads a jar, so the route handed back a job to watch
			if (res.job) {
				await trackVersionJob(res.job, Notify.loading(`Downloading paper ${cfgVersion}…`));
			} else {
				await refresh();
				await loadTab('config');
			}
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not save ${name}`,
				detail: (err as Error).message,
				progress: null,
				closeable: true
			});
		}

		saving = false;
	}

	async function forceVersion(): Promise<void> {
		saving = true;

		const note = Notify.loading(`Switching ${name} to ${cfgVersion}…`);

		try {
			const res = await patch(`/instances/${name}/config`, {
				mcVersion: cfgVersion,
				forceVersion: true
			});

			versionConflict = [];

			if (res.job) {
				await trackVersionJob(res.job, note);
			} else {
				note.set({ level: 'success', message: `Saved: ${res.changed.join(', ')}`, closeable: true });

				await refresh();
			}
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not change the version of ${name}`,
				detail: (err as Error).message,
				progress: null,
				closeable: true
			});
		}

		saving = false;
	}

	async function deployPlugins(): Promise<void> {
		const note = Notify.loading(`Deploying plugins to ${name}…`);

		try {
			const res = await post('/plugins/deploy', { instances: [name] });
			const changed = res.actions.filter((action: any) => action.action !== 'unchanged').length;

			note.set({
				level: 'success',
				message: `Deployed plugins to ${name} — ${changed} change(s)`,
				detail: res.needRestart?.length ? 'Restart the instance to load them.' : '',
				closeable: true
			});

			await loadTab('plugins');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not deploy plugins to ${name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	async function doDelete(): Promise<void> {
		const note = Notify.loading(`Deleting ${name}…`);

		try {
			await del(`/instances/${name}?purge=${purge}`);

			note.set({
				level: 'success',
				message: `Deleted ${name}`,
				detail: purge ? 'Directory purged.' : '',
				closeable: true
			});

			await goto('/instances');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not delete ${name}`,
				detail: (err as Error).message,
				closeable: true
			});

			deleteOpen = false;
		}
	}

	const isUp = $derived(inst && (inst.state === 'running' || inst.state === 'starting'));
	const checksPassed = $derived(inst ? inst.checks.filter((check: any) => check.ok).length : 0);

	const cpuPoints = $derived(metrics.history.map((sample: any) => ({ t: sample.t, v: sample.cpu })));
	const memPoints = $derived(
		metrics.history.map((sample: any) => ({ t: sample.t, v: sample.rssMb }))
	);
	const playerPoints = $derived(
		metrics.history.map((sample: any) => ({ t: sample.t, v: sample.players }))
	);

	const playerMax = $derived(
		Math.max(5, ...playerPoints.map((point: any) => point.v ?? 0)) * PLAYER_HEADROOM
	);

	// heartbeat-sourced series: only present for samples where LunaCore was reporting
	const tpsPoints = $derived(metrics.history.map((sample: any) => ({ t: sample.t, v: sample.tps })));
	const heapPoints = $derived(
		metrics.history.map((sample: any) => ({ t: sample.t, v: sample.heapUsedMb }))
	);

	const hasHeartbeatSeries = $derived(
		tpsPoints.some((point: any) => point.v != null) ||
			heapPoints.some((point: any) => point.v != null)
	);

	const hostMemMb = $derived(inst?.hostMemMb ?? 0);

	const summaryCells: InfoCell[] = $derived.by(() => {
		if (!inst) {
			return [];
		}

		return [
			{ id: 'state', label: 'Instance state' },
			{ label: 'Software', value: `${inst.software} ${inst.mcVersion ?? ''}` },
			{ label: 'Ping version', value: inst.pingVersion },
			{ label: 'Game address', value: `127.0.0.1:${inst.port}`, copyable: true, style: 'mono' },
			{ label: 'Memory (heap)', value: inst.memory },
			{ label: 'Java profile', value: inst.profile },
			{ label: 'Daemon', value: inst.daemon ?? 'primary' },
			{ label: 'Java PID', value: inst.javaPid },
			{ id: 'cpu', label: 'CPU utilization' },
			{ id: 'rss', label: 'Resident memory' },
			// heartbeat-only figures: the server's own tick rate and heap, which the
			// host-side /proc sampling above cannot see
			{ id: 'tps', label: 'Tick rate' },
			{ id: 'heap', label: 'JVM heap' },
			{ label: 'Uptime', value: fmtDuration(inst.uptimeMs) },
			{
				label: 'Players',
				value: inst.players ? `${inst.players.online}/${inst.players.max}` : null
			},
			{ label: 'Directory', value: inst.dir, copyable: true, style: 'mono' }
		];
	});

	const portCells: InfoCell[] = $derived.by(() => {
		if (!inst) {
			return [];
		}

		return [
			{
				label: 'Game port (tcp)',
				value: `127.0.0.1:${inst.port}`,
				copyable: true,
				style: 'mono'
			},
			...Object.entries(inst.ports).map(([key, port]) => ({
				label: key,
				value: String(port),
				style: 'mono' as const
			}))
		];
	});

	const proxyCells: InfoCell[] = $derived.by(() => {
		if (!inst) {
			return [];
		}

		const registered = inst.proxy?.register
			? 'yes'
			: name === 'proxy'
				? '(is the proxy)'
				: 'no';

		const priority =
			inst.proxy?.priority !== undefined
				? [{ label: 'Try-list priority', value: String(inst.proxy.priority) }]
				: [];

		const forcedHosts = inst.proxy?.forcedHosts?.length
			? [{ label: 'Forced hosts', value: inst.proxy.forcedHosts.join(', ') }]
			: [];

		return [
			{ label: 'Registered in velocity', value: registered },
			...priority,
			...forcedHosts
		];
	});

	const pluginCols: Column[] = [
		{ id: 'name', label: 'Plugin', sortable: true },
		{ id: 'state', label: 'State', sortable: true, width: 130 },
		{ id: 'version', label: 'Version' },
		{ id: 'alerts', label: 'Alerts', sortable: true, width: 230 },
		{ id: 'origin', label: 'From', sortable: true },
		{ id: 'source', label: 'Source', sortable: true },
		{ id: 'auto', label: 'Auto-update', hidden: true },
		{ id: 'assign', label: 'Assignment', hidden: true }
	];

	/** Badge look of each plugin runtime state. */
	const PLUGIN_STATE_BADGE: Record<string, { state: string; label: string }> = {
		running: { state: 'running', label: 'Running' },
		errored: { state: 'failed', label: 'Errored' },
		'not-loaded': { state: 'warning', label: 'Not loaded' },
		disabled: { state: 'stopped', label: 'Disabled' },
		stopped: { state: 'stopped', label: 'Stopped' },
		unknown: { state: 'unknown', label: 'Unknown' }
	};
	/** A plugin row's verbs on this instance. */
	function pluginActions(plugin: any): ContextMenuItem[] {
		return [
			{
				label: 'Open on this instance',
				icon: 'circleInfo',
				action: () => goto(`/instances/${name}/plugins/${plugin.plugin}`)
			},
			{
				label: 'Open the plugin',
				icon: 'plug',
				action: () => goto(`/plugins/${encodeURIComponent(plugin.plugin)}`)
			},
			{ separator: true },
			{
				label: 'Copy version',
				icon: 'copy',
				disabled: !plugin.version,
				action: () => navigator.clipboard?.writeText(plugin.version ?? '')
			}
		];
	}

	const eventCols: Column[] = [
		{ id: 'time', label: 'Time', width: 190 },
		{ id: 'kind', label: 'Type', width: 120 },
		{ id: 'message', label: 'Event' }
	];
	const propCols: Column[] = [
		{ id: 'key', label: 'Property', width: 300 },
		{ id: 'value', label: 'Value' }
	];
</script>

<svelte:head><title>{name} | MRDS Console</title></svelte:head>

{#if inst}
	<PageHeader title={name ?? ''} info>
		{#snippet extra()}<StatusBadge state={inst.state} />{/snippet}
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="instance" />
			<Btn onclick={() => goto(`/instances/${name}/console`)}>Connect</Btn>
			<Dropdown
				label="Instance state"
				items={[
					{
						label: 'Start instance',
						icon: 'play',
						disabled: inst.state !== 'stopped',
						action: () => stateAction('start')
					},
					{
						label: 'Stop instance',
						icon: 'stop',
						disabled: !isUp,
						action: () => stateAction('stop')
					},
					{
						label: 'Restart instance',
						icon: 'rotate',
						disabled: !isUp,
						action: () => stateAction('restart')
					},
					{ divider: true, label: '' },
					{
						label: 'Schedule an action…',
						icon: 'clock',
						action: () => {
							scheduleOpen = true;
						}
					}
				]}
			/>
			<Dropdown
				label="Actions"
				items={[
					{
						label: 'Serial console',
						icon: 'code',
						action: () => goto(`/instances/${name}/console`)
					},
					{ label: 'Deploy plugins here', icon: 'upload', action: () => deployPlugins() },
					{ divider: true, label: '' },
					{
						label: 'Delete instance',
						icon: 'trash',
						danger: true,
						disabled: inst.state !== 'stopped' || name === 'proxy',
						action: () => {
							deleteOpen = true;
						}
					}
				]}
			/>
		{/snippet}
	</PageHeader>

	<OverviewBar title="Instance overview">
		<OverviewCell label="Status">
			<StatusBadge state={inst.state} />
		</OverviewCell>
		<OverviewCell
			label="Status checks ({inst.checks.length})"
			progress={inst.state === 'stopped' ? 0 : checksPassed / inst.checks.length}
			progressColor={checksPassed === inst.checks.length ? 'var(--success)' : 'var(--warning)'}
		>
			{#if inst.state === 'stopped'}
				<span class="dim">instance stopped</span>
			{:else}
				<span style="color:var(--success)">{checksPassed} passed</span>
				<span class="dim">|</span>
				<span class="dim">{inst.checks.length - checksPassed} pending</span>
			{/if}
		</OverviewCell>
		<OverviewCell label="Software">
			{inst.software} {inst.mcVersion ?? ''}
		</OverviewCell>
		<OverviewCell label="Players">
			{inst.players ? `${inst.players.online} / ${inst.players.max}` : '–'}
		</OverviewCell>
		<OverviewCell label="Uptime">
			{fmtDuration(inst.uptimeMs)}
		</OverviewCell>
	</OverviewBar>

	<Tabs
		tabs={[
			{ id: 'details', label: 'Details' },
			{ id: 'checks', label: 'Status and alarms' },
			{ id: 'monitoring', label: 'Monitoring' },
			{ id: 'plugins', label: 'Plugins' },
			{ id: 'network', label: 'Networking' },
			{ id: 'logs', label: 'Logs' },
			{ id: 'config', label: 'Configuration' }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'details'}
			<Panel title="Instance summary">
				<InfoGrid cells={summaryCells}>
					{#snippet custom(cell)}
						{#if cell.id === 'state'}
							<StatusBadge state={inst.state} />
						{:else if cell.id === 'cpu'}
							{#if inst.cpu == null}
								<span class="dim">–</span>
							{:else}
								<ProgressBar compact value={inst.cpu} color="auto" width="10rem" />
							{/if}
						{:else if cell.id === 'rss'}
							{#if inst.rssMb == null}
								<span class="dim">–</span>
							{:else}
								<ProgressBar
									compact
									value={inst.rssMb}
									max={hostMemMb || inst.rssMb}
									color="auto"
									right="{(inst.rssMb / 1024).toFixed(1)} GB"
									width="10rem"
								/>
							{/if}
						{:else if cell.id === 'tps'}
							{#if inst.tps == null}
								<span class="dim" title="LunaCore is not reporting for this instance">–</span>
							{:else}
								<!-- an explicit tone: color="auto" reads a full bar as danger, which is
								     backwards for TPS, where full is healthy -->
								<ProgressBar
									compact
									value={inst.tps}
									max={20}
									color={inst.tps >= 19 ? 'success' : inst.tps >= 15 ? 'warning' : 'danger'}
									right="{inst.tps.toFixed(2)} TPS"
									width="10rem"
								/>
							{/if}
						{:else if cell.id === 'heap'}
							{#if inst.heapUsedMb == null || inst.heapMaxMb == null}
								<span class="dim">–</span>
							{:else}
								<ProgressBar
									compact
									value={inst.heapUsedMb}
									max={inst.heapMaxMb}
									color="auto"
									right="{inst.heapUsedMb} / {inst.heapMaxMb} MB"
									width="10rem"
								/>
							{/if}
						{/if}
					{/snippet}
				</InfoGrid>
			</Panel>
			<div class="gap"></div>
			<Panel
				title="Launch command"
				description="Generated from cluster.json (profile + memory) on every start"
			>
				<code class="cmd mono">{inst.javaCommand}</code>
			</Panel>
		{:else if tab === 'checks'}
			<Panel title="Status checks">
				{#each inst.checks as check}
					<div class="checkrow">
						<StatusBadge
							state={check.ok === undefined ? 'unknown' : check.ok ? 'passed' : 'failed'}
						/>
						<b>{check.name}</b>
						<span class="dim">{check.detail}</span>
					</div>
				{/each}
			</Panel>
			<div class="gap"></div>
			<Panel
				title="Events"
				count={metrics.events.length}
				description="State transitions and actions recorded this console session"
				flush
			>
				<ResourceTable
					tableId="instance-events"
					columns={eventCols}
					rows={metrics.events}
					getId={(event) => String(event.t) + event.message}
					searchValue={(event) => `${event.kind} ${event.message}`}
					searchPlaceholder="Find an event"
					searchWidth="20rem"
					noun="event"
					pageSize={20}
					emptyTitle="No recorded events this session"
					maxHeight="40vh"
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
		{:else if tab === 'monitoring'}
			<div class="charts">
				<Sparkline points={cpuPoints} label="CPU utilization" unit="%" color="#42b4ff" />
				<Sparkline points={memPoints} label="Memory (RSS)" unit=" MB" color="#bf7edb" />
				<Sparkline
					points={playerPoints}
					label="Players online"
					color="#2bb534"
					maxY={playerMax}
				/>
				{#if hasHeartbeatSeries}
					<Sparkline points={tpsPoints} label="Tick rate" unit=" TPS" color="#e0ca57" maxY={20} />
					<Sparkline points={heapPoints} label="JVM heap" unit=" MB" color="#ff9d5c" />
				{/if}
			</div>
			<p class="dim note">
				Sampled every 5s by the mrds daemon (last hour kept in memory).
				{#if hasHeartbeatSeries}
					Tick rate and heap come from LunaCore's heartbeat.
				{/if}
			</p>
		{:else if tab === 'plugins'}
			<Panel title="Plugins on {name}" count={instPlugins.length} flush>
				{#snippet actions()}
					<Alerts warnings={pluginTotals.warnings} errors={pluginTotals.errors} />
					<Btn icon="upload" onclick={deployPlugins}>Deploy to this instance</Btn>
				{/snippet}
				<ResourceTable
					tableId="instance-plugins"
					columns={pluginCols}
					rows={instPlugins}
					getId={(plugin) => plugin.plugin}
					searchValue={(plugin) =>
						`${plugin.plugin} ${plugin.displayName ?? ''} ${plugin.state} ${plugin.version ?? ''} ${plugin.source} ${(plugin.groups ?? []).join(' ')}`}
					searchPlaceholder="Find a plugin on this instance"
					rowActions={pluginActions}
					rowLabel={(plugin) => plugin.plugin}
					noun="plugin"
					pageSize={25}
					rowDim={(plugin) => plugin.disabled}
					sortValue={(plugin, col) =>
						col === 'alerts'
							? plugin.errors * 1000 + plugin.warnings
							: ((plugin as any)[
									col === 'auto' ? 'autoUpdate' : col === 'name' ? 'plugin' : col
								] ?? '')}
					onRowClick={(plugin) => goto(`/instances/${name}/plugins/${plugin.plugin}`)}
				>
					{#snippet cell(plugin, col)}
						{#if col === 'name'}
							<a
								href="/instances/{name}/plugins/{plugin.plugin}"
								onclick={(event) => event.stopPropagation()}
							>
								{plugin.plugin}
							</a>
							{#if plugin.displayName && plugin.displayName !== plugin.plugin}
								<span class="dim">({plugin.displayName})</span>
							{/if}
						{:else if col === 'state'}
							{@const badge = PLUGIN_STATE_BADGE[plugin.state] ?? PLUGIN_STATE_BADGE.unknown}
							<StatusBadge state={badge.state} label={badge.label} />
						{:else if col === 'version'}
							<span class="mono">{plugin.version ?? '?'}</span>
						{:else if col === 'alerts'}
							<Alerts warnings={plugin.warnings} errors={plugin.errors} />
						{:else if col === 'origin'}
							{#if plugin.origin === 'group'}
								<span class="dim">{plugin.groups.join(', ')}</span>
							{:else if plugin.origin === 'manual'}
								<span class="manual">manual</span>
							{:else}
								<span class="dim">explicit</span>
							{/if}
						{:else if col === 'source'}
							{plugin.source}
						{:else if col === 'auto'}
							<StatusBadge
								state={plugin.autoUpdate ? 'ok' : 'stopped'}
								label={plugin.autoUpdate ? 'On' : 'Off'}
							/>
						{:else if col === 'assign'}
							{plugin.pinned ? 'pinned' : plugin.variant ? 'variant (auto)' : 'primary'}
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
			{#if !pluginTotals.sessionComplete}
				<p class="dim note">
					The boot lines of this session have rotated out of the log window, so plugins with no
					later log activity read as Unknown.
				</p>
			{/if}
		{:else if tab === 'network'}
			<Panel title="Ports">
				<InfoGrid cells={portCells} />
			</Panel>
			<div class="gap"></div>
			<Panel title="Proxy registration">
				<InfoGrid cells={proxyCells} />
			</Panel>
		{:else if tab === 'logs'}
			<Panel title="latest.log" flush>
				{#snippet actions()}
					<Select
						value={String(logLines)}
						width="9rem"
						options={LOG_LINE_CHOICES.map((count) => ({
							value: String(count),
							label: `${count} lines`
						}))}
						onchange={(value) => {
							logLines = Number(value);
							void loadTab('logs');
						}}
					/>
					<Btn icon="sync" onclick={() => loadTab('logs')}>Refresh</Btn>
					<Btn icon="code" onclick={() => goto(`/instances/${name}/console`)}>Live console</Btn>
				{/snippet}
				<pre class="logview mono">{logData.content || '(empty)'}</pre>
			</Panel>
			{#if logData.archives.length}
				<div class="gap"></div>
				<Panel title="Archived logs" count={logData.archives.length}>
					{#each logData.archives as archive}
						<div class="checkrow">
							<span class="mono">{archive.file}</span>
							<span class="dim">{fmtBytes(archive.sizeBytes)}</span>
						</div>
					{/each}
				</Panel>
			{/if}
		{:else if tab === 'config'}
			{#if cfgData}
				<Panel
					title="Instance configuration"
					description="Memory, profile and JVM flags apply on the next restart"
				>
					<div class="cfg">
						<label class="field">
							<span class="lbl">Memory (heap)</span>
							<span class="hint">-Xms/-Xmx, e.g. 2G</span>
							<input class="input" bind:value={cfgMemory} />
						</label>
						<div class="field">
							<span class="lbl">Java profile</span>
							<span class="hint">JVM flag set from cluster.json</span>
							<Select
								bind:value={cfgProfile}
								width="100%"
								options={cfgData.profiles.map((entry: string) => ({
									value: entry,
									label: entry
								}))}
							/>
						</div>
						<label class="field">
							<span class="lbl">Extra JVM arguments</span>
							<span class="hint">
								Appended after the profile's flags — see the resolved command on the Details
								tab. Space separated, flags only; -Xmx/-Xms come from the memory field above.
							</span>
							<input class="input mono" bind:value={cfgJavaArgs} placeholder="(none)" />
						</label>
						{#if inst.software === 'paper'}
							<div class="field">
								<span class="lbl">Minecraft version</span>
								<span class="hint">
									Downloads the latest Paper build for the chosen version (instance must be
									stopped). Plugin compatibility is checked first.
								</span>
								<Select
									bind:value={cfgVersion}
									width="100%"
									options={paperVersions.map((version: string) => ({
										value: version,
										label: version
									}))}
								/>
							</div>
						{/if}
						{#if versionConflict.length}
							<Flash kind="error">
								<b>Version change blocked — incompatible plugins:</b><br />
								{#each versionConflict as conflict}
									· {conflict.plugin} {conflict.version} (supports {conflict.gameVersions?.join(
										', '
									)})<br />
								{/each}
								<div class="conflict-actions">
									<Btn variant="danger" onclick={forceVersion}>Force anyway</Btn>
									<Btn onclick={() => (versionConflict = [])}>Cancel</Btn>
								</div>
							</Flash>
						{/if}
						<Btn variant="primary" loading={saving} onclick={saveConfig}>Save changes</Btn>
					</div>
				</Panel>
				{#if versionJob}
					<div class="gap"></div>
					<Panel title="Version change" description="Live from the same reporter the CLI renders">
						<ProgressTree root={versionJob.progress} state={versionJob.state} />
					</Panel>
				{/if}
				<div class="gap"></div>
				<Panel
					title="Plugin groups"
					count={groupsDirty ? 'unsaved' : undefined}
					description="Groups applied to this instance (default always is) — saving redeploys its plugins immediately; a running server loads them on restart"
				>
					<GroupsField
						software={cfgData.software}
						mcVersion={cfgData.mcVersion ?? undefined}
						instance={name}
						bind:selected={cfgPluginGroups}
					/>
				</Panel>
				<div class="gap"></div>
				<Panel
					title="Server settings"
					count={settingEditCount ? `${settingEditCount} unsaved` : undefined}
					description="server.properties, applied on the next restart — Save changes above writes them"
				>
					<SettingsForm
						schema={cfgData.schema}
						groups={cfgData.groups}
						bind:values={cfgSettings}
					/>
				</Panel>
				<div class="gap"></div>
				<Panel
					title="server.properties"
					description="Every key on disk, including the ones with no field above"
					flush
				>
					<ResourceTable
						tableId="instance-properties"
						columns={propCols}
						rows={Object.entries(cfgData.serverProperties).map(([key, value]) => ({
							key,
							value: String(value)
						}))}
						getId={(row) => row.key}
						searchValue={(row) => `${row.key} ${row.value}`}
						searchPlaceholder="Find a property"
						searchWidth="20rem"
						noun="property"
						paging={false}
						maxHeight="20rem"
					>
						{#snippet cell(row, col)}
							{#if col === 'key'}
								<span class="mono">{row.key}</span>
							{:else}
								<span class="mono dim">{row.value}</span>
							{/if}
						{/snippet}
					</ResourceTable>
				</Panel>
			{/if}
		{/if}
	</div>
{/if}

<ScheduleQuickModal bind:open={scheduleOpen} instances={name ? [name] : []} />

<Modal title="Delete instance {name}" bind:open={deleteOpen}>
	<p>This deregisters <b>{name}</b> from the cluster and the proxy.</p>
	<label class="purgerow">
		<Checkbox
			checked={purge}
			label="Delete the instance directory"
			onchange={(value) => (purge = value)}
		/>
		Also permanently delete the instance directory (worlds included)
	</label>
	{#if purge}
		<label class="field">
			<span class="lbl">Type the instance name to confirm purge</span>
			<input class="input" bind:value={deleteText} placeholder={name} />
		</label>
	{/if}
	{#snippet footer()}
		<Btn onclick={() => (deleteOpen = false)}>Cancel</Btn>
		<Btn variant="danger" disabled={purge && deleteText !== name} onclick={doDelete}>Delete</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.tabbody {
		margin-top: 1rem;
	}

	// panels inside one tab are separated by an explicit spacer element
	.gap {
		height: 1rem;
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

	.charts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: 1rem;
	}

	.manual {
		color: var(--link);
		font-size: 0.8125rem;
	}

	.note {
		margin-top: 0.625rem;
	}

	.cmd {
		display: block;
		white-space: pre-wrap;
		word-break: break-all;
		padding: 0.75rem 1rem;
		background: var(--bg-terminal);
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.5rem;
		font-size: 0.75rem;
		line-height: 1.6;
	}
	.logview {
		margin: 0;
		padding: 0.75rem 1rem;
		max-height: 55vh;
		overflow: auto;
		font-size: 0.75rem;
		line-height: 1.5;
		background: var(--bg-terminal);
		white-space: pre-wrap;
		word-break: break-all;
	}
	.cfg {
		max-width: 30rem;
	}

	.conflict-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.625rem;
	}

	.purgerow {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin: 0.75rem 0;
	}
</style>
