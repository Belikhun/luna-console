<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post, patch, del, fileToBase64 } from '$lib/api';
	import { fmtBytes } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import SplitBtn from '$lib/components/SplitBtn.svelte';
	import { ADDON_PROVIDERS } from '$lib/components/addons';
	import Btn from '$lib/components/Btn.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import AddonPicker from '$lib/components/AddonPicker.svelte';
	import BrandLink from '$lib/components/BrandLink.svelte';
	import IdentifyAddonModal from '$lib/components/IdentifyAddonModal.svelte';
	import FileDrop from '$lib/components/FileDrop.svelte';
	import { Notify, type NotificationHandle } from '$lib/notifications.svelte';

	/**
	 * Data packs: a shared pool in <root>/datapacks deployed into each target
	 * instance's world. The lockfile decides what deploys where; the worlds are
	 * derived from it, and a running server loads changes on its next restart
	 * (or /minecraft:reload).
	 */

	interface DataPackRow {
		name: string;
		entry: {
			file: string;
			source: string;
			remote?: { provider: string; projectId: string; slug: string };
			installed?: { versionNumber?: string; gameVersions?: string[] };
			autoUpdate: boolean;
			channel?: string;
			targets: string[];
		};
		url?: string | null;
		present: boolean;
		sizeBytes: number;
		effectiveTargets: string[];
		groups: string[];
		granted: string[];
	}

	let packs: DataPackRow[] = $state([]);
	let instanceNames: string[] = $state([]);
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let busy = $state('');
	let selected: Set<string> = $state(new Set());

	const one = $derived(packs.find((row) => selected.has(row.name)));

	async function refresh(): Promise<void> {
		loading = true;

		try {
			packs = (await api('/datapacks')).packs;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error('Could not load data packs', { detail: (err as Error).message });
		}

		loading = false;
	}

	onMount(() => {
		void refresh();

		// paper/neoforge instances only — the proxy has no world to deploy into
		void api('/instances')
			.then((data) => {
				instanceNames = data.instances
					.filter((row: any) => row.software !== 'velocity')
					.map((row: any) => row.name);
			})
			.catch(() => {});
	});

	/** Run one operation behind a loading flash, then refresh. */
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
				message: 'Operation failed',
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = '';

		await refresh();
	}

	/** Summarize deploy actions for a notification detail line. */
	function deploySummary(actions: any[]): string {
		const changed = actions.filter((action) => action.action !== 'unchanged');

		if (!changed.length) {
			return 'Every world already in sync.';
		}

		return (
			changed
				.map((action) => `${action.instance}: ${action.file} ${action.action}`)
				.join('; ') + ' — running servers load it on their next restart.'
		);
	}

	const deployAll = (pack?: string) =>
		run('deploy', 'Deploying data packs…', async (note) => {
			const res = await post('/datapacks/deploy', pack ? { pack } : {});

			note.set({
				level: 'success',
				message: pack ? `${pack} deployed` : 'Data packs deployed',
				detail: deploySummary(res.actions),
				closeable: true
			});
		});

	const checkUpdates = (names?: string[]) =>
		run('update', 'Checking Modrinth for data pack updates…', async (note) => {
			const res = await post('/datapacks/update', { names });

			if (!res.updates.length) {
				note.set({ level: 'success', message: 'Every data pack is up to date', closeable: true });

				return;
			}

			note.set({
				level: 'info',
				message: `${res.updates.length} update(s) available`,
				detail: res.updates
					.map((update: any) => `${update.name}: ${update.from ?? '?'} → ${update.to}`)
					.join('; '),
				closeable: true,
				actions: [
					{
						label: 'Apply updates',
						run: () => void applyUpdates(names)
					}
				]
			});
		});

	async function applyUpdates(names?: string[]): Promise<void> {
		await run('update', 'Downloading data pack updates…', async (note) => {
			const res = await post('/datapacks/update', { names, apply: true });

			note.set({
				level: 'success',
				message: `Updated ${res.applied.length} pack(s)`,
				detail: `${res.deployed} world change(s) — running servers load them on their next restart.`,
				closeable: true
			});
		});
	}

	/** Add or remove one target from a checkbox list. */
	function toggleTarget(list: string[], target: string): string[] {
		return list.includes(target) ? list.filter((entry) => entry !== target) : [...list, target];
	}

	// -- install dialog ---------------------------------------------------------

	let addOpen = $state(false);
	let addSlug = $state('');
	let addId = $state('');
	let addTargets: string[] = $state([]);
	let addProvider = $state('modrinth');

	/** Open the provider search on one provider, on a clean slate. */
	function openSearch(provider: string): void {
		addProvider = provider;
		addSlug = '';
		addId = '';
		addTargets = [];
		addOpen = true;
	}

	const installPack = () =>
		run('add', `Installing ${addSlug} from ${addProvider}…`, async (note) => {
			const res = await post('/datapacks/add', {
				slug: addSlug,
				id: addId || undefined,
				provider: addProvider,
				targets: addTargets
			});

			addOpen = false;

			note.set({
				level: 'success',
				message: `Installed ${res.name} ${res.entry.installed?.versionNumber ?? ''}`,
				detail: `${res.deployed} world change(s) — running servers load it on their next restart.`,
				closeable: true
			});
		});

	// -- upload dialog ------------------------------------------------------------

	let uploadOpen = $state(false);
	let uploadFile: File | null = $state(null);
	let uploadName = $state('');
	let uploadTargets: string[] = $state([]);

	$effect(() => {
		if (uploadOpen) {
			uploadFile = null;
			uploadName = '';
			uploadTargets = [];
		}
	});

	// prefill the pack name from the picked file, but never overwrite an edit
	$effect(() => {
		if (uploadFile && !uploadName) {
			uploadName = uploadFile.name.replace(/\.zip$/i, '');
		}
	});

	const uploadPack = () =>
		run('upload', `Uploading ${uploadFile?.name}…`, async (note) => {
			const res = await post('/datapacks', {
				name: uploadName,
				data: await fileToBase64(uploadFile!),
				targets: uploadTargets
			});

			uploadOpen = false;

			note.set({
				level: 'success',
				message: `Uploaded ${res.name}`,
				detail: `${res.deployed} world change(s) — running servers load it on their next restart.`,
				closeable: true
			});
		});

	// -- targets dialog --------------------------------------------------------------

	let targetsOpen = $state(false);
	let targetsName = $state('');
	let targetsList: string[] = $state([]);

	/** Instances a group grants the pack being retargeted — shown, never editable. */
	let targetsGranted: string[] = $state([]);

	function openTargets(row: DataPackRow): void {
		targetsName = row.name;
		targetsList = [...row.entry.targets];
		targetsGranted = row.granted;
		targetsOpen = true;
	}

	const saveTargets = () =>
		run('targets', `Retargeting ${targetsName}…`, async (note) => {
			const res = await patch(`/datapacks/${encodeURIComponent(targetsName)}`, {
				targets: targetsList
			});

			targetsOpen = false;

			note.set({
				level: 'success',
				message: `${targetsName} retargeted`,
				detail: `${res.deployed} world change(s) — running servers load it on their next restart.`,
				closeable: true
			});
		});

	// -- remove dialog -----------------------------------------------------------------

	let removeOpen = $state(false);
	let removeTarget: DataPackRow | null = $state(null);

	const doRemove = () =>
		run('remove', `Removing ${removeTarget?.name}…`, async (note) => {
			const res = await del(`/datapacks/${encodeURIComponent(removeTarget!.name)}`);

			removeOpen = false;

			note.set({
				level: 'success',
				message: `Removed ${removeTarget!.name}`,
				detail: res.deletedFrom.length
					? `Deleted from ${res.deletedFrom.join(', ')} — running servers unload it on their next restart.`
					: 'No worlds held it.',
				closeable: true
			});

			removeTarget = null;
		});

	// -- provider mapping --------------------------------------------------------------

	let identifyOpen = $state(false);
	let identifyName = $state('');
	let identifyMapped = $state(false);

	/** Open the mapping dialog for one pooled pack. */
	function openIdentify(row: DataPackRow): void {
		identifyName = row.name;
		identifyMapped = !!row.entry.remote;
		identifyOpen = true;
	}

	// -- table ---------------------------------------------------------------------------

	const columns: Column[] = [
		{ id: 'name', label: 'Pack', sortable: true, minWidth: 160 },
		{ id: 'state', label: 'State' },
		{ id: 'targets', label: 'Deploys to' },
		{ id: 'groups', label: 'Groups' },
		{ id: 'size', label: 'Size', sortable: true, width: 100, align: 'right' },
		{ id: 'source', label: 'Source', sortable: true, minWidth: 140 },
		{ id: 'version', label: 'Version' },
		{ id: 'mc', label: 'MC versions', hidden: true },
		{ id: 'auto', label: 'Auto-update', sortable: true }
	];

	function sortValue(row: DataPackRow, col: string): string | number | null {
		switch (col) {
			case 'name':
				return row.name;

			case 'size':
				return row.sizeBytes;

			case 'source':
				return row.entry.source;

			case 'auto':
				return row.entry.autoUpdate ? 0 : 1;

			default:
				return null;
		}
	}

	function rowActions(row: DataPackRow): ContextMenuItem[] {
		return [
			{
				label: 'Deploy to targets',
				icon: 'upload',
				action: () => deployAll(row.name)
			},
			{
				label: 'Edit targets',
				icon: 'sliders',
				action: () => openTargets(row)
			},
			{
				label: 'Check for update',
				icon: 'download',
				disabled: !row.entry.remote,
				hint: !row.entry.remote ? 'not identified with a provider' : undefined,
				action: () => checkUpdates([row.name])
			},
			{
				label: row.entry.remote ? 'Change provider mapping…' : 'Map to a provider…',
				icon: 'link',
				hint: 'record which project this zip came from',
				action: () => openIdentify(row)
			},
			{
				label: 'Manage addon groups',
				icon: 'layerGroup',
				action: () => goto('/addons/groups')
			},
			{
				label: row.entry.remote ? `Open on ${row.entry.remote.provider}` : 'Open on provider',
				icon: 'externalLink',
				disabled: !row.url,
				hint: !row.url ? 'not identified with a provider' : undefined,
				action: () => {
					window.open(row.url!, '_blank', 'noreferrer');
				}
			},
			{ separator: true },
			{
				label: 'Remove pack',
				icon: 'trash',
				color: 'danger',
				action: () => {
					removeTarget = row;
					removeOpen = true;
				}
			}
		];
	}
