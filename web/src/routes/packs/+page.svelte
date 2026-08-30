<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

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
	import Select from '$lib/components/Select.svelte';
	import AddonPicker from '$lib/components/AddonPicker.svelte';
	import BrandLink from '$lib/components/BrandLink.svelte';
	import IdentifyAddonModal from '$lib/components/IdentifyAddonModal.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import FileDrop from '$lib/components/FileDrop.svelte';
	import { Notify, type NotificationHandle } from '$lib/notifications.svelte';

	/**
	 * Resource packs: the luna-pack proxy plugin's catalog in <root>/packs.
	 * Every pack is a zip + a yml registration (priority, required, server
	 * rules); the proxy serves them to players per backend. Changes go live
	 * with a `lunapack reload`, which this page sends after every mutation.
	 */

	interface PackRow {
		key: string;
		name: string;
		filename: string;
		defFile?: string;
		/** file = a yml luna owns · dynamic = a plugin registers it at runtime */
		registration: 'file' | 'dynamic' | 'unknown' | 'none';
		dynamic?: {
			name: string;
			priority: number;
			required: boolean;
			enabled: boolean;
			servers: string[];
			available: boolean;
			unavailableReason?: string;
		};
		/** this pack's yml is overriding a plugin that also registers it */
		shadowsDynamic?: boolean;
		priority: number;
		required: boolean;
		enabled: boolean;
		servers: string[];
		present: boolean;
		sizeBytes: number;
		source: string;
		versionNumber?: string;
		autoUpdate: boolean;
		channel?: string;
		remote?: { provider: string; projectId: string; slug: string };
		url?: string | null;
		matched: string[];
		groups: string[];
		granted: string[];
	}

	let packs: PackRow[] = $state([]);
	/** what the running proxy could say about runtime registrations */
	let dynamic: { available: boolean; problem?: string } = $state({ available: true });
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let busy = $state('');
	let selected: Set<string> = $state(new Set());

	const selRows = $derived(packs.filter((row) => selected.has(row.key)));

	/** "pack" / "3 packs"; how a verb names what it is about to act on. */
	function packNoun(rows: PackRow[]): string {
		return rows.length === 1 ? t('web.packs.onePack') : t('web.packs.nPacks', { count: rows.length });
	}

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const answer = await api('/respacks');

			packs = answer.packs;
			dynamic = answer.dynamic ?? { available: true };
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.packs.loadFailed'), { detail: (err as Error).message });
		}

		loading = false;
	}

	onMount(() => {
		void refresh();
	});

	/** Run one pack operation behind a loading flash, then refresh. */
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
				note.set({ level: 'success', message: t('web.packs.done'), closeable: true });
			}
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.packs.operationFailed'),
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = '';

		await refresh();
	}

	/** Send the proxy a reload; the returned text feeds the notification detail. */
	async function sendReload(): Promise<string> {
		const res = await post('/respacks/reload');

		return res.sent ? t('web.packs.reloadSent') : t('web.packs.proxyDown');
	}

	const doReload = () =>
		run('reload', t('web.packs.reloading'), async (note) => {
			note.set({ level: 'success', message: await sendReload(), closeable: true });
		});

	// provider mapping, one pack at a time
	let identifyOpen = $state(false);
	let identifyKey = $state('');
	let identifyMapped = $state(false);

	/** Open the mapping dialog for one pack. */
	function openIdentify(row: PackRow): void {
		identifyKey = row.key;
		identifyMapped = !!row.remote;
		identifyOpen = true;
	}

	/**
	 * Take a plugin-registered pack over: luna writes the yml luna-pack prefers,
	 * copied from what the plugin currently registers, so nothing changes for
	 * players at the moment of the transfer; only who decides it from now on.
	 */
	const takeOver = (row: PackRow) =>
		run('takeover', t('web.packs.takingOver', { key: row.key }), async (note) => {
			const answer = await post('/respacks/dynamic', { key: row.key, action: 'takeover' });

			note.set({
				level: 'success',
				message: t('web.packs.tookOver', { key: row.key }),
				detail:
					t('web.packs.tookOverDetail', {
						priority: answer.from.priority,
						required: answer.from.required ? t('web.packs.requiredWord') : t('web.packs.optionalWord'),
						servers: answer.from.servers.join(', ')
					}) + ` ${await sendReload()}`,
				closeable: true
			});
		});

	/** Give a taken-over pack back: delete the yml, leaving the plugin in charge. */
	const releaseBack = (row: PackRow) =>
		run('release', t('web.packs.releasing', { key: row.key }), async (note) => {
			const answer = await post('/respacks/dynamic', { key: row.key, action: 'release' });

			note.set({
				level: 'success',
				message: t('web.packs.released', { key: row.key }),
				detail: `${t('web.packs.removedFile', { file: answer.removed })} ${await sendReload()}`,
				closeable: true
			});
		});

	/**
	 * Flip every named pack, then reload the proxy **once**; a selection of six
	 * is one change to the catalog, not six. A pack that refuses is named in the
	 * detail rather than aborting the rest.
	 */
	const setEnabledMany = (rows: PackRow[], enabled: boolean) =>
		run('enabled', t(enabled ? 'web.packs.enabling' : 'web.packs.disabling', { what: packNoun(rows) }), async (note) => {
			const failed: string[] = [];

			for (const row of rows) {
				try {
					await patch(`/respacks/${encodeURIComponent(row.key)}`, { enabled });
				} catch (err) {
					failed.push(`${row.key}: ${(err as Error).message}`);
				}
			}

			const done = rows.length - failed.length;
			const verb = enabled ? 'enabled' : 'disabled';
			const reload = done > 0 ? await sendReload() : '';

			note.set({
				level: failed.length === 0 ? 'success' : done > 0 ? 'warning' : 'error',
				message:
					failed.length === 0 && rows[0] && rows.length === 1
						? `${rows[0].key} ${verb}`
						: `${done} of ${rows.length} packs ${verb}`,
				detail: [...failed, reload].filter(Boolean).join(' · '),
				closeable: true
			});
		});

	const checkUpdates = (names?: string[]) =>
		run('update', t('web.packs.checkingUpdates'), async (note) => {
			const res = await post('/respacks/update', { names });

			if (!res.updates.length) {
				note.set({ level: 'success', message: t('web.packs.everyResourcePackIsUp'), closeable: true });

				return;
			}

			note.set({
				level: 'info',
				message: t('web.packs.updatesAvailable', { count: res.updates.length }),
				detail: res.updates
					.map((update: any) => `${update.key}: ${update.from ?? '?'} → ${update.to}`)
					.join('; '),
				closeable: true,
				actions: [
					{
						label: t('web.packs.applyUpdates'),
						run: () => void applyUpdates(names)
					}
				]
			});
		});

	async function applyUpdates(names?: string[]): Promise<void> {
		await run('update', t('web.packs.downloadingUpdates'), async (note) => {
			const res = await post('/respacks/update', { names, apply: true });

			note.set({
				level: 'success',
				message: t('web.packs.updatedCount', { count: res.applied.length }),
				detail: await sendReload(),
				closeable: true
			});
		});
	}

	// -- install dialog -----------------------------------------------------------

	let addOpen = $state(false);
	let addSlug = $state('');
	let addId = $state('');
	let addProvider = $state('modrinth');

	/** Open the provider search on one provider, on a clean slate. */
	function openSearch(provider: string): void {
		addProvider = provider;
		addSlug = '';
		addId = '';
		addOpen = true;
	}

	const installPack = () =>
		run('add', t('web.catalog.installing', { name: addSlug, provider: addProvider }), async (note) => {
			const res = await post('/respacks/add', {
				slug: addSlug,
				id: addId || undefined,
				provider: addProvider
			});

			addOpen = false;

			note.set({
				level: 'success',
				message: t('web.packs.installedPack', { key: res.pack.key, version: res.pack.versionNumber ?? '' }),
				detail: t('web.packs.thePackStartsDisabledEnable'),
				closeable: true
			});
		});

	// -- upload dialog --------------------------------------------------------------

	let uploadOpen = $state(false);
	let uploadFile: File | null = $state(null);
	let uploadName = $state('');

	$effect(() => {
		if (uploadOpen) {
			uploadFile = null;
			uploadName = '';
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
			const res = await post('/respacks', {
				name: uploadName,
				data: await fileToBase64(uploadFile!)
			});

			uploadOpen = false;

			note.set({
				level: 'success',
				message: t('web.packs.uploadedPack', { key: res.pack.key }),
				detail: res.pack.enabled
					? await sendReload()
					: 'The pack starts disabled; enable it and set its servers, then reload.',
				closeable: true
			});
		});

	// -- replace dialog ---------------------------------------------------------------

	let replaceOpen = $state(false);
	let replaceTarget: PackRow | null = $state(null);
	let replaceFile: File | null = $state(null);

	$effect(() => {
		if (replaceOpen) {
			replaceFile = null;
		}
	});

	/**
	 * Swap one pack's zip for a local one. Unlike an upload, this keeps the
	 * registration: an operator with a new build of a pack they made themselves
	 * wants the new file, not a new pack with its rules reset.
	 */
	const replacePack = () =>
		run('replace', t('web.packs.replacingFile', { file: replaceFile?.name ?? '' }), async (note) => {
			const res = await post(`/respacks/${encodeURIComponent(replaceTarget!.key)}/file`, {
				data: await fileToBase64(replaceFile!)
			});

			replaceOpen = false;

			await refresh();

			note.set({
				level: 'success',
				message: res.unchanged
					? t('web.packs.replacedSameBytes', { file: res.file })
					: t('web.packs.replacedFile', {
							file: res.file,
							from: fmtBytes(res.sizeBefore),
							to: fmtBytes(res.sizeAfter)
						}),
				detail: res.reloaded
					? t('web.packs.replacedReloaded')
					: t('web.packs.replacedProxyDown'),
				closeable: true
			});
		});

	// -- remove dialog ----------------------------------------------------------------

	let removeOpen = $state(false);
	let removeTargets: PackRow[] = $state([]);
	let removeKeepFile = $state(false);

	const doRemove = () =>
		run('remove', t('web.packs.removingWhat', { what: packNoun(removeTargets) }), async (note) => {
			const failed: string[] = [];
			const gone: string[] = [];

			for (const row of removeTargets) {
				try {
					await del(`/respacks/${encodeURIComponent(row.key)}?keepFile=${removeKeepFile}`);
					gone.push(row.key);
				} catch (err) {
					failed.push(`${row.key}: ${(err as Error).message}`);
				}
			}

			removeOpen = false;

			note.set({
				level: failed.length === 0 ? 'success' : gone.length ? 'warning' : 'error',
				message: gone.length === 1 ? t('web.packs.removedOne', { key: gone[0] ?? '' }) : t('web.packs.removedMany', { count: gone.length }),
				detail: [...failed, gone.length ? await sendReload() : ''].filter(Boolean).join(' · '),
				closeable: true
			});

			removeTargets = [];
			selected = new Set();
		});

	// -- table ---------------------------------------------------------------------------

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.packs.pack2'), sortable: true, minWidth: 160 },
		// the badge plus a registration tag ("plugin", "overrides plugin") needs the room
		{ id: 'state', label: t('web.packs.state'), sortable: true, minWidth: 240 },
		{ id: 'priority', label: t('web.packs.priority'), sortable: true, width: 90, align: 'right' },
		{ id: 'required', label: t('web.packs.required'), sortable: true },
		{ id: 'servers', label: t('web.packs.servers') },
		{ id: 'groups', label: t('web.packs.groups') },
		{ id: 'size', label: t('web.packs.size'), sortable: true, width: 100, align: 'right' },
		{ id: 'source', label: t('web.packs.source'), sortable: true, minWidth: 140 },
		{ id: 'version', label: t('web.packs.version') },
		{ id: 'auto', label: t('web.packs.autoUpdate'), sortable: true }
	]);

	function sortValue(row: PackRow, col: string): string | number | null {
		switch (col) {
			case 'name':
				return row.key;

			case 'state':
				return row.enabled ? 0 : row.defFile ? 1 : 2;

			case 'priority':
				return row.priority;

			case 'required':
				return row.required ? 0 : 1;

			case 'size':
				return row.sizeBytes;

			case 'source':
				return row.source;

			case 'auto':
				return row.autoUpdate ? 0 : 1;

			default:
				return null;
		}
	}

	/**
	 * The verbs for a *selection* of packs; one declaration behind both the row's
	 * context menu (a selection of one) and the screen's Actions dropdown. A verb
	 * that only makes sense for a single pack disables itself with the reason
	 * instead of the whole menu going dead the moment a second row is ticked, and
	 * a bulk verb targets only the rows it applies to (enabling skips the ones
	 * already enabled) so a mixed selection still has one obvious meaning.
	 */
	function packActions(rows: PackRow[]): ContextMenuItem[] {
		const only = rows.length === 1 ? rows[0] : undefined;
		const oneOnly = 'pick a single pack';

		const toEnable = rows.filter((row) => !row.enabled);
		const toDisable = rows.filter((row) => row.enabled);
		const updatable = rows.filter((row) => row.remote);
		const updTargets = updatable.length ? updatable : rows;

		return [
			{
				label: t('web.packs.packDetails'),
				icon: 'circleInfo',
				disabled: !only,
				hint: only ? undefined : oneOnly,
				action: () => goto(`/packs/${encodeURIComponent(only!.key)}`)
			},
			{
				label: t('web.packs.configurePack'),
				icon: 'pen',
				disabled: !only,
				hint: only ? undefined : oneOnly,
				action: () => goto(`/packs/${encodeURIComponent(only!.key)}/configure`)
			},
			{ separator: true },
			{
				label: t('web.packs.enableWhat', { what: packNoun(toEnable.length ? toEnable : rows) }),
				icon: 'toggleOn',
				disabled: toEnable.length === 0,
				hint: toEnable.length === 0 ? 'already enabled' : undefined,
				action: () => setEnabledMany(toEnable, true)
			},
			{
				label: t('web.packs.disableWhat', { what: packNoun(toDisable.length ? toDisable : rows) }),
				icon: 'toggleOff',
				disabled: toDisable.length === 0,
				hint: toDisable.length === 0 ? 'already disabled' : undefined,
				action: () => setEnabledMany(toDisable, false)
			},
			{
				label: updTargets.length === 1 ? t('web.packs.checkForUpdate') : t('web.packs.checkManyUpdates', { count: updTargets.length }),
				icon: 'download',
				disabled: updatable.length === 0,
				hint: updatable.length === 0 ? 'not identified with a provider' : undefined,
				action: () => checkUpdates(updatable.map((row) => row.key))
			},
			{
				label: t('web.packs.replaceFile'),
				icon: 'upload',
				disabled: !only || only.registration === 'dynamic',
				hint: !only
					? oneOnly
					: only.registration === 'dynamic'
						? t('web.packs.replaceDynamicHint')
						: t('web.packs.replaceKeepsRegistration'),
				action: () => {
					replaceTarget = only!;
					replaceOpen = true;
				}
			},
			{ separator: true },
			{
				label: only?.remote ? 'Change provider mapping…' : 'Map to a provider…',
				icon: 'link',
				disabled: !only,
				hint: only ? 'record which project this zip came from' : oneOnly,
				action: () => openIdentify(only!)
			},
			{
				label: t('web.packs.takeOverFromItsPlugin'),
				icon: 'handshake',
				// only a pack a plugin registers can be taken over, and only once
				disabled: only?.registration !== 'dynamic',
				hint:
					!only
						? oneOnly
						: only.registration === 'dynamic'
							? 'write a definition luna owns, copied from the running one'
							: 'not registered by a plugin',
				action: () => takeOver(only!)
			},
			{
				label: t('web.packs.releaseBackToItsPlugin'),
				icon: 'rotate',
				disabled: !only?.shadowsDynamic,
				hint:
					!only
						? oneOnly
						: only.shadowsDynamic
							? 'delete luna\'s definition and let the plugin decide again'
							: 'no plugin registration behind this pack',
				action: () => releaseBack(only!)
			},
			{ separator: true },
			{
				label: t('web.packs.manageAddonGroups'),
				icon: 'layerGroup',
				action: () => goto('/addons/groups')
			},
			{
				label: only?.remote ? t('web.catalog.openOn', { provider: only.remote.provider }) : t('web.packs.openOnProvider'),
				icon: 'externalLink',
				disabled: !only?.url,
				hint: !only ? oneOnly : !only.url ? 'not identified with a provider' : undefined,
				action: () => {
					window.open(only!.url!, '_blank', 'noreferrer');
				}
			},
			{ separator: true },
			{
				label: t('web.packs.removeWhat', { what: packNoun(rows) }),
				icon: 'trash',
				color: 'danger',
				action: () => {
					removeTargets = rows;
					removeKeepFile = false;
					removeOpen = true;
				}
			}
		];
	}

	/**
	 * Right-clicking inside a multi-row selection acts on the whole selection -
	 * the highlight is a promise about what the next verb will touch, so the menu
	 * has to keep it. Outside the selection, DataTable has already moved the
	 * selection onto this row.
	 */
	function rowActions(row: PackRow): ContextMenuItem[] {
		const inSelection = selected.has(row.key) && selected.size > 1;

		return packActions(inSelection ? selRows : [row]);
	}
