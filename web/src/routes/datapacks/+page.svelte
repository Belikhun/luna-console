<script lang="ts">
	import { t } from '$lib/i18n.svelte';
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
			Notify.error(t('web.datapacks.loadFailed'), { detail: (err as Error).message });
		}

		loading = false;
	}

	onMount(() => {
		void refresh();

		// paper/neoforge instances only; the proxy has no world to deploy into
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
				note.set({ level: 'success', message: t('web.datapacks.done'), closeable: true });
			}
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.datapacks.operationFailed'),
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
				.join('; ') + '; running servers load it on their next restart.'
		);
	}

	const deployAll = (pack?: string) =>
		run('deploy', t('web.datapacks.deploying'), async (note) => {
			const res = await post('/datapacks/deploy', pack ? { pack } : {});

			note.set({
				level: 'success',
				message: pack ? `${pack} deployed` : 'Data packs deployed',
				detail: deploySummary(res.actions),
				closeable: true
			});
		});

	const checkUpdates = (names?: string[]) =>
		run('update', t('web.datapacks.checkingUpdates'), async (note) => {
			const res = await post('/datapacks/update', { names });

			if (!res.updates.length) {
				note.set({ level: 'success', message: t('web.datapacks.everyDataPackIsUp'), closeable: true });

				return;
			}

			note.set({
				level: 'info',
				message: t('web.packs.updatesAvailable', { count: res.updates.length }),
				detail: res.updates
					.map((update: any) => `${update.name}: ${update.from ?? '?'} → ${update.to}`)
					.join('; '),
				closeable: true,
				actions: [
					{
						label: t('web.datapacks.applyUpdates'),
						run: () => void applyUpdates(names)
					}
				]
			});
		});

	async function applyUpdates(names?: string[]): Promise<void> {
		await run('update', t('web.datapacks.downloadingUpdates'), async (note) => {
			const res = await post('/datapacks/update', { names, apply: true });

			note.set({
				level: 'success',
				message: t('web.packs.updatedCount', { count: res.applied.length }),
				detail: t('web.datapacks.worldChangesMany', { count: res.deployed }),
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
		run('add', t('web.catalog.installing', { name: addSlug, provider: addProvider }), async (note) => {
			const res = await post('/datapacks/add', {
				slug: addSlug,
				id: addId || undefined,
				provider: addProvider,
				targets: addTargets
			});

			addOpen = false;

			note.set({
				level: 'success',
				message: t('web.packs.installedPack', { key: res.name, version: res.entry.installed?.versionNumber ?? '' }),
				detail: t('web.datapacks.worldChangesOne', { count: res.deployed }),
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
		run('upload', t('web.catalog.uploading', { name: uploadFile?.name ?? '' }), async (note) => {
			const res = await post('/datapacks', {
				name: uploadName,
				data: await fileToBase64(uploadFile!),
				targets: uploadTargets
			});

			uploadOpen = false;

			note.set({
				level: 'success',
				message: t('web.packs.uploadedPack', { key: res.name }),
				detail: t('web.datapacks.worldChangesOne', { count: res.deployed }),
				closeable: true
			});
		});

	// -- targets dialog --------------------------------------------------------------

	let targetsOpen = $state(false);
	let targetsName = $state('');
	let targetsList: string[] = $state([]);

	/** Instances a group grants the pack being retargeted; shown, never editable. */
	let targetsGranted: string[] = $state([]);

	function openTargets(row: DataPackRow): void {
		targetsName = row.name;
		targetsList = [...row.entry.targets];
		targetsGranted = row.granted;
		targetsOpen = true;
	}

	const saveTargets = () =>
		run('targets', t('web.datapacks.retargeting', { name: targetsName }), async (note) => {
			const res = await patch(`/datapacks/${encodeURIComponent(targetsName)}`, {
				targets: targetsList
			});

			targetsOpen = false;

			note.set({
				level: 'success',
				message: t('web.datapacks.retargeted', { name: targetsName }),
				detail: t('web.datapacks.worldChangesOne', { count: res.deployed }),
				closeable: true
			});
		});

	// -- remove dialog -----------------------------------------------------------------

	let removeOpen = $state(false);
	let removeTarget: DataPackRow | null = $state(null);

	const doRemove = () =>
		run('remove', t('web.catalog.removing', { name: removeTarget?.name ?? '' }), async (note) => {
			const res = await del(`/datapacks/${encodeURIComponent(removeTarget!.name)}`);

			removeOpen = false;

			note.set({
				level: 'success',
				message: t('web.packs.removedOne', { key: removeTarget!.name }),
				detail: res.deletedFrom.length
					? t('web.datapacks.deletedFrom', { names: res.deletedFrom.join(', ') })
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

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.datapacks.pack2'), sortable: true, minWidth: 160 },
		{ id: 'state', label: t('web.datapacks.state') },
		{ id: 'targets', label: t('web.datapacks.deploysTo') },
		{ id: 'groups', label: t('web.datapacks.groups') },
		{ id: 'size', label: t('web.datapacks.size'), sortable: true, width: 100, align: 'right' },
		{ id: 'source', label: t('web.datapacks.source'), sortable: true, minWidth: 140 },
		{ id: 'version', label: t('web.datapacks.version') },
		{ id: 'mc', label: t('web.datapacks.mcVersions'), hidden: true },
		{ id: 'auto', label: t('web.datapacks.autoUpdate'), sortable: true }
	]);

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
				label: t('web.datapacks.deployToTargets'),
				icon: 'upload',
				action: () => deployAll(row.name)
			},
			{
				label: t('web.datapacks.editTargets'),
				icon: 'sliders',
				action: () => openTargets(row)
			},
			{
				label: t('web.datapacks.checkForUpdate'),
				icon: 'download',
				disabled: !row.entry.remote,
				hint: !row.entry.remote ? 'not identified with a provider' : undefined,
				action: () => checkUpdates([row.name])
			},
			{
				label: row.entry.remote ? 'Change provider mapping…' : 'Map to a provider…',
				icon: 'link',
				hint: t('web.datapacks.recordWhichProjectThisZip'),
				action: () => openIdentify(row)
			},
			{
				label: t('web.datapacks.manageAddonGroups'),
				icon: 'layerGroup',
				action: () => goto('/addons/groups')
			},
			{
				label: row.entry.remote ? t('web.catalog.openOn', { provider: row.entry.remote.provider }) : t('web.packs.openOnProvider'),
				icon: 'externalLink',
				disabled: !row.url,
				hint: !row.url ? 'not identified with a provider' : undefined,
				action: () => {
					window.open(row.url!, '_blank', 'noreferrer');
				}
			},
			{ separator: true },
			{
				label: t('web.datapacks.removePack'),
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

<svelte:head><title>{t('web.datapacks.dataPacksLunaConsole')}</title></svelte:head>

<PageHeader
	title={t('web.datapacks.dataPacks')}
	count={packs.length}
	description={t('web.datapacks.aSharedPoolInRoot')}
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="datapacks" />
		<Dropdown label={t('web.datapacks.actions')} disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn icon="download" loading={busy === 'update'} disabled={!!busy} onclick={() => checkUpdates()}>
			{t('web.datapacks.checkUpdates')}
		</Btn>
		<Btn icon="upload" loading={busy === 'deploy'} disabled={!!busy} onclick={() => deployAll()}>
			{t('web.datapacks.deployAll')}
		</Btn>
		<SplitBtn
			label={t('web.datapacks.install')}
			icon="upload"
			primary
			onclick={() => (uploadOpen = true)}
			menu={ADDON_PROVIDERS.map((entry) => ({
				label: t('web.catalog.searchProvider', { provider: entry.label }),
				brand: entry.id, disabled: !entry.available, hint: entry.note,
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
		searchPlaceholder={t('web.datapacks.findADataPack')}
		selectable="single"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.name}
		noun={t('web.datapacks.pack')}
		{sortValue}
		pageSize={25}
		emptyTitle={t('web.datapacks.noDataPacks')}
		emptyText={t('web.datapacks.installOneFromModrinthOr')}
	>
		{#snippet cell(row, col)}
			{#if col === 'name'}
				{row.name}
			{:else if col === 'state'}
				{#if !row.present}
					<StatusBadge
						state="failed"
						label={t('web.datapacks.fileMissing')}
						detail="the pool zip is gone; reinstall or re-upload the pack"
					/>
				{:else if !row.effectiveTargets.length}
					<StatusBadge state="stopped" label={t('web.datapacks.notDeployed')} detail="no targets; edit them to deploy it" />
				{:else}
					<StatusBadge state="ok" label={t('web.datapacks.pooled')} />
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
<Modal title={t('web.datapacks.installADataPack')} bind:open={addOpen} wide>
	<AddonPicker
		endpoint="/datapacks/search"
		kind="datapack"
		bind:selected={addSlug}
		bind:provider={addProvider}
		placeholder={t('web.datapacks.searchDataPacksByName')}
		onpick={(hit) => (addId = hit?.project_id ?? '')}
	/>
	{#if addSlug}
		<div class="tgtlbl">{t('web.datapacks.deployToInstances')}</div>
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
			{t('web.datapacks.theInstallIsGated')}
		</p>
	{/if}
	{#snippet footer()}
		<Btn onclick={() => (addOpen = false)}>{t('web.datapacks.cancel')}</Btn>
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
<Modal title={t('web.datapacks.uploadDataPack')} bind:open={uploadOpen}>
	<FileDrop bind:file={uploadFile} accept=".zip" hint={t('web.datapacks.dropADataPackZip')} />
	<label class="field uploadname">
		<span class="lbl">{t('web.datapacks.packName')}</span>
		<span class="hint">{t('web.datapacks.uploadingUnderAnExisting')}</span>
		<input class="input" bind:value={uploadName} placeholder={t('web.datapacks.myPack')} />
	</label>
	<div class="tgtlbl">{t('web.datapacks.deployToInstances')}</div>
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
		<Btn onclick={() => (uploadOpen = false)}>{t('web.datapacks.cancel')}</Btn>
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
			Addon groups already deploy this pack to {targetsGranted.join(', ')}; those worlds keep it
			{t('web.datapacks.whateverIsTickedHere')}
		</p>
	{/if}
	<p class="dim note">
		{t('web.datapacks.savingDeploysImmediatelyAdded')}
	</p>
	{#snippet footer()}
		<Btn onclick={() => (targetsOpen = false)}>{t('web.datapacks.cancel')}</Btn>
		<Btn variant="primary" loading={busy === 'targets'} onclick={saveTargets}>{t('web.datapacks.saveAndDeploy')}</Btn>
	{/snippet}
</Modal>

<!-- remove -->
<Modal title="Remove {removeTarget?.name}?" bind:open={removeOpen}>
	<p>
		Removes <b>{removeTarget?.name}</b> from every targeted world and drops it from the pool. This
		{t('web.datapacks.cannotBeUndone')}
	</p>
	{#snippet footer()}
		<Btn onclick={() => (removeOpen = false)}>{t('web.datapacks.cancel')}</Btn>
		<Btn variant="danger" loading={busy === 'remove'} onclick={doRemove}>{t('web.datapacks.remove')}</Btn>
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
