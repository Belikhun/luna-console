<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { api, post, patch, del } from '$lib/api';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import SearchInput from '$lib/components/SearchInput.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import DetailPanel from '$lib/components/DetailPanel.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import Modal from '$lib/components/Modal.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Select from '$lib/components/Select.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import ContextMenu from '$lib/components/ContextMenu.svelte';
	import { Notify, type NotificationHandle } from '$lib/notifications.svelte';
	import type { ContextMenuItem } from '$lib/components/contextmenu';

	/** how many MC versions a pin option lists before it trails off */
	const MC_LABEL_LIMIT = 6;

	let plugins: any[] = $state([]);
	let filter = $state('');
	let selected: Set<string> = $state(new Set());
	let busy = $state('');
	let detailTab = $state('info');
	let updates: any[] = $state([]);
	let checked = $state(false);

	let addOpen = $state(false);
	let addQuery = $state('');
	let addLoader = $state<'paper' | 'velocity'>('paper');
	let addHits: any[] = $state([]);
	let addSlug = $state('');
	let addTargets: string[] = $state([]);
	let pinOpen = $state(false);
	let pinVersions: any[] = $state([]);
	let pinVersion = $state('');
	let pinTargets: string[] = $state([]);
	let removeOpen = $state(false);
	let panelLocation: 'bottom' | 'right' = $state('bottom');
	let panelSize = $state(42);

	const filtered = $derived.by(() => {
		if (!filter) {
			return plugins;
		}

		const needle = filter.toLowerCase();

		return plugins.filter(
			(plugin) => plugin.name.includes(needle) || plugin.source.includes(needle)
		);
	});

	const one = $derived(
		selected.size === 1 ? plugins.find((plugin) => selected.has(plugin.name)) : undefined
	);

	const instanceNames = $derived(
		[...new Set(plugins.flatMap((plugin) => plugin.expandedTargets))].sort() as string[]
	);

	const updatesFor = (name: string) => updates.find((entry) => entry.name === name);

	const filters: TableFilterGroup<any>[] = [
		{
			id: 'source',
			label: 'Filter source',
			options: [
				{ value: 'any', label: 'Any source' },
				{
					value: 'modrinth',
					label: 'Modrinth managed',
					match: (plugin) => plugin.source === 'modrinth'
				},
				{ value: 'luna', label: 'Luna in-house', match: (plugin) => plugin.source === 'luna' },
				{
					value: 'manual',
					label: 'Manually installed',
					match: (plugin) => plugin.source === 'manual'
				}
			]
		},
		{
			id: 'loader',
			label: 'Filter loader',
			options: [
				{ value: 'any', label: 'Any loader' },
				{ value: 'paper', label: 'Paper', match: (plugin) => plugin.loader === 'paper' },
				{ value: 'velocity', label: 'Velocity', match: (plugin) => plugin.loader === 'velocity' }
			]
		},
		{
			id: 'updates',
			label: 'Filter update policy',
			options: [
				{ value: 'any', label: 'Any policy' },
				{
					value: 'auto-off',
					label: 'Auto-update disabled',
					match: (plugin) => !plugin.autoUpdate
				},
				{
					value: 'pinned',
					label: 'Has pinned versions',
					match: (plugin) => Object.keys(plugin.pins ?? {}).length > 0
				}
			]
		}
	];

	const columns: Column[] = [
		{ id: 'name', label: 'Name', sortable: true },
		{ id: 'source', label: 'Source', sortable: true },
		{ id: 'loader', label: 'Loader', sortable: true },
		{ id: 'version', label: 'Version' },
		{ id: 'update', label: 'Update' },
		{ id: 'auto', label: 'Auto-update', sortable: true },
		{ id: 'channel', label: 'Channel' },
		{ id: 'targets', label: 'Targets' }
	];

	let loading = $state(true);
	let lastUpdated: number | null = $state(null);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			plugins = (await api('/plugins')).plugins;
			lastUpdated = Date.now();
		} finally {
			loading = false;
		}
	}

	onMount(async () => {
		await refresh();

		// other pages deep-link a plugin into the split panel
		const preselect = page.url.searchParams.get('sel');

		if (preselect) {
			selected = new Set([preselect]);
		}
	});

	/**
	 * Run a plugin operation behind a loading flash. The operation settles the
	 * flash itself with its own summary; anything it leaves untouched falls back
	 * to a generic success, and a throw turns the same flash into the error.
	 */
	async function run(
		label: string,
		pending: string,
		fn: (note: NotificationHandle) => Promise<void>
	): Promise<void> {
		busy = label;

		const note = Notify.loading(pending);

		try {
			await fn(note);

			if (note.level === 'loading') {
				note.set({ level: 'success', message: 'Done', closeable: true });
			}
		} catch (err) {
			note.set({
				level: 'error',
				message: `${pending.replace(/…$/, '')} failed`,
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = '';
	}

	/** Deploy one plugin to its targets, behind a loading flash. */
	function deployOne(name: string): Promise<void> {
		return run('deploy1', `Deploying ${name}…`, async (note) => {
			await post('/plugins/deploy', { plugin: name });
			note.set({ level: 'success', message: `Deployed ${name}`, closeable: true });
		});
	}

	/** Flip a plugin's auto-update flag, behind a loading flash. */
	function toggleAutoUpdate(plugin: any): Promise<void> {
		const verb = plugin.autoUpdate ? 'Disabling' : 'Enabling';

		return run('auto', `${verb} auto-update for ${plugin.name}…`, async (note) => {
			await patch(`/plugins/${plugin.name}`, { autoUpdate: !plugin.autoUpdate });

			note.set({
				level: 'success',
				message: `Auto-update ${plugin.autoUpdate ? 'disabled' : 'enabled'} for ${plugin.name}`,
				closeable: true
			});

			await refresh();
		});
	}

	const checkUpdates = () =>
		run('check', 'Checking Modrinth for updates…', async (note) => {
			updates = (await post('/plugins/check')).candidates;
			checked = true;

			note.set({
				level: updates.length ? 'info' : 'success',
				message: updates.length
					? `${updates.length} plugin(s) have updates or holdbacks`
					: 'Everything is up to date',
				closeable: true
			});
		});

	const updateAll = () =>
		run('update', 'Downloading and deploying updates…', async (note) => {
			const res = await post('/plugins/update', { deploy: true });
			note.set({
				level: 'success',
				message: `Updated ${res.applied.length} version group(s), deployed ${res.deployed} file(s)`,
				detail: 'Restart the affected instances to load them.',
				closeable: true
			});
			updates = [];

			await refresh();
		});

	const deployAll = () =>
		run('deploy', 'Deploying plugins to every target…', async (note) => {
			const res = await post('/plugins/deploy', {});
			const changed = res.actions.filter((action: any) => action.action !== 'unchanged').length;

			note.set({
				level: 'success',
				message: `Deploy complete — ${changed} change(s)`,
				detail: res.needRestart.length ? `Restart to apply: ${res.needRestart.join(', ')}` : '',
				closeable: true
			});
		});

	const scan = () =>
		run('scan', 'Scanning plugin directories…', async (note) => {
			const res = await post('/plugins/scan');

			note.set({
				level: 'success',
				message: `Scan complete — ${res.report.identified.length} identified`,
				detail:
					`${res.report.unmanaged.length} unmanaged instance-only jars, ` +
					`${res.report.caseMismatches.length} case mismatches`,
				closeable: true
			});

			await refresh();
		});

	async function searchModrinth(): Promise<void> {
		const query = encodeURIComponent(addQuery);

		addHits = (await api(`/plugins/search?q=${query}&loader=${addLoader}`)).hits;
	}

	const installPlugin = () =>
		run('add', `Installing ${addSlug} from Modrinth…`, async (note) => {
			const res = await post('/plugins/add', {
				slug: addSlug,
				loader: addLoader,
				targets: addTargets
			});

			note.set({
				level: 'success',
				message: `Installed ${res.name}`,
				detail: res.groups
					.map((group: any) => `${group.version} → ${group.targets.join(', ')}`)
					.join('; '),
				closeable: true
			});

			addOpen = false;

			await refresh();
		});

	async function openPin(): Promise<void> {
		if (!one) {
			return;
		}

		pinOpen = true;
		pinVersions = [];
		pinTargets = [...one.expandedTargets];
		pinVersions = (await api(`/plugins/pin?name=${one.name}`)).versions;
		pinVersion = pinVersions[0]?.versionNumber ?? '';
	}

	const doPin = () =>
		run('pin', `Pinning ${one?.name} to ${pinVersion}…`, async (note) => {
			await post('/plugins/pin', { name: one!.name, version: pinVersion, targets: pinTargets });
			await post('/plugins/deploy', { plugin: one!.name });

			note.set({
				level: 'success',
				message: `Pinned ${one!.name} to ${pinVersion} and deployed`,
				closeable: true
			});

			pinOpen = false;

			await refresh();
		});

	const doUnpin = () =>
		run('unpin', `Unpinning ${one?.name}…`, async (note) => {
			await post('/plugins/unpin', { name: one!.name });

			note.set({
				level: 'success',
				message: `Unpinned ${one!.name}`,
				detail: 'Run Update to re-resolve versions.',
				closeable: true
			});

			await refresh();
		});

	const doRemove = () =>
		run('remove', `Removing ${one?.name}…`, async (note) => {
			await del(`/plugins/${one!.name}`);
			note.set({ level: 'success', message: `Removed ${one!.name}`, closeable: true });

			removeOpen = false;
			selected = new Set();

			await refresh();
		});

	/** Add or remove one target from a checkbox list. */
	function toggleTarget(list: string[], target: string): string[] {
		return list.includes(target) ? list.filter((entry) => entry !== target) : [...list, target];
	}

	/** Open the install dialog on a clean slate. */
	function openInstall(): void {
		addOpen = true;
		addHits = [];
		addQuery = '';
		addSlug = '';
		addTargets = [];
	}

	const versionCols: Column[] = [
		{ id: 'kind', label: 'Kind', width: 110 },
		{ id: 'version', label: 'Version', width: 180 },
		{ id: 'mc', label: 'Supports MC (server version requirement)' }
	];
	const assignCols: Column[] = [
		{ id: 'instance', label: 'Instance', width: 180 },
		{ id: 'version', label: 'Runs version', width: 180 },
		{ id: 'why', label: 'Why' }
	];

	let rowMenu: ContextMenu | undefined = $state();
	let menuRow: any = $state();

	const menuItems: ContextMenuItem[] = $derived.by(() => {
		const plugin = menuRow;

		if (!plugin) {
			return [];
		}

		return [
			{
				label: 'Deploy to targets',
				icon: 'upload',
				action: () => deployOne(plugin.name)
			},
			{
				label: plugin.autoUpdate ? 'Disable auto-update' : 'Enable auto-update',
				icon: plugin.autoUpdate ? 'ban' : 'circleCheck',
				action: () => toggleAutoUpdate(plugin)
			},
			{ separator: true },
			{ label: 'Pin a version…', icon: 'tag', disabled: !plugin.modrinth, action: openPin },
			{
				label: 'Unpin all',
				icon: 'unlink',
				disabled: !Object.keys(plugin.pins ?? {}).length,
				action: doUnpin
			},
			{
				label: 'Open on Modrinth',
				icon: 'externalLink',
				disabled: !plugin.modrinth,
				action: () => {
					window.open(`https://modrinth.com/plugin/${plugin.modrinth.slug}`, '_blank', 'noreferrer');
				}
			},
			{ separator: true },
			{
				label: 'Remove plugin',
				icon: 'trash',
				color: 'danger',
				action: () => {
					removeOpen = true;
				}
			}
		];
	});

	async function openRowMenu(row: any, event: MouseEvent): Promise<void> {
		menuRow = row;

		await rowMenu?.openAt(event.clientX, event.clientY);
	}

	const detailCells: InfoCell[] = $derived.by(() => {
		if (!one) {
			return [];
		}

		return [
			{ label: 'Pool file', value: one.file, copyable: true, style: 'mono' },
			{ id: 'source', label: 'Source' },
			{ label: 'Loader', value: one.loader },
			{ label: 'Update channel', value: one.channel },
			{ label: 'Auto-update', value: one.autoUpdate ? 'Enabled' : 'Disabled' },
			{ label: 'Targets', value: one.targets.join(', ') },
			{ label: 'Resolved instances', value: one.expandedTargets.join(', '), colSpan: 2 }
		];
	});
</script>

<svelte:head><title>Plugins | MRDS Console</title></svelte:head>

<PageHeader title="Plugins" count={plugins.length} info>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="plugins" />
		<Btn icon="search" loading={busy === 'scan'} disabled={!!busy} onclick={scan}>Scan</Btn>
		<Btn icon="sync" loading={busy === 'check'} disabled={!!busy} onclick={checkUpdates}>
			Check updates
		</Btn>
		<Btn
			icon="download"
			loading={busy === 'update'}
			disabled={!!busy || (checked && !updates.length)}
			onclick={updateAll}
		>
			Update all
		</Btn>
		<Btn icon="upload" loading={busy === 'deploy'} disabled={!!busy} onclick={deployAll}>
			Deploy
		</Btn>
		<Btn variant="primary" icon="plus" onclick={openInstall}>Install plugin</Btn>
	{/snippet}
</PageHeader>

<Panel flush>
	<DataTable
		tableId="plugins"
		{columns}
		rows={filtered}
		getId={(plugin) => plugin.name}
		selectable="single"
		bind:selected
		sortValue={(plugin, col) => (plugin as any)[col === 'auto' ? 'autoUpdate' : col] ?? ''}
		onRowContextMenu={openRowMenu}
		{filters}
		paging
		pageSize={25}
		emptyTitle="No plugins match the filter"
		emptyText="Adjust the filter above, or install a plugin from Modrinth."
	>
		{#snippet toolbar()}
			<SearchInput bind:value={filter} placeholder="Find plugin by name or source" width="26rem" />
		{/snippet}
		{#snippet cell(plugin, col)}
			{@const update = updatesFor(plugin.name)}
			{#if col === 'name'}
				<b>{plugin.name}</b>
			{:else if col === 'source'}
				<span class="src {plugin.source}">{plugin.source}</span>
			{:else if col === 'loader'}
				{plugin.loader}
			{:else if col === 'version'}
				<span class="mono">{plugin.version ?? '?'}</span>
				{#if plugin.variants.length}
					<span class="variant"> +{plugin.variants.length}v</span>
				{/if}
			{:else if col === 'update'}
				{#if update?.groups?.length}
					<span class="upd">
						<Icon name="arrowUp" size="0.75rem" />
						{update.groups.map((group: any) => group.version).join(', ')}
					</span>
				{:else if checked && plugin.source === 'modrinth'}
					<span class="dim">current</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'auto'}
				<StatusBadge
					state={plugin.autoUpdate ? 'ok' : 'stopped'}
					label={plugin.autoUpdate ? 'On' : 'Off'}
				/>
			{:else if col === 'channel'}
				{plugin.channel}
			{:else if col === 'targets'}
				<span class="dim">{plugin.targets.join(', ')}</span>
			{/if}
		{/snippet}
	</DataTable>
</Panel>

{#if one}
	<DetailPanel
		title={one.name}
		subtitle="({one.source} · {one.loader})"
		bind:location={panelLocation}
		bind:size={panelSize}
		onclose={() => (selected = new Set())}
	>
		{#snippet actions()}
			<StatusBadge
				state={one.autoUpdate ? 'ok' : 'stopped'}
				label={one.autoUpdate ? 'Auto-update on' : 'Auto-update off'}
			/>
		{/snippet}
		<div class="detacts">
			<Btn icon="upload" onclick={() => deployOne(one.name)}>Deploy</Btn>
			<Btn onclick={() => toggleAutoUpdate(one)}>
				Auto-update: {one.autoUpdate ? 'turn off' : 'turn on'}
			</Btn>
			<Dropdown
				label="Actions"
				items={[
					{ label: 'Pin a version…', icon: 'tag', disabled: !one.modrinth, action: openPin },
					{
						label: 'Unpin all',
						icon: 'unlink',
						disabled: !Object.keys(one.pins).length,
						action: doUnpin
					},
					{ divider: true, label: '' },
					{
						label: 'Remove plugin',
						icon: 'trash',
						danger: true,
						action: () => {
							removeOpen = true;
						}
					}
				]}
			/>
		</div>
		<Tabs
			tabs={[
				{ id: 'info', label: 'Details' },
				{ id: 'versions', label: 'Versions & requirements' },
				{ id: 'assign', label: 'Per-instance versions' }
			]}
			bind:active={detailTab}
		/>
		<div class="detailbody">
			{#if detailTab === 'info'}
				<InfoGrid
					cells={detailCells}
					columns={panelLocation === 'right' ? [2, 2, 1] : [4, 3, 2]}
				>
					{#snippet custom(cell)}
						{#if cell.id === 'source'}
							{one.source}{#if one.modrinth}&nbsp;·&nbsp;<a
									href="https://modrinth.com/plugin/{one.modrinth.slug}"
									target="_blank"
									rel="noreferrer"
								>
									<span class="lt">modrinth</span>
									<Icon name="externalLink" size="0.625rem" />
								</a>{/if}
						{/if}
					{/snippet}
				</InfoGrid>
				{#if updatesFor(one.name)?.holdbacks?.length}
					<div class="holdbacks">
						<Flash kind="warning">
							{#each updatesFor(one.name).holdbacks as holdback}
								{holdback.targets.join(', ')}: stays on {holdback.current ?? '?'} —
								{holdback.reason}<br />
							{/each}
						</Flash>
					</div>
				{/if}
			{:else if detailTab === 'versions'}
				<DataTable
					columns={versionCols}
					rows={[
						{
							kind: 'primary',
							version: one.version ?? '?',
							mc: one.gameVersions?.join(', ') ?? 'unknown'
						},
						...one.variants.map((variant: any) => ({
							kind: 'variant',
							version: variant.versionNumber,
							mc: variant.gameVersions?.join(', ') ?? 'unknown'
						}))
					]}
					getId={(row) => row.version}
				>
					{#snippet cell(row, col)}
						{#if col === 'kind'}
							<span
								style="color:{row.kind === 'primary' ? 'var(--success)' : 'var(--warning)'}"
							>
								{row.kind}
							</span>
						{:else if col === 'version'}
							<span class="mono">{row.version}</span>
						{:else}
							<span class="dim">{row.mc}</span>
						{/if}
					{/snippet}
				</DataTable>
			{:else}
				<DataTable
					columns={assignCols}
					rows={one.expandedTargets.map((target: string) => ({
						instance: target,
						version: one.pins[target] ?? one.assign[target] ?? one.version ?? '?',
						why: one.pins[target]
							? 'pinned'
							: one.assign[target]
								? 'auto (older MC)'
								: 'primary'
					}))}
					getId={(row) => row.instance}
				>
					{#snippet cell(row, col)}
						{#if col === 'instance'}
							<a href="/instances/{row.instance}">{row.instance}</a>
						{:else if col === 'version'}
							<span class="mono">{row.version}</span>
						{:else if row.why === 'pinned'}
							<span class="pin"><Icon name="tag" size="0.75rem" /> pinned</span>
						{:else}
							{row.why}
						{/if}
					{/snippet}
				</DataTable>
			{/if}
		</div>
	</DetailPanel>
{/if}

<!-- install modal -->
<Modal title="Install plugin from Modrinth" bind:open={addOpen}>
	<div class="addrow">
		<SearchInput bind:value={addQuery} placeholder="Search Modrinth…" width="100%" />
		<Select
			value={addLoader}
			width="9rem"
			options={[
				{ value: 'paper', label: 'paper' },
				{ value: 'velocity', label: 'velocity' }
			]}
			onchange={(value) => (addLoader = value as 'paper' | 'velocity')}
		/>
		<Btn onclick={searchModrinth}>Search</Btn>
	</div>
	{#each addHits as hit}
		<label class="hit" class:sel={addSlug === hit.slug}>
			<input type="radio" name="hit" value={hit.slug} bind:group={addSlug} class="hidden" />
			<b>{hit.title}</b> <span class="dim">{hit.downloads.toLocaleString()} downloads</span>
			<div class="dim hitdesc">{hit.description}</div>
		</label>
	{/each}
	{#if addSlug}
		<div class="tgt">
			<div class="tgtlbl">Apply to instances</div>
			<div class="targets">
				{#each ['*paper', '*velocity', ...instanceNames] as target}
					<label class="tchk">
						<Checkbox
							checked={addTargets.includes(target)}
							label="Apply to {target}"
							onchange={() => (addTargets = toggleTarget(addTargets, target))}
						/>
						{target}
					</label>
				{/each}
			</div>
		</div>
	{/if}
	{#snippet footer()}
		<Btn onclick={() => (addOpen = false)}>Cancel</Btn>
		<Btn
			variant="primary"
			disabled={!addSlug || !addTargets.length}
			loading={busy === 'add'}
			onclick={installPlugin}
		>
			Install
		</Btn>
	{/snippet}
</Modal>

<!-- pin modal -->
<Modal title="Pin {one?.name} to a version" bind:open={pinOpen}>
	{#if !pinVersions.length}
		<span class="dim">Loading versions…</span>
	{:else}
		<div class="field">
			<span class="lbl">Version</span>
			<Select
				bind:value={pinVersion}
				width="100%"
				options={pinVersions.map((version) => ({
					value: version.versionNumber,
					label: `${version.versionNumber} (${version.channel}) — MC ${version.gameVersions
						.slice(0, MC_LABEL_LIMIT)
						.join(', ')}${version.gameVersions.length > MC_LABEL_LIMIT ? '…' : ''}`
				}))}
			/>
		</div>
		<div class="tgtlbl">On instances</div>
		<div class="targets">
			{#each one?.expandedTargets ?? [] as target}
				<label class="tchk">
					<Checkbox
						checked={pinTargets.includes(target)}
						label="Pin on {target}"
						onchange={() => (pinTargets = toggleTarget(pinTargets, target))}
					/>
					{target}
				</label>
			{/each}
		</div>
	{/if}
	{#snippet footer()}
		<Btn onclick={() => (pinOpen = false)}>Cancel</Btn>
		<Btn
			variant="primary"
			disabled={!pinVersion || !pinTargets.length}
			loading={busy === 'pin'}
			onclick={doPin}
		>
			Pin & deploy
		</Btn>
	{/snippet}
</Modal>

<!-- remove modal -->
<Modal title="Remove {one?.name}" bind:open={removeOpen}>
	<p>
		Removes the jar from all target instances and deletes it from the managed pool. Running
		instances keep it loaded until restart.
	</p>
	{#snippet footer()}
		<Btn onclick={() => (removeOpen = false)}>Cancel</Btn>
		<Btn variant="danger" onclick={doRemove}>Remove everywhere</Btn>
	{/snippet}
</Modal>

<ContextMenu bind:this={rowMenu} items={menuItems} header={menuRow?.name} minWidth="15rem" />

<style lang="scss">
	// source is stored lowercase and capitalised here, tinted per origin
	.src {
		text-transform: capitalize;

		&.modrinth {
			color: var(--success);
		}

		&.luna {
			color: #bf7edb;
		}

		&.manual {
			color: var(--warning);
		}
	}

	.variant {
		color: var(--warning);
		font-size: 0.75rem;
	}

	.upd {
		color: var(--success);
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}

	.pin {
		color: #bf7edb;
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}

	.detacts {
		display: flex;
		gap: 0.5rem;
		padding: 0.625rem 1rem;
		border-bottom: 0.1rem solid var(--border-divider);
		flex-wrap: wrap;
	}

	.detailbody {
		padding: 1rem 1.25rem;
	}

	.holdbacks {
		margin-top: 0.875rem;
	}

	.addrow {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
		align-items: center;
	}

	// the radio input is hidden, so the whole card is the click target
	.hit {
		display: block;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.5rem;
		padding: 0.5rem 0.75rem;
		margin-bottom: 0.375rem;
		cursor: pointer;

		&:hover {
			border-color: var(--link);
		}

		&.sel {
			border-color: var(--link);
			background: var(--bg-selected);
		}
	}

	.hitdesc {
		font-size: 0.75rem;
	}

	.hidden {
		display: none;
	}

	.tgt {
		margin-top: 0.75rem;
	}

	.tgtlbl {
		font-weight: 700;
		color: var(--text-heading);
		margin-bottom: 0.375rem;
	}

	.targets {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem 1rem;
	}

	.tchk {
		display: inline-flex;
		gap: 0.5rem;
		align-items: center;
	}
</style>
