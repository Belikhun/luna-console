<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post, patch, del } from '$lib/api';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import SearchInput from '$lib/components/SearchInput.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import Modal from '$lib/components/Modal.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Select from '$lib/components/Select.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import { Notify, type NotificationHandle } from '$lib/notifications.svelte';
	import type { ContextMenuItem } from '$lib/components/contextmenu';

	/**
	 * The plugin universe, one row per *identity* — a plugin's paper, velocity
	 * and neoforge builds are one thing here; the info view unpacks them.
	 */

	interface FamilyRow {
		key: string;
		family: string;
		source: string;
		autoUpdate: boolean;
		channel: string;
		version: string | null;
		modrinth: { slug: string } | null;
		effective: string[];
	}

	interface PluginRow {
		plugin: string;
		displayName: string;
		description: string | null;
		families: FamilyRow[];
		sources: string[];
		effective: string[];
		autoUpdate: boolean;
		pinned: boolean;
		variantCount: number;
	}

	let plugins: PluginRow[] = $state([]);
	let busy = $state('');
	let updates: any[] = $state([]);
	let checked = $state(false);

	let addOpen = $state(false);
	let addQuery = $state('');
	let addLoader = $state<'paper' | 'velocity'>('paper');
	let addHits: any[] = $state([]);
	let addSlug = $state('');
	let addTargets: string[] = $state([]);
	let removeTarget: PluginRow | null = $state(null);
	let removeOpen = $state(false);

	const instanceNames = $derived(
		[...new Set(plugins.flatMap((row) => row.effective))].sort()
	);

	/** Update candidates whose entry key belongs to this plugin's families. */
	const updatesFor = (row: PluginRow) =>
		updates.filter((candidate) =>
			row.families.some((family) => family.key === candidate.name)
		);

	const filters: TableFilterGroup<PluginRow>[] = [
		{
			id: 'source',
			label: 'Filter source',
			options: [
				{ value: 'any', label: 'Any source' },
				{
					value: 'modrinth',
					label: 'Modrinth managed',
					match: (row) => row.sources.includes('modrinth')
				},
				{ value: 'luna', label: 'Luna in-house', match: (row) => row.sources.includes('luna') },
				{
					value: 'manual',
					label: 'Manually installed',
					match: (row) => row.sources.includes('manual')
				}
			]
		},
		{
			id: 'family',
			label: 'Filter family',
			options: [
				{ value: 'any', label: 'Any family' },
				{
					value: 'paper',
					label: 'Has a paper build',
					match: (row) => row.families.some((family) => family.family === 'paper')
				},
				{
					value: 'velocity',
					label: 'Has a velocity build',
					match: (row) => row.families.some((family) => family.family === 'velocity')
				},
				{
					value: 'universal',
					label: 'Universal jar',
					match: (row) => row.families.some((family) => family.family === 'universal')
				}
			]
		},
		{
			id: 'updates',
			label: 'Filter update policy',
			options: [
				{ value: 'any', label: 'Any policy' },
				{ value: 'auto-off', label: 'Auto-update disabled', match: (row) => !row.autoUpdate },
				{ value: 'pinned', label: 'Has pinned versions', match: (row) => row.pinned }
			]
		}
	];

	const columns: Column[] = [
		{ id: 'name', label: 'Name', sortable: true },
		{ id: 'source', label: 'Source', sortable: true },
		{ id: 'families', label: 'Families', width: 170 },
		{ id: 'version', label: 'Version' },
		{ id: 'update', label: 'Update' },
		{ id: 'auto', label: 'Auto-update', sortable: true },
		{ id: 'targets', label: 'Deploys to' }
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
		// old deep links selected a row in a side panel; the info view replaced it
		const preselect = page.url.searchParams.get('sel');

		if (preselect) {
			await goto(`/plugins/${preselect}`, { replaceState: true });

			return;
		}

		await refresh();
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

	/** Deploy every family build of one plugin, behind a loading flash. */
	function deployOne(row: PluginRow): Promise<void> {
		return run('deploy1', `Deploying ${row.plugin}…`, async (note) => {
			let changed = 0;

			for (const family of row.families) {
				const res = await post('/plugins/deploy', { plugin: family.key });

				changed += res.actions.filter((action: any) => action.action !== 'unchanged').length;
			}

			note.set({
				level: 'success',
				message: `Deployed ${row.plugin} — ${changed} change(s)`,
				closeable: true
			});
		});
	}

	/** Flip auto-update on every family build of one plugin. */
	function toggleAutoUpdate(row: PluginRow): Promise<void> {
		const next = !row.autoUpdate;

		return run('auto', `${next ? 'Enabling' : 'Disabling'} auto-update for ${row.plugin}…`, async (note) => {
			for (const family of row.families) {
				await patch(`/plugins/${encodeURIComponent(family.key)}`, { autoUpdate: next });
			}

			note.set({
				level: 'success',
				message: `Auto-update ${next ? 'enabled' : 'disabled'} for ${row.plugin}`,
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
					? `${updates.length} build(s) have updates or holdbacks`
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

	const doRemove = () =>
		run('remove', `Removing ${removeTarget?.plugin}…`, async (note) => {
			for (const family of removeTarget!.families) {
				await del(`/plugins/${encodeURIComponent(family.key)}`);
			}

			note.set({
				level: 'success',
				message: `Removed ${removeTarget!.plugin} (${removeTarget!.families.length} build(s))`,
				closeable: true
			});

			removeOpen = false;
			removeTarget = null;

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

	/** A plugin's verbs — the row menu and the toolbar's Actions button. */
	function rowActions(row: PluginRow): ContextMenuItem[] {
		const modrinth = row.families.find((family) => family.modrinth);

		return [
			{
				label: 'Plugin details',
				icon: 'circleInfo',
				action: () => goto(`/plugins/${row.plugin}`)
			},
			{
				label: 'Deploy to targets',
				icon: 'upload',
				action: () => deployOne(row)
			},
			{
				label: row.autoUpdate ? 'Disable auto-update' : 'Enable auto-update',
				icon: row.autoUpdate ? 'ban' : 'circleCheck',
				action: () => toggleAutoUpdate(row)
			},
			{
				label: 'Open on Modrinth',
				icon: 'externalLink',
				disabled: !modrinth,
				action: () => {
					window.open(
						`https://modrinth.com/plugin/${modrinth!.modrinth!.slug}`,
						'_blank',
						'noreferrer'
					);
				}
			},
			{ separator: true },
			{
				label: 'Remove plugin',
				icon: 'trash',
				color: 'danger',
				action: () => {
					removeTarget = row;
					removeOpen = true;
				}
			}
		];
	}

	let selected: Set<string> = $state(new Set());

	/** The row the header's Actions dropdown acts on. */
	const one = $derived(plugins.find((row: any) => selected.has(row.plugin)));
</script>

<svelte:head><title>Plugins | MRDS Console</title></svelte:head>

<PageHeader title="Plugins" count={plugins.length} info>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="plugins" />
		<Dropdown label="Actions" disabled={!one} menu={one ? rowActions(one) : []} />
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
	<ResourceTable
		tableId="plugins-grouped"
		{columns}
		rows={plugins}
		getId={(row) => row.plugin}
		searchValue={(row) =>
			`${row.plugin} ${row.displayName} ${row.sources.join(' ')} ${row.families
				.map((family) => `${family.family} ${family.version ?? ''}`)
				.join(' ')} ${row.effective.join(' ')} ${row.description ?? ''}`}
		searchPlaceholder="Find plugin by name, source or target"
		selectable="single"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.plugin}
		noun="plugin"
		sortValue={(row, col) =>
			col === 'name'
				? row.plugin
				: col === 'source'
					? row.sources.join(',')
					: col === 'auto'
						? String(row.autoUpdate)
						: ''}
		onRowClick={(row) => goto(`/plugins/${row.plugin}`)}
		{filters}
		pageSize={25}
		emptyTitle="No plugins in the pool"
		emptyText="Install one from Modrinth, or run a scan to adopt the jars already on disk."
	>
		{#snippet cell(row, col)}
			{@const pending = updatesFor(row)}
			{#if col === 'name'}
				<a href="/plugins/{row.plugin}" onclick={(event) => event.stopPropagation()}>
					<b>{row.plugin}</b>
				</a>
				{#if row.displayName && row.displayName !== row.plugin}
					<span class="dim">({row.displayName})</span>
				{/if}
			{:else if col === 'source'}
				{#each row.sources as source, index}
					{#if index > 0}<span class="dim">, </span>{/if}
					<span class="src {source}">{source}</span>
				{/each}
			{:else if col === 'families'}
				<span class="fams">
					{#each row.families as family (family.key)}
						<span class="fam">{family.family}</span>
					{/each}
				</span>
			{:else if col === 'version'}
				{@const versions = [...new Set(row.families.map((family) => family.version ?? '?'))]}
				<span class="mono">{versions.join(' / ')}</span>
				{#if row.variantCount}
					<span class="variant"> +{row.variantCount}v</span>
				{/if}
			{:else if col === 'update'}
				{#if pending.some((candidate) => candidate.groups?.length)}
					<span class="upd">
						<Icon name="arrowUp" size="0.75rem" />
						{[
							...new Set(
								pending.flatMap((candidate) =>
									candidate.groups.map((group: any) => group.version)
								)
							)
						].join(', ')}
					</span>
				{:else if checked && row.sources.includes('modrinth')}
					<span class="dim">current</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'auto'}
				<StatusBadge
					state={row.autoUpdate ? 'ok' : 'stopped'}
					label={row.autoUpdate ? 'On' : 'Off'}
				/>
			{:else if col === 'targets'}
				<span class="dim">{row.effective.join(', ') || '–'}</span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

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

<!-- remove modal -->
<Modal title="Remove {removeTarget?.plugin}" bind:open={removeOpen}>
	<p>
		Removes every family build ({removeTarget?.families
			.map((family) => family.family)
			.join(', ')}) from all target instances and deletes them from the managed pool. Running
		instances keep them loaded until restart.
	</p>
	{#snippet footer()}
		<Btn onclick={() => (removeOpen = false)}>Cancel</Btn>
		<Btn variant="danger" loading={busy === 'remove'} onclick={doRemove}>Remove everywhere</Btn>
	{/snippet}
</Modal>


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

	.fams {
		display: inline-flex;
		gap: 0.375rem;
	}

	.fam {
		padding: 0.125rem 0.5rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.625rem;
		font-size: 0.75rem;
		color: var(--text-secondary);
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
