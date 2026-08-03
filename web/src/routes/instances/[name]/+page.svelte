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
	import Flash from '$lib/components/Flash.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import DeleteInstanceModal from '$lib/components/DeleteInstanceModal.svelte';
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
	import { instanceStateJob, attachInstanceJobFlash, type StateAction } from '$lib/instancejobs';

	/** how often the header's status is re-read */
	const POLL_MS = 4000;

	/**
	 * Tabs whose data the refresh control re-reads along with the header.
	 *
	 * `config` is deliberately absent: it is a form, and reloading it under the
	 * user would discard whatever they were typing. It is also why the tab data
	 * rides the refresh control's cadence rather than the fast header poll —
	 * a plugin report scans the instance's jars and its boot session, which is
	 * not something to do every four seconds.
	 */
	const REFRESHED_TABS = ['plugins', 'datapacks', 'respacks', 'monitoring', 'checks', 'logs'];

	const LOG_LINE_CHOICES = [100, 200, 500, 1000];

	/** headroom over the busiest sample, so the player chart never clips */
	const PLAYER_HEADROOM = 1.2;

	const name = $derived(page.params.name);

	let inst: any = $state(null);
	let tab = $state('details');

	// a mod loader keeps its addons in mods/, so the tab is called what the
	// operator will look for — the rows and the API behind them are the same
	const addonLabel = $derived(inst?.software === 'neoforge' ? 'Mods' : 'Plugins');

	let cfgData: any = $state(null);
	let cfgMemory = $state('');
	let cfgProfile = $state('');
	let cfgVersion = $state('');
	let cfgJavaArgs = $state('');
	let cfgSettings: Record<string, string> = $state({});
	let cfgAddonGroups: string[] = $state([]);
	let paperVersions: string[] = $state([]);
	let saving = $state(false);
	let versionJob: JobView | null = $state(null);
	let deleteOpen = $state(false);
	let scheduleOpen = $state(false);
	let versionConflict: any[] = $state([]);

	let instPlugins: any[] = $state([]);
	let pluginTotals = $state({ warnings: 0, errors: 0, sessionComplete: true });
	let instDatapacks: any[] = $state([]);
	let datapackWorld = $state('');
	let instRespacks: any[] = $state([]);
	let metrics: { history: any[]; events: any[] } = $state({ history: [], events: [] });
	let logData: { content: string; archives: any[] } = $state({ content: '', archives: [] });
	let logLines = $state(200);

	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	/** name of the primary daemon — the machine an ownerless instance runs on */
	let hostName = $state('');

	/**
	 * Re-read the page. `tabData` also reloads whatever the open tab is showing —
	 * what the refresh control asks for, so the plugins table and the charts are
	 * as current as the header above them; the fast poll leaves them alone.
	 */
	async function refresh(opts: { tabData?: boolean } = {}): Promise<void> {
		// the poll can outlive the route by a tick during a client-side navigation,
		// at which point page.params.name is already gone
		if (!name) {
			return;
		}

		loading = true;

		try {
			inst = await api(`/instances/${name}`);

			if (opts.tabData && REFRESHED_TABS.includes(tab)) {
				await loadTab(tab);
			}

			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(`Could not load ${name}`, { detail: (err as Error).message });
		} finally {
			loading = false;
		}

		// an operation already in flight for this instance — started elsewhere, or
		// before a reload — gets its flash card raised here; attached jobs dedupe,
		// so re-checking on every poll is safe
		try {
			const running = await api(`/jobs?target=${encodeURIComponent(name)}&state=running`);

			for (const job of running.jobs) {
				attachInstanceJobFlash(job);
			}
		} catch {
			// job discovery is best-effort — the page itself already refreshed
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

		if (which === 'datapacks') {
			const data = await api(`/instances/${name}/datapacks`);

			instDatapacks = data.rows;
			datapackWorld = data.world;
		}

		if (which === 'respacks') {
			// the catalog is proxy-global; this tab shows how it lands here
			instRespacks = (await api('/respacks')).packs;
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
			cfgAddonGroups = [...(cfgData.addonGroups ?? [])];

			if (!paperVersions.length) {
				paperVersions = (await api('/paper')).versions;
			}
		}
	}

	onMount(() => {
		// the instances table deep-links into a tab
		const urlTab = page.url.searchParams.get('tab');

		if (urlTab) {
			tab = urlTab;
		}

		void refresh();

		void api('/host')
			.then((host) => (hostName = host.name ?? ''))
			.catch(() => {});

		const poll = setInterval(refresh, POLL_MS);

		return () => clearInterval(poll);
	});

	$effect(() => {
		void tab;
		void loadTab(tab);
	});

	async function stateAction(action: StateAction): Promise<void> {
		if (!name) {
			return;
		}

		// the flash card follows the job's log-derived progress on its own; the
		// page just re-reads its header once the transition settles
		await instanceStateJob(name, action);
		await refresh();
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

		const before: string[] = cfgData.addonGroups ?? [];

		return (
			before.length !== cfgAddonGroups.length ||
			cfgAddonGroups.some((group) => !before.includes(group))
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
				body.addonGroups = cfgAddonGroups;
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

	/** Sync this instance's world from the data pack pool. */
	async function deployDatapacks(): Promise<void> {
		const note = Notify.loading(`Deploying data packs to ${name}…`);

		try {
			const res = await post(`/instances/${name}/datapacks`, { action: 'deploy' });
			const changed = res.actions.filter((action: any) => action.action !== 'unchanged').length;

			note.set({
				level: 'success',
				message: `Deployed data packs to ${name} — ${changed} change(s)`,
				detail: changed ? 'The server loads them on its next restart (or /minecraft:reload).' : '',
				closeable: true
			});

			await loadTab('datapacks');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not deploy data packs to ${name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	/** Pull a hand-dropped world zip into the shared pool. */
	async function adoptDatapack(file: string): Promise<void> {
		const note = Notify.loading(`Adopting ${file} into the pool…`);

		try {
			const res = await post(`/instances/${name}/datapacks`, { action: 'adopt', file });

			note.set({
				level: 'success',
				message: `Adopted ${res.name} — it now deploys from the pool`,
				closeable: true
			});

			await loadTab('datapacks');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not adopt ${file}`,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	/** Remove a managed data pack from this instance's world only. */
	async function removeDatapackHere(pack: string): Promise<void> {
		const note = Notify.loading(`Removing ${pack} from ${name}…`);

		try {
			await del(`/datapacks/${encodeURIComponent(pack)}?from=${encodeURIComponent(name ?? '')}`);

			note.set({
				level: 'success',
				message: `${pack} no longer targets ${name}`,
				detail: 'The server unloads it on its next restart.',
				closeable: true
			});

			await loadTab('datapacks');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not remove ${pack}`,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	/** Flip a resource pack's enabled flag and reload the proxy's catalog. */
	async function setRespackEnabled(key: string, enabled: boolean): Promise<void> {
		const note = Notify.loading(`${enabled ? 'Enabling' : 'Disabling'} ${key}…`);

		try {
			await patch(`/respacks/${encodeURIComponent(key)}`, { enabled });

			const reload = await post('/respacks/reload');

			note.set({
				level: 'success',
				message: `${key} ${enabled ? 'enabled' : 'disabled'}`,
				detail: reload.sent
					? 'Reload sent to the proxy — the change is live.'
					: 'The proxy is not running; the change applies on its next boot.',
				closeable: true
			});

			await loadTab('respacks');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not update ${key}`,
				detail: (err as Error).message,
				closeable: true
			});
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
			{
				label: 'Machine',
				value: inst.daemon ?? (hostName || 'primary'),
				href:
					(inst.daemon ?? hostName)
						? `/machines/${inst.daemon ?? hostName}`
						: undefined
			},
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

	const datapackCols: Column[] = [
		{ id: 'file', label: 'Data pack', sortable: true },
		{ id: 'state', label: 'State', width: 150 },
		{ id: 'version', label: 'Version' },
		{ id: 'size', label: 'Size', width: 100, align: 'right' },
		{ id: 'source', label: 'Source' }
	];

	/** A data pack row's verbs on this instance. */
	function datapackActions(row: any): ContextMenuItem[] {
		return [
			{
				label: 'Manage in the pool',
				icon: 'box',
				disabled: !row.managed,
				hint: !row.managed ? 'not a pooled pack yet — adopt it first' : undefined,
				action: () => goto(`/datapacks?q=${encodeURIComponent(row.name ?? '')}`)
			},
			{
				label: 'Adopt into the pool',
				icon: 'inboxIn',
				disabled: row.managed,
				hint: row.managed ? 'already pooled' : undefined,
				action: () => adoptDatapack(row.file)
			},
			{ separator: true },
			{
				label: 'Remove from this instance',
				icon: 'trash',
				color: 'danger',
				disabled: !row.managed || !row.targeted,
				hint: !row.managed
					? 'unmanaged file — delete it from the world by hand, or adopt it first'
					: !row.targeted
						? 'not targeted here — a deploy already removes it'
						: undefined,
				action: () => removeDatapackHere(row.name)
			}
		];
	}

	const respackCols: Column[] = [
		{ id: 'name', label: 'Resource pack', sortable: true },
		{ id: 'applies', label: 'On this server', width: 150 },
		{ id: 'state', label: 'State', width: 130 },
		{ id: 'priority', label: 'Priority', width: 90, align: 'right' },
		{ id: 'servers', label: 'Server rules' },
		{ id: 'version', label: 'Version' }
	];

	/** A resource pack row's verbs, seen from this instance. */
	function respackActions(row: any): ContextMenuItem[] {
		return [
			{
				label: row.enabled ? 'Disable pack' : 'Enable pack',
				icon: row.enabled ? 'toggleOff' : 'toggleOn',
				action: () => setRespackEnabled(row.key, !row.enabled)
			},
			{
				label: 'Manage in Resource packs',
				icon: 'image',
				action: () => goto(`/packs?q=${encodeURIComponent(row.key)}`)
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

<svelte:head><title>{name} | Luna Console</title></svelte:head>

{#if inst}
	<PageHeader title={name ?? ''} info>
		{#snippet extra()}<StatusBadge state={inst.state} />{/snippet}
		{#snippet actions()}
			<RefreshControl
				onrefresh={() => refresh({ tabData: true })}
				{lastUpdated}
				{loading}
				storageKey="instance"
			/>
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
			{ id: 'plugins', label: addonLabel },
			// the proxy has no world for data packs, and resource packs are ITS
			// catalog — the per-backend view only makes sense on a backend
			...(inst.software === 'velocity'
				? []
				: [
						{ id: 'datapacks', label: 'Data packs' },
						{ id: 'respacks', label: 'Resource packs' }
					]),
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
				Sampled every 5s by the luna daemon (last hour kept in memory).
				{#if hasHeartbeatSeries}
					Tick rate and heap come from LunaCore's heartbeat.
				{/if}
			</p>
		{:else if tab === 'plugins'}
			<Panel title="{addonLabel} on {name}" count={instPlugins.length} flush>
				{#snippet actions()}
					<Alerts warnings={pluginTotals.warnings} errors={pluginTotals.errors} />
					<Btn icon="sync" onclick={() => loadTab('plugins')}>Refresh</Btn>
					<Btn icon="upload" onclick={deployPlugins}>Deploy to this instance</Btn>
				{/snippet}
				<ResourceTable
					tableId="instance-plugins"
					columns={pluginCols}
					rows={instPlugins}
					getId={(plugin) => plugin.plugin}
					searchValue={(plugin) =>
						`${plugin.plugin} ${plugin.displayName ?? ''} ${plugin.state} ${plugin.version ?? ''} ${plugin.source} ${(plugin.groups ?? []).join(' ')}`}
					searchPlaceholder="Find an addon on this instance"
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
		{:else if tab === 'datapacks'}
			<Panel
				title="Data packs in {datapackWorld || 'the world'}"
				count={instDatapacks.length}
				flush
			>
				{#snippet actions()}
					<Btn icon="sync" onclick={() => loadTab('datapacks')}>Refresh</Btn>
					<Btn icon="box" onclick={() => goto('/datapacks')}>Manage pool</Btn>
					<Btn icon="upload" onclick={deployDatapacks}>Deploy to this instance</Btn>
				{/snippet}
				<ResourceTable
					tableId="instance-datapacks"
					columns={datapackCols}
					rows={instDatapacks}
					getId={(row) => row.file}
					searchValue={(row) => `${row.file} ${row.name ?? ''} ${row.source ?? ''}`}
					searchPlaceholder="Find a data pack in this world"
					rowActions={datapackActions}
					rowLabel={(row) => row.file}
					noun="data pack"
					pageSize={25}
					rowDim={(row) => row.managed && !row.targeted}
					emptyTitle="No data packs"
					emptyText="Deploy pooled packs here, or drop zips into the world's datapacks folder."
				>
					{#snippet cell(row, col)}
						{#if col === 'file'}
							<span class="mono">{row.file}</span>
							{#if !row.managed}
								<span class="manual">unmanaged</span>
							{/if}
						{:else if col === 'state'}
							{#if !row.present}
								<StatusBadge
									state="warning"
									label="Not deployed"
									detail="targeted here but missing from the world — deploy to copy it in"
								/>
							{:else if row.stale}
								<StatusBadge
									state="warning"
									label="Stale"
									detail="the world's copy differs from the pool — deploy to update it"
								/>
							{:else if row.managed && !row.targeted}
								<StatusBadge
									state="stopped"
									label="Untargeted"
									detail="still in the world but no longer targeted — a deploy removes it"
								/>
							{:else}
								<StatusBadge state="ok" label="In sync" />
							{/if}
						{:else if col === 'version'}
							<span class="mono">{row.versionNumber ?? '–'}</span>
						{:else if col === 'size'}
							{row.present ? fmtBytes(row.sizeBytes) : '–'}
						{:else if col === 'source'}
							{row.source ?? '–'}
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
			<p class="dim note">
				A running server loads data pack changes on its next restart (or /minecraft:reload).
			</p>
		{:else if tab === 'respacks'}
			<Panel title="Resource packs" count={instRespacks.length} flush>
				{#snippet actions()}
					<Btn icon="sync" onclick={() => loadTab('respacks')}>Refresh</Btn>
					<Btn icon="image" onclick={() => goto('/packs')}>Manage packs</Btn>
				{/snippet}
				<ResourceTable
					tableId="instance-respacks"
					columns={respackCols}
					rows={instRespacks}
					getId={(row) => row.key}
					searchValue={(row) => `${row.key} ${row.name} ${row.servers.join(' ')}`}
					searchPlaceholder="Find a resource pack"
					rowActions={respackActions}
					rowLabel={(row) => row.key}
					noun="pack"
					pageSize={25}
					rowDim={(row) => !row.matched.includes(name ?? '')}
					sortValue={(row, col) =>
						col === 'applies'
							? row.matched.includes(name ?? '')
								? 0
								: 1
							: ((row as any)[col === 'name' ? 'key' : col] ?? '')}
					emptyTitle="No resource packs"
					emptyText="The proxy's pack catalog is empty — add packs on the Resource packs screen."
				>
					{#snippet cell(row, col)}
						{#if col === 'name'}
							{row.key}
							{#if row.name && row.name.toLowerCase() !== row.key}
								<span class="dim">({row.name})</span>
							{/if}
						{:else if col === 'applies'}
							{#if row.matched.includes(name ?? '') && row.enabled}
								<StatusBadge state="ok" label="Applies" />
							{:else if row.matched.includes(name ?? '')}
								<StatusBadge
									state="stopped"
									label="Would apply"
									detail="the server rules match, but the pack is disabled"
								/>
							{:else}
								<span class="dim">no</span>
							{/if}
						{:else if col === 'state'}
							{#if row.enabled}
								<StatusBadge state="ok" label="Enabled" />
							{:else}
								<StatusBadge state="stopped" label="Disabled" />
							{/if}
						{:else if col === 'priority'}
							{row.priority}
						{:else if col === 'servers'}
							<span class="mono">{row.servers.join(', ') || '–'}</span>
						{:else if col === 'version'}
							<span class="mono">{row.versionNumber ?? '–'}</span>
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
			<p class="dim note">
				Resource packs are served by the proxy: players get every enabled pack whose server rules
				match <b>{name}</b>, stacked by priority.
			</p>
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
					title="Addon groups"
					count={groupsDirty ? 'unsaved' : undefined}
					description="Groups applied to this instance (default always is) — saving pushes their plugins, resource pack rules and data packs immediately; a running server loads them on restart"
				>
					<GroupsField
						software={cfgData.software}
						mcVersion={cfgData.mcVersion ?? undefined}
						instance={name}
						bind:selected={cfgAddonGroups}
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

<!-- deleting from here has nowhere to stay: the page it is on is about to stop
     existing, so the list is where the job's card is followed from -->
<DeleteInstanceModal
	bind:open={deleteOpen}
	name={name ?? ''}
	ondeleted={() => void goto('/instances')}
/>

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
</style>