</script>

<svelte:head><title>{t('web.packs.resourcePacksLunaConsole')}</title></svelte:head>

<PageHeader
	title={t('web.packs.resourcePacks')}
	count="{selected.size ? `${selected.size}/` : ''}{packs.length}"
	description={t('web.packs.zipsInRootPacksServed')}
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="respacks" />
		<!-- the selection's verbs are the row's verbs; one declaration, two places
		     to reach it (here and the row's context menu) -->
		<Dropdown
			label={t('web.packs.actions')}
			disabled={selRows.length === 0}
			menu={selRows.length ? packActions(selRows) : []}
		/>
		<Btn icon="download" loading={busy === 'update'} disabled={!!busy} onclick={() => checkUpdates()}>
			{t('web.packs.checkUpdates')}
		</Btn>
		<Btn icon="rotate" loading={busy === 'reload'} disabled={!!busy} onclick={doReload}>
			{t('web.packs.reloadOnProxy')}
		</Btn>
		<SplitBtn
			label={t('web.packs.install')}
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

{#if !dynamic.available}
	<Flash kind="info">
		{t('web.packs.theProxyIsNot')}
		with no definition may still be registered. {dynamic.problem}
	</Flash>
	<div class="gap"></div>
{/if}

<Panel flush>
	<ResourceTable
		tableId="respacks"
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		rows={packs}
		getId={(row) => row.key}
		searchValue={(row) =>
			`${row.key} ${row.name} ${row.source} ${row.servers.join(' ')} ` +
			`${row.groups.join(' ')} ${row.versionNumber ?? ''}`}
		searchPlaceholder={t('web.packs.findAResourcePack')}
		selectable="multi"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.key}
		noun={t('web.packs.pack')}
		{sortValue}
		rowDim={(row) => !row.enabled}
		pageSize={25}
		emptyTitle={t('web.packs.noResourcePacks')}
		emptyText={t('web.packs.installOneFromModrinthOr')}
	>
		{#snippet cell(row, col)}
			{#if col === 'name'}
				<a href="/packs/{encodeURIComponent(row.key)}">{row.key}</a>
				{#if row.name && row.name.toLowerCase() !== row.key}
					<span class="dim">({row.name})</span>
				{/if}
			{:else if col === 'state'}
				{#if row.registration === 'dynamic'}
					<StatusBadge
						state={row.enabled ? 'ok' : 'stopped'}
						label={row.enabled ? 'Enabled' : 'Disabled'}
						detail="registered by a plugin at runtime; its priority, rules and enablement are the plugin's, and luna has no definition for it"
					/>
					<span class="reg">{t('web.packs.plugin')}</span>
				{:else if row.registration === 'unknown'}
					<StatusBadge
						state="unknown"
						label={t('web.packs.registrationUnknown')}
						detail="no definition on disk, and the proxy is not answering; a plugin may be registering it at runtime"
					/>
				{:else if !row.defFile}
					<StatusBadge
						state="warning"
						label={t('web.packs.unregistered')}
						detail="the zip exists but no definition registers it; configure it to serve it"
					/>
				{:else if !row.present}
					<StatusBadge
						state="failed"
						label={t('web.packs.fileMissing')}
						detail="the definition points at {row.filename}, which does not exist"
					/>
				{:else if row.enabled}
					<StatusBadge state="ok" label={t('web.packs.enabled')} />
				{:else}
					<StatusBadge state="stopped" label={t('web.packs.disabled')} />
				{/if}
				{#if row.shadowsDynamic}
					<span
						class="reg warn"
						title={t('web.packs.aPluginAlsoRegistersThis')}
					>
						{t('web.packs.overridesPlugin')}
					</span>
				{/if}
			{:else if col === 'priority'}
				{row.priority}
			{:else if col === 'required'}
				{#if row.required}
					<StatusBadge state="warning" label={t('web.packs.required')} detail="players cannot decline this pack" />
				{:else}
					<span class="dim">{t('web.packs.optional')}</span>
				{/if}
			{:else if col === 'servers'}
				<span class="mono rules">{row.servers.join(', ') || '–'}</span>
				{#if row.matched.length}
					<span class="dim">→ {row.matched.join(', ')}</span>
				{/if}
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
				{#if (row.registration === 'dynamic' || row.shadowsDynamic) && !row.remote}
					<span class="dim">{t('web.packs.plugin')}</span>
				{:else}
					<BrandLink source={row.source} short />
				{/if}
			{:else if col === 'version'}
				<span class="mono">{row.versionNumber ?? '–'}</span>
			{:else if col === 'auto'}
				<StatusBadge state={row.autoUpdate ? 'ok' : 'stopped'} label={row.autoUpdate ? 'On' : 'Off'} />
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<!-- map an existing zip to the project it came from -->
<IdentifyAddonModal
	bind:open={identifyOpen}
	kind="respack"
	target={identifyKey}
	mapped={identifyMapped}
	onchanged={refresh}
/>

<!-- install from a provider -->
<Modal title={t('web.packs.installAResourcePack')} bind:open={addOpen} wide>
	<AddonPicker
		endpoint="/respacks/search"
		kind="resourcepack"
		bind:selected={addSlug}
		bind:provider={addProvider}
		placeholder={t('web.packs.searchResourcePacksByName')}
		onpick={(hit) => (addId = hit?.project_id ?? '')}
	/>
	<p class="dim after">
		The pack is downloaded into <code>&lt;root&gt;/packs</code> and starts disabled; enable it and
		{t('web.packs.setItsServersOr')}
	</p>
	{#snippet footer()}
		<Btn onclick={() => (addOpen = false)}>{t('web.packs.cancel')}</Btn>
		<Btn variant="primary" disabled={!addSlug} loading={busy === 'add'} onclick={installPack}>
			Install
		</Btn>
	{/snippet}
</Modal>

<!-- upload from this computer -->
<Modal title={t('web.packs.uploadResourcePack')} bind:open={uploadOpen}>
	<FileDrop bind:file={uploadFile} accept=".zip" hint={t('web.packs.dropAPackZipHere')} />
	<label class="field uploadname">
		<span class="lbl">{t('web.packs.packName')}</span>
		<span class="hint">{t('web.packs.uploadingUnderAnExisting')}</span>
		<input class="input" bind:value={uploadName} placeholder={t('web.packs.myPack')} />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (uploadOpen = false)}>{t('web.packs.cancel')}</Btn>
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

<!-- replace one pack's zip -->
<Modal
	title={t('web.packs.replaceFileTitle', { key: replaceTarget?.key ?? '' })}
	bind:open={replaceOpen}
>
	<FileDrop bind:file={replaceFile} accept=".zip" hint={t('web.packs.dropTheNewZip')} />
	<p class="dim modalnote">
		{t('web.packs.replaceExplains', { file: replaceTarget?.filename ?? '' })}
	</p>
	{#if replaceTarget?.remote}
		<p class="dim modalnote">
			{t('web.packs.replaceDropsProvider', { provider: replaceTarget.source })}
		</p>
	{/if}
	{#snippet footer()}
		<Btn onclick={() => (replaceOpen = false)}>{t('web.packs.cancel')}</Btn>
		<Btn
			variant="primary"
			icon="upload"
			disabled={!replaceFile}
			loading={busy === 'replace'}
			onclick={replacePack}
		>
			{t('web.packs.replace')}
		</Btn>
	{/snippet}
</Modal>

<!-- remove -->
<Modal
	title={removeTargets.length === 1
		? t('web.packs.removeTitleOne', { key: removeTargets[0]?.key ?? '' })
		: t('web.packs.removeTitleMany', { count: removeTargets.length })}
	bind:open={removeOpen}
>
	<p>
		{t('web.packs.removesTheRegistrationThe')}
		{#if removeTargets.length === 1}
			<b>{removeTargets[0]?.key}</b>
		{:else}
			{t('web.packs.thesePacks')}
		{/if}
		{t('web.packs.afterTheNextReload')}
	</p>
	{#if removeTargets.length > 1}
		<ul class="targets">
			{#each removeTargets as target (target.key)}
				<li>{target.key}</li>
			{/each}
		</ul>
	{/if}
	<label class="checkrow">
		<Checkbox
			checked={removeKeepFile}
			label={t('web.packs.keepTheZip')}
			onchange={(value) => (removeKeepFile = value)}
		/>
		{t('web.packs.keepTheZipOn')}
	</label>
	{#snippet footer()}
		<Btn onclick={() => (removeOpen = false)}>{t('web.packs.cancel')}</Btn>
		<Btn variant="danger" loading={busy === 'remove'} onclick={doRemove}>{t('web.packs.remove')}</Btn>
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

	.checkrow {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-bottom: 0.75rem;
	}

	// what a bulk removal is about to take, named one per line
	.targets {
		margin: 0 0 0.875rem;
		padding-left: 1.25rem;
		color: var(--text-heading);
	}

	.gap {
		height: 1rem;
	}

	// a word beside the state badge, for where a registration comes from
	.reg {
		margin-left: 0.375rem;
		padding: 0.125rem 0.375rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-input);
		font-size: 0.6875rem;
		color: var(--text-secondary);
		white-space: nowrap;

		&.warn {
			color: var(--warning);
			border-color: var(--warning);
		}
	}

	.rules {
		margin-right: 0.5rem;
	}

	.uploadname {
		margin-top: 1rem;
	}

	.modalnote {
		margin: 0.75rem 0 0;
		font-size: 0.8125rem;
		line-height: 1.5;
	}

	// the sentence under the picker, explaining what installing actually does
	.after {
		margin: 0.75rem 0 0;
		font-size: 0.8125rem;
	}
</style>
