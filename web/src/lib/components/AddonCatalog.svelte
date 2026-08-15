<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { FAMILY_DIRS } from '$core/software';
	import type { PluginFamily } from '$core/types';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post, patch, del, fileToBase64 } from '$lib/api';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import SplitBtn from '$lib/components/SplitBtn.svelte';
	import FileDrop from '$lib/components/FileDrop.svelte';
	import BrandLink from '$lib/components/BrandLink.svelte';
	import IdentifyAddonModal from '$lib/components/IdentifyAddonModal.svelte';
	import {
		ADDON_PROVIDERS,
		providerAvailability,
		type AddonProvider
	} from '$lib/components/addons';
	import Panel from '$lib/components/Panel.svelte';
	import AddonPicker from '$lib/components/AddonPicker.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import Modal from '$lib/components/Modal.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Select from '$lib/components/Select.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import { Notify, type NotificationHandle } from '$lib/notifications.svelte';
	import { jobFlash } from '$lib/jobflash';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import type {
		AddonFamily,
		AddonKind,
		AddonRow,
		AddonUpdate
	} from '$lib/components/addoncatalog';
	import { CATALOG_KINDS } from '$lib/components/addoncatalog';

	/**
	 * The addon universe of one kind, one row per *identity*; an addon's paper,
	 * velocity and neoforge builds are one thing here; the info view unpacks them.
	 *
	 * Plugins and mods are the same object in the lockfile, told apart only by
	 * which directory their family deploys into, so they are one screen rendered
	 * twice rather than two screens that would drift apart.
	 */

	let { kind }: { kind: AddonKind } = $props();

	const spec = $derived(CATALOG_KINDS[kind]);

	let addons: AddonRow[] = $state([]);
	let busy = $state('');
	let updates: AddonUpdate[] = $state([]);
	let checked = $state(false);

	// the check's summary dialog, and the rows the user ticked in it
	let updatesOpen = $state(false);
	let updateSel: Set<string> = $state(new Set());

	let addOpen = $state(false);
	let addFamily = $state<AddonFamily>('paper');
	let addSlug = $state('');
	let addId = $state('');
	let addTargets: string[] = $state([]);
	let addProvider = $state('modrinth');

	// the Install split-button's provider menu, with live availability
	let installProviders: AddonProvider[] = $state(
		ADDON_PROVIDERS.filter((entry) => entry.types.includes(spec.type))
	);

	$effect(() => {
		providerAvailability().then((list) => {
			installProviders = list.filter((entry) => entry.types.includes(spec.type));
		});
	});

	let uploadOpen = $state(false);
	let uploadFile: File | null = $state(null);
	let uploadName = $state('');
	let uploadFamily = $state<AddonFamily>('paper');
	let uploadTargets: string[] = $state([]);
	let removeTarget: AddonRow | null = $state(null);
	let removeOpen = $state(false);

	const instanceNames = $derived([...new Set(addons.flatMap((row) => row.effective))].sort());
	const targetChoices = $derived([...spec.wildcards, ...instanceNames]);

	/** Update candidates whose entry key belongs to this addon's families. */
	const updatesFor = (row: AddonRow) =>
		updates.filter((candidate) => row.families.some((family) => family.key === candidate.name));

	// a check sweeps the whole lockfile; plugins and mods alike; so the summary
	// keeps to the builds this screen is actually showing
	const catalogKeys = $derived(
		new Set(addons.flatMap((row) => row.families.map((family) => family.key)))
	);

	/** Checked builds with a jar waiting to be downloaded. */
	const pendingUpdates = $derived(
		updates.filter((candidate) => candidate.groups.length && catalogKeys.has(candidate.name))
	);

	/** Checked builds the resolution had something to say about but nothing to fetch. */
	const heldBack = $derived(
		updates.filter((candidate) => !candidate.groups.length && catalogKeys.has(candidate.name))
	);

	const filters: TableFilterGroup<AddonRow>[] = $derived([
		{
			id: 'source',
			label: t('web.catalog.filterSource'),
			options: [
				{ value: 'any', label: t('web.catalog.anySource') },
				...spec.sources.map((source) => ({
					value: source,
					label: t('web.catalog.providerManaged', { provider: ADDON_PROVIDERS.find((entry) => entry.id === source)?.label ?? source }),
					match: (row: AddonRow) => row.sources.includes(source)
				})),
				{ value: 'luna', label: t('web.catalog.lunaInHouse'), match: (row) => row.sources.includes('luna') },
				{
					value: 'manual',
					label: t('web.catalog.manuallyInstalled'),
					match: (row) => row.sources.includes('manual')
				}
			]
		},
		// a mod has exactly one family, so the family filter would sort nothing
		...(spec.families.length > 1
			? [
					{
						id: 'family',
						label: t('web.catalog.filterFamily'),
						options: [
							{ value: 'any', label: t('web.catalog.anyFamily') },
							...spec.families.map((family) => ({
								value: family,
								label: t('web.catalog.hasBuild', { family }),
								match: (row: AddonRow) =>
									row.families.some((build) => build.family === family)
							}))
						]
					}
				]
			: []),
		{
			id: 'updates',
			label: t('web.catalog.filterPolicy'),
			options: [
				{ value: 'any', label: t('web.catalog.anyPolicy') },
				{ value: 'auto-off', label: t('web.catalog.autoOff'), match: (row) => !row.autoUpdate },
				{ value: 'pinned', label: t('web.catalog.hasPinned'), match: (row) => row.pinned }
			]
		}
	]);

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.common.name'), sortable: true },
		{ id: 'source', label: t('web.catalog.colSource'), sortable: true, minWidth: 140 },
		...(spec.families.length > 1
			? [{ id: 'families', label: t('web.catalog.colFamilies'), width: 170 }]
			: []),
		{ id: 'version', label: t('web.groups.colVersion') },
		{ id: 'update', label: t('web.catalog.colUpdate') },
		{ id: 'auto', label: t('web.catalog.colAuto'), sortable: true },
		{ id: 'targets', label: t('web.catalog.colTargets') }
	]);

	// The summary dialog's own table. No tableId on purpose: it would grow a
	// preferences gear opening a second modal on top of this one.
	const updateColumns: Column[] = $derived([
		{ id: 'addon', label: t('web.common.name'), sortable: true },
		{ id: 'version', label: t('web.catalog.colUpdate'), sortable: true, minWidth: 190 },
		{ id: 'targets', label: t('web.catalog.colLandsOn') }
	]);

	let loading = $state(true);
	let lastUpdated: number | null = $state(null);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			addons = (await api(`/plugins?kind=${kind}`)).plugins;
			lastUpdated = Date.now();
		} finally {
			loading = false;
		}
	}

	onMount(async () => {
		addFamily = spec.families[0]!;
		uploadFamily = spec.families[0]!;

		// old deep links selected a row in a side panel; the info view replaced it
		const preselect = page.url.searchParams.get('sel');

		if (preselect) {
			await goto(`/plugins/${preselect}`, { replaceState: true });

			return;
		}

		await refresh();
	});

	/**
	 * Run an addon operation behind a loading flash. The operation settles the
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
				note.set({ level: 'success', message: t('web.common.done'), closeable: true });
			}
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.catalog.opFailed', { operation: pending.replace(/…$/, '') }),
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = '';
	}

	/** Deploy every family build of one addon, behind a loading flash. */
	function deployOne(row: AddonRow): Promise<void> {
		return run('deploy1', t('web.catalog.deploying', { name: row.plugin }), async (note) => {
			let changed = 0;

			for (const family of row.families) {
				const res = await post('/plugins/deploy', { plugin: family.key });

				changed += res.actions.filter((action: any) => action.action !== 'unchanged').length;
			}

			note.set({
				level: 'success',
				message: t('web.catalog.deployed', { name: row.plugin, count: changed }),
				closeable: true
			});
		});
	}

	/** Flip auto-update on every family build of one addon. */
	function toggleAutoUpdate(row: AddonRow): Promise<void> {
		const next = !row.autoUpdate;

		return run(
			'auto',
			t(next ? 'web.catalog.enablingAuto' : 'web.catalog.disablingAuto', { name: row.plugin }),
			async (note) => {
				for (const family of row.families) {
					await patch(`/plugins/${encodeURIComponent(family.key)}`, { autoUpdate: next });
				}

				note.set({
					level: 'success',
					message: t(next ? 'web.catalog.autoEnabled' : 'web.catalog.autoDisabled', { name: row.plugin }),
					closeable: true
				});

				await refresh();
			}
		);
	}

	/**
	 * Ask every provider what it has, one entry at a time; a job, so the card
	 * reports which addon it is waiting on. The outcome opens the summary dialog,
	 * which is where the updates are actually chosen.
	 */
	async function checkUpdates(): Promise<void> {
		busy = 'check';

		const job = await jobFlash({
			title: t('web.catalog.checking'),
			start: () => post('/plugins/check'),
			success: (result) => {
				const found = (result as { candidates: AddonUpdate[] }).candidates;
				const pending = found.filter((candidate) => candidate.groups.length);

				return {
					message: pending.length
						? t('web.catalog.buildsHaveUpdates', { count: pending.length })
						: t('web.catalog.upToDate'),
					detail:
						found.length > pending.length
							? t('web.catalog.heldBackCount', { count: found.length - pending.length })
							: ''
				};
			}
		});

		busy = '';

		if (!job) {
			return;
		}

		updates = (job.result as { candidates: AddonUpdate[] }).candidates;
		checked = true;
		updateSel = new Set();

		// nothing to preview when nothing came back; the card already said so
		if (pendingUpdates.length || heldBack.length) {
			updatesOpen = true;
		}
	}

	/**
	 * Download the named builds into the pool and deploy them. `names` empty means
	 * whatever the daemon's own re-check finds, which is what the toolbar's
	 * unqualified "Update all" asks for.
	 */
	async function applyUpdates(names: string[], label: string, flag: string): Promise<void> {
		busy = flag;

		// a job, not a spinner: this is a provider round trip per entry and then a
		// jar per pending group, so the card shows the phase it is in and the
		// bytes of the jar currently landing
		const job = await jobFlash({
			title: t('web.catalog.downloadingDeploying', { label }),
			start: () =>
				post('/plugins/update', {
					names: names.length ? names : undefined,
					deploy: true
				}),
			success: (result) => {
				const outcome = result as { applied: unknown[]; deployed: number };

				return {
					message: t('web.catalog.updatedSummary', {
						groups: outcome.applied.length,
						files: outcome.deployed
					}),
					detail: t('web.catalog.restartToLoad')
				};
			}
		});

		busy = '';

		if (!job) {
			return;
		}

		updatesOpen = false;
		updateSel = new Set();

		// the untouched candidates stay on screen, so the Update column keeps
		// reporting what is still waiting
		updates = names.length ? updates.filter((candidate) => !names.includes(candidate.name)) : [];

		await refresh();
	}

	const updateAll = () =>
		applyUpdates(
			pendingUpdates.map((candidate) => candidate.name),
			pendingUpdates.length ? t('web.catalog.updateCount', { count: pendingUpdates.length }) : t('web.catalog.updatesWord'),
			'update'
		);

	const updateSelected = () =>
		applyUpdates([...updateSel], t('web.catalog.selectedUpdateCount', { count: updateSel.size }), 'update-sel');

	const deployAll = () =>
		run('deploy', t('web.catalog.deployingAll', { plural: t(spec.plural) }), async (note) => {
			const res = await post('/plugins/deploy', {});
			const changed = res.actions.filter((action: any) => action.action !== 'unchanged').length;

			note.set({
				level: 'success',
				message: t('web.catalog.deployComplete', { count: changed }),
				detail: res.needRestart.length ? t('web.catalog.restartToApply', { names: res.needRestart.join(', ') }) : '',
				closeable: true
			});
		});

	const scan = () =>
		run('scan', t('web.catalog.scanning'), async (note) => {
			const res = await post('/plugins/scan');

			note.set({
				level: 'success',
				message: t('web.catalog.scanComplete', { count: res.report.identified.length }),
				detail: t('web.catalog.scanDetail', {
					unmanaged: res.report.unmanaged.length,
					recognized: res.report.recognized.length
				}),
				closeable: true
			});

			await refresh();
		});

	const installAddon = () =>
		run('add', t('web.catalog.installing', { name: addSlug, provider: addProvider }), async (note) => {
			const res = await post('/plugins/add', {
				slug: addSlug,
				id: addId || undefined,
				provider: addProvider,
				family: addFamily,
				targets: addTargets
			});

			note.set({
				level: 'success',
				message: t('web.catalog.installed', { name: res.name }),
				detail: res.groups
					.map((group: any) =>
						group.targets.length
							? `${group.version} → ${group.targets.join(', ')}`
							: t('web.catalog.pooledOnly', { version: group.version })
					)
					.join('; '),
				closeable: true
			});

			addOpen = false;

			await refresh();
		});

	const doRemove = () =>
		run('remove', t('web.catalog.removing', { name: removeTarget?.plugin ?? '' }), async (note) => {
			for (const family of removeTarget!.families) {
				await del(`/plugins/${encodeURIComponent(family.key)}`);
			}

			note.set({
				level: 'success',
				message: t('web.catalog.removed', { name: removeTarget!.plugin, count: removeTarget!.families.length }),
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

	/** Open the provider search on one provider, on a clean slate. */
	function openSearch(provider: string): void {
		addProvider = provider;
		addOpen = true;
		addSlug = '';
		addId = '';
		addTargets = [];
	}

	$effect(() => {
		if (uploadOpen) {
			uploadFile = null;
			uploadName = '';
			uploadTargets = [];
		}
	});

	// prefill the addon name from the jar, dropping the @family suffix luna's
	// own pool files carry; but never overwrite an edit
	$effect(() => {
		if (uploadFile && !uploadName) {
			uploadName = uploadFile.name
				.replace(/\.jar$/i, '')
				.replace(/[@_].*$/, '')
				.toLowerCase();
		}
	});

	const uploadAddon = () =>
		run('upload', t('web.catalog.uploading', { name: uploadFile?.name ?? '' }), async (note) => {
			const res = await post('/plugins/upload', {
				plugin: uploadName.trim(),
				family: uploadFamily,
				targets: uploadTargets,
				data: await fileToBase64(uploadFile!)
			});

			uploadOpen = false;

			note.set({
				level: 'success',
				message: t('web.catalog.pooled', { name: res.name }),
				detail: uploadTargets.length
					? t('web.catalog.uploadDeployed', { count: res.deployed })
					: t('web.catalog.uploadNotDeployed'),
				closeable: true
			});

			await refresh();
		});

	// Provider mapping. A row here is an addon *identity*; its paper and velocity
	// builds are separate lock entries with separate files; so a mapping can only
	// be made from this screen when there is exactly one build to map; otherwise
	// the detail screen asks about each one.
	let identifyOpen = $state(false);
	let identifyKey = $state('');
	let identifyFamily: PluginFamily = $state('paper');
	let identifyMapped = $state(false);

	function openIdentify(row: AddonRow): void {
		const family = row.families[0]!;

		identifyKey = family.key;
		identifyFamily = family.family as PluginFamily;
		identifyMapped = !!family.remote;
		identifyOpen = true;
	}

	/** An addon's verbs; the row menu and the toolbar's Actions button. */
	function rowActions(row: AddonRow): ContextMenuItem[] {
		const linked = row.families.find((family) => family.url);
		const providerLabel = linked?.remote
			? (ADDON_PROVIDERS.find((entry) => entry.id === linked.remote!.provider)?.label ??
				linked.remote.provider)
			: t('web.catalog.providerWord');

		return [
			{
				label: t('web.catalog.details', { label: t(spec.label) }),
				icon: 'circleInfo',
				action: () => goto(`/plugins/${row.plugin}`)
			},
			{
				label: t('web.catalog.deployToTargets'),
				icon: 'upload',
				action: () => deployOne(row)
			},
			{
				label: row.autoUpdate ? t('web.catalog.disableAuto') : t('web.catalog.enableAuto'),
				icon: row.autoUpdate ? 'ban' : 'circleCheck',
				action: () => toggleAutoUpdate(row)
			},
			{
				label: row.families[0]?.remote ? t('web.catalog.changeMapping') : t('web.catalog.mapToProvider'),
				icon: 'link',
				disabled: row.families.length !== 1 || row.families[0]?.source === 'luna',
				hint:
					row.families[0]?.source === 'luna'
						? t('web.catalog.inHouseHint')
						: row.families.length !== 1
							? t('web.catalog.multiBuildHint', { count: row.families.length, noun: t(spec.noun) })
							: t('web.catalog.mapHint'),
				action: () => openIdentify(row)
			},
			{
				label: t('web.catalog.openOn', { provider: providerLabel }),
				icon: 'externalLink',
				disabled: !linked,
				action: () => {
					window.open(linked!.url!, '_blank', 'noreferrer');
				}
			},
			{ separator: true },
			{
				label: t('web.catalog.removeNoun', { noun: t(spec.noun) }),
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
	const one = $derived(addons.find((row: any) => selected.has(row.plugin)));
</script>

<svelte:head><title>{t(spec.label)} | Luna Console</title></svelte:head>

<PageHeader title={t(spec.label)} count={addons.length} info>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey={kind} />
		<Dropdown label={t('web.common.actions')} disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn icon="search" loading={busy === 'scan'} disabled={!!busy} onclick={scan}>{t('web.catalog.scan')}</Btn>
		<Btn icon="sync" loading={busy === 'check'} disabled={!!busy} onclick={checkUpdates}>
			{t('web.catalog.checkUpdates')}
		</Btn>
		<Btn
			icon="download"
			loading={busy === 'update'}
			disabled={!!busy || (checked && !updates.length)}
			onclick={updateAll}
		>
			{t('web.catalog.updateAll')}
		</Btn>
		<Btn icon="upload" loading={busy === 'deploy'} disabled={!!busy} onclick={deployAll}>
			{t('web.catalog.deploy')}
		</Btn>
		<SplitBtn
			label={t('web.catalog.install')}
			icon="upload"
			primary
			onclick={() => (uploadOpen = true)}
			menu={installProviders.map((entry) => ({
				label: t('web.catalog.searchProvider', { provider: entry.label }),
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
		tableId="{kind}-grouped"
		{columns}
		rows={addons}
		getId={(row) => row.plugin}
		searchValue={(row) =>
			`${row.plugin} ${row.displayName} ${row.sources.join(' ')} ${row.families
				.map((family) => `${family.family} ${family.version ?? ''}`)
				.join(' ')} ${row.effective.join(' ')} ${row.description ?? ''}`}
		searchPlaceholder={t('web.catalog.findPlaceholder', { noun: t(spec.noun) })}
		selectable="single"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.plugin}
		noun={t(spec.noun)}
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
		emptyTitle={t('web.catalog.emptyTitle', { plural: t(spec.plural) })}
		emptyText={t(spec.emptyText)}
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
					<BrandLink {source} short />
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
				{:else if checked && row.sources.some((source) => spec.sources.includes(source))}
					<span class="dim">{t('web.catalog.current')}</span>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'auto'}
				<StatusBadge
					state={row.autoUpdate ? 'ok' : 'stopped'}
					label={row.autoUpdate ? t('web.catalog.on') : t('web.catalog.off')}
				/>
			{:else if col === 'targets'}
				<span class="dim">{row.effective.join(', ') || '–'}</span>
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<!-- install modal -->
<!-- map a file luna already pools to the project it came from -->
<IdentifyAddonModal
	bind:open={identifyOpen}
	kind={FAMILY_DIRS[identifyFamily] === 'mods' ? 'mod' : 'plugin'}
	target={identifyKey}
	family={identifyFamily}
	mapped={identifyMapped}
	onchanged={refresh}
/>

<Modal title={t('web.catalog.installTitle', { noun: t(spec.noun) })} bind:open={addOpen} wide>
	<AddonPicker
		endpoint="/plugins/search"
		kind={spec.type}
		params={{ family: addFamily }}
		bind:selected={addSlug}
		bind:provider={addProvider}
		placeholder={t('web.catalog.searchPlaceholder', { plural: t(spec.plural) })}
		onpick={(hit) => (addId = hit?.project_id ?? '')}
	>
		{#snippet toolbar()}
			{#if spec.families.length > 1}
				<Select
					value={addFamily}
					width="9rem"
					options={spec.families.map((family) => ({ value: family, label: family }))}
					onchange={(value) => (addFamily = value as AddonFamily)}
				/>
			{/if}
		{/snippet}
	</AddonPicker>
	{#if addSlug}
		<div class="tgt">
			<div class="tgtlbl">{t('web.catalog.applyTo')} <span class="opt">{t('web.catalog.optional')}</span></div>
			<p class="dim tgthint">{t('web.catalog.poolHintLong')}</p>
			<div class="targets">
				{#each targetChoices as target}
					<label class="tchk">
						<Checkbox
							checked={addTargets.includes(target)}
							label={t('web.catalog.applyToTarget', { target })}
							onchange={() => (addTargets = toggleTarget(addTargets, target))}
						/>
						{target}
					</label>
				{/each}
			</div>
		</div>
	{/if}
	{#snippet footer()}
		<Btn onclick={() => (addOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" disabled={!addSlug} loading={busy === 'add'} onclick={installAddon}>
			{t('web.catalog.install')}
		</Btn>
	{/snippet}
</Modal>

<!-- upload a jar from this computer -->
<Modal title={t('web.catalog.uploadTitle', { noun: t(spec.noun) })} bind:open={uploadOpen}>
	<FileDrop
		bind:file={uploadFile}
		accept=".jar"
		hint={t('web.catalog.dropJar', { noun: t(spec.noun) })}
	/>
	<label class="field uploadname">
		<span class="lbl">{t('web.catalog.nameLabel', { label: t(spec.label) })}</span>
		<span class="hint">{t('web.catalog.nameHint')}</span>
		<input class="input" bind:value={uploadName} placeholder="my-{kind === 'mods' ? 'mod' : 'plugin'}" />
	</label>
	{#if spec.families.length > 1}
		<div class="field">
			<span class="lbl">{t('web.catalog.platform')}</span>
			<span class="hint">{t('web.catalog.universalHint')}</span>
			<Select
				value={uploadFamily}
				width="12rem"
				options={spec.families.map((family) => ({ value: family, label: family }))}
				onchange={(value) => (uploadFamily = value as AddonFamily)}
			/>
		</div>
	{/if}
	<div class="tgt">
		<div class="tgtlbl">{t('web.catalog.applyTo')} <span class="opt">{t('web.catalog.optional')}</span></div>
		<p class="dim tgthint">{t('web.catalog.poolHintShort')}</p>
		<div class="targets">
			{#each targetChoices as target}
				<label class="tchk">
					<Checkbox
						checked={uploadTargets.includes(target)}
						label={t('web.catalog.applyToTarget', { target })}
						onchange={() => (uploadTargets = toggleTarget(uploadTargets, target))}
					/>
					{target}
				</label>
			{/each}
		</div>
	</div>
	{#snippet footer()}
		<Btn onclick={() => (uploadOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn
			variant="primary"
			disabled={!uploadFile || !uploadName.trim()}
			loading={busy === 'upload'}
			onclick={uploadAddon}
		>
			{t('web.catalog.upload')}
		</Btn>
	{/snippet}
</Modal>

<!-- what the last check found, and where the updates are chosen -->
<Modal title={t('web.catalog.updatesAvailable')} bind:open={updatesOpen} wide>
	{#if pendingUpdates.length}
		<p class="dim intro">{t('web.catalog.updatesIntro', { count: pendingUpdates.length })}</p>

		<DataTable
			columns={updateColumns}
			rows={pendingUpdates}
			getId={(row) => row.name}
			selectable="multi"
			bind:selected={updateSel}
			maxHeight="26rem"
			sortValue={(row, col) => (col === 'addon' ? row.name : (row.groups[0]?.version ?? ''))}
			emptyTitle={t('web.catalog.nothingToUpdate')}
		>
			{#snippet cell(row, col)}
				{#if col === 'addon'}
					<b>{row.plugin}</b>
					{#if spec.families.length > 1}
						<span class="fam upd-fam">{row.family}</span>
					{/if}
				{:else if col === 'version'}
					<span class="upd-ver">
						<span class="mono dim">{row.groups[0]?.current || row.installed || '?'}</span>
						<Icon name="right" size="0.75rem" />
						{#each row.groups as group, index (group.version)}
							{#if index > 0}<span class="dim">, </span>{/if}
							<span class="mono upd">{group.version}</span>
							{#if !group.isPrimary}
								<span class="dim" title={t('web.catalog.variantHint')}>
									({t('web.catalog.variant')})
								</span>
							{/if}
						{/each}
					</span>
				{:else if col === 'targets'}
					{@const targets = [...new Set(row.groups.flatMap((group) => group.targets))]}
					<span class="dim" title={targets.join(', ')}>{targets.join(', ') || '–'}</span>
				{/if}
			{/snippet}
		</DataTable>
	{:else}
		<p class="dim intro">{t('web.catalog.nothingToDownload')}</p>
	{/if}

	{#if heldBack.length}
		<div class="held">
			<div class="tgtlbl">{t('web.catalog.heldBack')}</div>
			{#each heldBack as candidate (candidate.name)}
				{#each candidate.holdbacks as holdback}
					<p class="heldrow">
						<Icon name="triangleExclamation" size="0.75rem" />
						<span><b>{candidate.plugin}</b> {t('web.catalog.onTargets', { targets: holdback.targets.join(', ') })}; {holdback.reason}</span>
					</p>
				{/each}
				{#each candidate.pinned as pin}
					<p class="heldrow">
						<Icon name="tag" size="0.75rem" />
						<span><b>{candidate.plugin}</b> {t('web.catalog.pinnedTo', { version: pin.version, target: pin.target })}</span>
					</p>
				{/each}
			{/each}
		</div>
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (updatesOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn
			icon="download"
			disabled={!updateSel.size || !!busy}
			title={updateSel.size ? '' : t('web.catalog.tickToUpdate')}
			loading={busy === 'update-sel'}
			onclick={updateSelected}
		>
			{t('web.catalog.updateSelected')}{updateSel.size ? ` (${updateSel.size})` : ''}
		</Btn>
		<Btn
			variant="primary"
			icon="download"
			disabled={!pendingUpdates.length || !!busy}
			title={pendingUpdates.length ? '' : t('web.catalog.nothingToDownloadShort')}
			loading={busy === 'update'}
			onclick={updateAll}
		>
			{t('web.catalog.updateAll')} ({pendingUpdates.length})
		</Btn>
	{/snippet}
</Modal>

<!-- remove modal -->
<Modal title={t('web.catalog.removeTitle', { name: removeTarget?.plugin ?? '' })} bind:open={removeOpen}>
	<p>
		{t('web.catalog.removeBody', {
			families: removeTarget?.families.map((family) => family.family).join(', ') ?? ''
		})}
	</p>
	{#snippet footer()}
		<Btn onclick={() => (removeOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="danger" loading={busy === 'remove'} onclick={doRemove}>{t('web.catalog.removeEverywhere')}</Btn>
	{/snippet}
</Modal>

<style lang="scss">
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

	.tgt {
		margin-top: 0.75rem;
	}

	// update summary dialog
	.intro {
		margin: 0 0 0.75rem;
		font-size: 0.875rem;
	}

	.upd-fam {
		margin-left: 0.375rem;
	}

	.upd-ver {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}

	.held {
		margin-top: 1rem;
		padding-top: 0.75rem;
		border-top: 0.1rem solid var(--border-divider);
	}

	.heldrow {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin: 0.25rem 0;
		font-size: 0.75rem;
		color: var(--warning);
	}

	.field {
		display: block;
		margin-bottom: 0.875rem;
	}

	.lbl {
		display: block;
		font-weight: 700;
		color: var(--text-heading);
	}

	.hint {
		display: block;
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin-bottom: 0.25rem;
	}

	.uploadname {
		margin-top: 1rem;
	}

	.tgtlbl {
		font-weight: 700;
		color: var(--text-heading);
		margin-bottom: 0.375rem;
	}

	// the field is genuinely optional, and the label is where that has to be said
	.opt {
		font-weight: 400;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.tgthint {
		margin: 0 0 0.5rem;
		font-size: 0.75rem;
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