</script>

<svelte:head><title>Data packs | Luna Console</title></svelte:head>

<PageHeader
	title="Data packs"
	count={packs.length}
	description="A shared pool in <root>/datapacks deployed into each target instance's world — servers load changes on their next restart or /minecraft:reload"
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="datapacks" />
		<Dropdown label="Actions" disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn icon="download" loading={busy === 'update'} disabled={!!busy} onclick={() => checkUpdates()}>
			Check updates
		</Btn>
		<Btn icon="upload" loading={busy === 'deploy'} disabled={!!busy} onclick={() => deployAll()}>
			Deploy all
		</Btn>
		<SplitBtn
			label="Install"
			icon="upload"
			primary
			onclick={() => (uploadOpen = true)}
			menu={ADDON_PROVIDERS.map((entry) => ({
				label: `Search ${entry.label}`,
				brand: entry.id,
				disabled: !entry.available,
				hint: entry.note,
				action: () => openSearch(entry.id)
			}))}
		/>
	{/snippet}
</PageHeader>

<Panel flush>
	<ResourceTable
		tableId="datapacks"
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		rows={packs}
		getId={(row) => row.name}
		searchValue={(row) =>
			`${row.name} ${row.entry.source} ${row.effectiveTargets.join(' ')} ` +
			`${row.groups.join(' ')} ${row.entry.installed?.versionNumber ?? ''}`}
		searchPlaceholder="Find a data pack"
		selectable="single"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.name}
		noun="pack"
		{sortValue}
		pageSize={25}
		emptyTitle="No data packs"
		emptyText="Install one from Modrinth or upload a zip to get started."
	>
		{#snippet cell(row, col)}
			{#if col === 'name'}
				{row.name}
			{:else if col === 'state'}
				{#if !row.present}
					<StatusBadge
						state="failed"
						label="File missing"
						detail="the pool zip is gone — reinstall or re-upload the pack"
					/>
				{:else if !row.effectiveTargets.length}
					<StatusBadge state="stopped" label="Not deployed" detail="no targets — edit them to deploy it" />
				{:else}
					<StatusBadge state="ok" label="Pooled" />
				{/if}
			{:else if col === 'targets'}
				<span class="dim">{row.effectiveTargets.join(', ') || '–'}</span>
			{:else if col === 'groups'}
				{#if row.groups.length}
					{#each row.groups as group, index}
						{#if index > 0}<span class="dim">, </span>{/if}
						<a href="/addons/groups/{group}">{group}</a>
					{/each}
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'size'}
				{row.present ? fmtBytes(row.sizeBytes) : '–'}
			{:else if col === 'source'}
				<BrandLink source={row.entry.source} short />
			{:else if col === 'version'}
				<span class="mono">{row.entry.installed?.versionNumber ?? '–'}</span>
			{:else if col === 'mc'}
				<span class="dim">{row.entry.installed?.gameVersions?.join(', ') ?? '–'}</span>
			{:else if col === 'auto'}
				<StatusBadge
					state={row.entry.autoUpdate ? 'ok' : 'stopped'}
					label={row.entry.autoUpdate ? 'On' : 'Off'}
				/>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<!-- map a pooled zip to the project it came from -->
<IdentifyAddonModal
	bind:open={identifyOpen}
	kind="datapack"
	target={identifyName}
	mapped={identifyMapped}
	onchanged={refresh}
/>

<!-- install from a provider -->
<Modal title="Install a data pack" bind:open={addOpen} wide>
	<AddonPicker
		endpoint="/datapacks/search"
		kind="datapack"
		bind:selected={addSlug}
		bind:provider={addProvider}
		placeholder="Search data packs by name…"
		onpick={(hit) => (addId = hit?.project_id ?? '')}
	/>
	{#if addSlug}
		<div class="tgtlbl">Deploy to instances</div>
		<div class="targets">
			{#each instanceNames as target}
				<label class="tchk">
					<Checkbox
						checked={addTargets.includes(target)}
						label="Deploy to {target}"
						onchange={() => (addTargets = toggleTarget(addTargets, target))}
					/>
					{target}
				</label>
			{/each}
		</div>
		<p class="dim note">
			The install is gated on every target's Minecraft version — a pack that covers none of them
			is refused with the newest version it does support. Leave the targets empty to pool the pack
			for an addon group to place.
		</p>
	{/if}
	{#snippet footer()}
		<Btn onclick={() => (addOpen = false)}>Cancel</Btn>
		<Btn
			variant="primary"
			disabled={!addSlug}
			loading={busy === 'add'}
			onclick={installPack}
		>
			Install
		</Btn>
	{/snippet}
</Modal>

<!-- upload from this computer -->
<Modal title="Upload data pack" bind:open={uploadOpen}>
	<FileDrop bind:file={uploadFile} accept=".zip" hint="Drop a data pack zip here, or click to browse" />
	<label class="field uploadname">
		<span class="lbl">Pack name</span>
		<span class="hint">Uploading under an existing pack's name replaces its file</span>
		<input class="input" bind:value={uploadName} placeholder="my-pack" />
	</label>
	<div class="tgtlbl">Deploy to instances</div>
	<div class="targets">
		{#each instanceNames as target}
			<label class="tchk">
				<Checkbox
					checked={uploadTargets.includes(target)}
					label="Deploy to {target}"
					onchange={() => (uploadTargets = toggleTarget(uploadTargets, target))}
				/>
				{target}
			</label>
		{/each}
	</div>
	{#snippet footer()}
		<Btn onclick={() => (uploadOpen = false)}>Cancel</Btn>
		<Btn
			variant="primary"
			disabled={!uploadFile || !uploadName.trim()}
			loading={busy === 'upload'}
			onclick={uploadPack}
		>
			Upload
		</Btn>
	{/snippet}
</Modal>

<!-- edit targets -->
<Modal title="Deploy {targetsName} to…" bind:open={targetsOpen}>
	<div class="targets">
		{#each instanceNames as target}
			<label class="tchk">
				<Checkbox
					checked={targetsList.includes(target)}
					label="Deploy to {target}"
					onchange={() => (targetsList = toggleTarget(targetsList, target))}
				/>
				{target}
			</label>
		{/each}
	</div>
	{#if targetsGranted.length}
		<p class="dim note">
			Addon groups already deploy this pack to {targetsGranted.join(', ')} — those worlds keep it
			whatever is ticked here.
		</p>
	{/if}
	<p class="dim note">
		Saving deploys immediately: added worlds get the pack, removed worlds lose it.
	</p>
	{#snippet footer()}
		<Btn onclick={() => (targetsOpen = false)}>Cancel</Btn>
		<Btn variant="primary" loading={busy === 'targets'} onclick={saveTargets}>Save and deploy</Btn>
	{/snippet}
</Modal>

<!-- remove -->
<Modal title="Remove {removeTarget?.name}?" bind:open={removeOpen}>
	<p>
		Removes <b>{removeTarget?.name}</b> from every targeted world and drops it from the pool. This
		cannot be undone.
	</p>
	{#snippet footer()}
		<Btn onclick={() => (removeOpen = false)}>Cancel</Btn>
		<Btn variant="danger" loading={busy === 'remove'} onclick={doRemove}>Remove</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-bottom: 0.875rem;
	}

	.lbl {
		font-weight: 700;
		color: var(--text-heading);
	}

	.hint {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.uploadname {
		margin-top: 1rem;
	}

	.tgtlbl {
		font-weight: 700;
		color: var(--text-heading);
		margin: 0.75rem 0 0.5rem;
	}

	.targets {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
		gap: 0.5rem;
	}

	.tchk {
		display: flex;
		gap: 0.5rem;
		align-items: center;
	}

	.note {
		margin-top: 1rem;
		font-size: 0.875rem;
	}
</style>
