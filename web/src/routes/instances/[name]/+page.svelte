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
	import DataTable from '$lib/components/DataTable.svelte';
	import type { Column } from '$lib/components/table';

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
	let paperVersions: string[] = $state([]);
	let saving = $state(false);
	let deleteOpen = $state(false);
	let deleteText = $state('');
	let purge = $state(false);
	let versionConflict: any[] = $state([]);

	let instPlugins: any[] = $state([]);
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
			instPlugins = (await api(`/instances/${name}/plugins`)).plugins;
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

	async function saveConfig(): Promise<void> {
		saving = true;
		versionConflict = [];

		const note = Notify.loading(`Saving configuration for ${name}…`);

		try {
			const body: any = { memory: cfgMemory, profile: cfgProfile };

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
			} else {
				note.set({
					level: 'success',
					message: `Saved: ${res.changed.join(', ') || 'no changes'}`,
					detail: res.changed.length ? 'Applies on the next restart.' : '',
					closeable: true
				});

				await refresh();
				await loadTab('config');
			}
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not save ${name}`,
				detail: (err as Error).message,
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

			note.set({
				level: 'success',
				message: `Saved: ${res.changed.join(', ')}`,
				closeable: true
			});

			versionConflict = [];

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not change the version of ${name}`,
				detail: (err as Error).message,
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
			{ label: 'Java PID', value: inst.javaPid },
			{ id: 'cpu', label: 'CPU utilization' },
			{ id: 'rss', label: 'Resident memory' },
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
		{ id: 'version', label: 'Version' },
		{ id: 'source', label: 'Source', sortable: true },
		{ id: 'auto', label: 'Auto-update' },
		{ id: 'assign', label: 'Assignment' }
	];
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
				<DataTable
					columns={eventCols}
					rows={metrics.events}
					getId={(event) => String(event.t) + event.message}
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
				</DataTable>
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
			</div>
			<p class="dim note">
				Sampled every 5s while the console server runs (last hour kept in memory).
			</p>
		{:else if tab === 'plugins'}
			<Panel title="Plugins on {name}" count={instPlugins.length} flush>
				{#snippet actions()}
					<Btn icon="upload" onclick={deployPlugins}>Deploy to this instance</Btn>
				{/snippet}
				<DataTable
					columns={pluginCols}
					rows={instPlugins}
					getId={(plugin) => plugin.name}
					sortValue={(plugin, col) =>
						(plugin as any)[col === 'auto' ? 'autoUpdate' : col] ?? ''}
					onRowClick={(plugin) => goto(`/plugins?sel=${plugin.name}`)}
				>
					{#snippet cell(plugin, col)}
						{#if col === 'name'}
							<a href="/plugins?sel={plugin.name}">{plugin.name}</a>
						{:else if col === 'version'}
							<span class="mono">{plugin.version ?? '?'}</span>
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
				</DataTable>
			</Panel>
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
					description="Memory and profile apply on the next restart"
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
				<div class="gap"></div>
				<Panel title="server.properties" flush>
					<DataTable
						columns={propCols}
						rows={Object.entries(cfgData.serverProperties).map(([key, value]) => ({
							key,
							value: String(value)
						}))}
						getId={(row) => row.key}
						maxHeight="20rem"
					>
						{#snippet cell(row, col)}
							{#if col === 'key'}
								<span class="mono">{row.key}</span>
							{:else}
								<span class="mono dim">{row.value}</span>
							{/if}
						{/snippet}
					</DataTable>
				</Panel>
			{/if}
		{/if}
	</div>
{/if}

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
