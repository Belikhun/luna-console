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
	import Select from '$lib/components/Select.svelte';
	import AddonPicker from '$lib/components/AddonPicker.svelte';
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
		modrinth?: { projectId: string; slug: string };
		matched: string[];
		groups: string[];
		granted: string[];
	}

	let packs: PackRow[] = $state([]);
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let busy = $state('');
	let selected: Set<string> = $state(new Set());

	const one = $derived(packs.find((row) => selected.has(row.key)));

	async function refresh(): Promise<void> {
		loading = true;

		try {
			packs = (await api('/respacks')).packs;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error('Could not load resource packs', { detail: (err as Error).message });
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

	/** Send the proxy a reload; the returned text feeds the notification detail. */
	async function sendReload(): Promise<string> {
		const res = await post('/respacks/reload');

		return res.sent
			? 'Reload sent to the proxy — the change is live.'
			: 'The proxy is not running; the change applies on its next boot.';
	}

	const doReload = () =>
		run('reload', 'Reloading packs on the proxy…', async (note) => {
			note.set({ level: 'success', message: await sendReload(), closeable: true });
		});

	const setEnabled = (row: PackRow, enabled: boolean) =>
		run(row.key, `${enabled ? 'Enabling' : 'Disabling'} ${row.key}…`, async (note) => {
			await patch(`/respacks/${encodeURIComponent(row.key)}`, { enabled });

			note.set({
				level: 'success',
				message: `${row.key} ${enabled ? 'enabled' : 'disabled'}`,
				detail: await sendReload(),
				closeable: true
			});
		});

	const checkUpdates = (names?: string[]) =>
		run('update', 'Checking Modrinth for pack updates…', async (note) => {
			const res = await post('/respacks/update', { names });

			if (!res.updates.length) {
				note.set({ level: 'success', message: 'Every resource pack is up to date', closeable: true });

				return;
			}

			note.set({
				level: 'info',
				message: `${res.updates.length} update(s) available`,
				detail: res.updates
					.map((update: any) => `${update.key}: ${update.from ?? '?'} → ${update.to}`)
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
		await run('update', 'Downloading pack updates…', async (note) => {
			const res = await post('/respacks/update', { names, apply: true });

			note.set({
				level: 'success',
				message: `Updated ${res.applied.length} pack(s)`,
				detail: await sendReload(),
				closeable: true
			});
		});
	}

	// -- install dialog -----------------------------------------------------------

	let addOpen = $state(false);
	let addSlug = $state('');
	let addProvider = $state('modrinth');

	/** Open the provider search on one provider, on a clean slate. */
	function openSearch(provider: string): void {
		addProvider = provider;
		addSlug = '';
		addOpen = true;
	}

	const installPack = () =>
		run('add', `Installing ${addSlug} from Modrinth…`, async (note) => {
			const res = await post('/respacks/add', { slug: addSlug });

			addOpen = false;

			note.set({
				level: 'success',
				message: `Installed ${res.pack.key} ${res.pack.versionNumber ?? ''}`,
				detail: 'The pack starts disabled — enable it and set its servers, then reload.',
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
		run('upload', `Uploading ${uploadFile?.name}…`, async (note) => {
			const res = await post('/respacks', {
				name: uploadName,
				data: await fileToBase64(uploadFile!)
			});

			uploadOpen = false;

			note.set({
				level: 'success',
				message: `Uploaded ${res.pack.key}`,
				detail: res.pack.enabled
					? await sendReload()
					: 'The pack starts disabled — enable it and set its servers, then reload.',
				closeable: true
			});
		});

	// -- remove dialog ----------------------------------------------------------------

	let removeOpen = $state(false);
	let removeTarget: PackRow | null = $state(null);
	let removeKeepFile = $state(false);

	const doRemove = () =>
		run('remove', `Removing ${removeTarget?.key}…`, async (note) => {
			await del(`/respacks/${encodeURIComponent(removeTarget!.key)}?keepFile=${removeKeepFile}`);

			removeOpen = false;

			note.set({
				level: 'success',
				message: `Removed ${removeTarget!.key}`,
				detail: await sendReload(),
				closeable: true
			});

			removeTarget = null;
		});

	// -- table ---------------------------------------------------------------------------

	const columns: Column[] = [
		{ id: 'name', label: 'Pack', sortable: true, minWidth: 160 },
		{ id: 'state', label: 'State', sortable: true },
		{ id: 'priority', label: 'Priority', sortable: true, width: 90, align: 'right' },
		{ id: 'required', label: 'Required', sortable: true },
		{ id: 'servers', label: 'Servers' },
		{ id: 'groups', label: 'Groups' },
		{ id: 'size', label: 'Size', sortable: true, width: 100, align: 'right' },
		{ id: 'source', label: 'Source', sortable: true },
		{ id: 'version', label: 'Version' },
		{ id: 'auto', label: 'Auto-update', sortable: true }
	];

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

	function rowActions(row: PackRow): ContextMenuItem[] {
		return [
			{
				label: 'Pack details',
				icon: 'circleInfo',
				action: () => goto(`/packs/${encodeURIComponent(row.key)}`)
			},
			{
				label: row.enabled ? 'Disable pack' : 'Enable pack',
				icon: row.enabled ? 'toggleOff' : 'toggleOn',
				action: () => setEnabled(row, !row.enabled)
			},
			{
				label: 'Configure pack',
				icon: 'pen',
				action: () => goto(`/packs/${encodeURIComponent(row.key)}/configure`)
			},
			{
				label: 'Check for update',
				icon: 'download',
				disabled: !row.modrinth,
				hint: !row.modrinth ? 'not identified on modrinth' : undefined,
				action: () => checkUpdates([row.key])
			},
			{
				label: 'Manage addon groups',
				icon: 'layerGroup',
				action: () => goto('/addons/groups')
			},
			{
				label: 'Open on Modrinth',
				icon: 'externalLink',
				disabled: !row.modrinth,
				hint: !row.modrinth ? 'not identified on modrinth' : undefined,
				action: () => {
					window.open(`https://modrinth.com/resourcepack/${row.modrinth!.slug}`, '_blank', 'noreferrer');
				}
			},
			{ separator: true },
			{
				label: 'Remove pack',
				icon: 'trash',
				color: 'danger',
				action: () => {
					removeTarget = row;
					removeKeepFile = false;
					removeOpen = true;
				}
			}
		];
	}
</script>

<svelte:head><title>Resource packs | Luna Console</title></svelte:head>

<PageHeader
	title="Resource packs"
	count={packs.length}
	description="Zips in <root>/packs served to players by the luna-pack proxy plugin — priority stacks them, server rules scope them, and a reload applies changes live"
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="respacks" />
		<Dropdown label="Actions" disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn icon="download" loading={busy === 'update'} disabled={!!busy} onclick={() => checkUpdates()}>
			Check updates
		</Btn>
		<Btn icon="rotate" loading={busy === 'reload'} disabled={!!busy} onclick={doReload}>
			Reload on proxy
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
		tableId="respacks"
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		rows={packs}
		getId={(row) => row.key}
		searchValue={(row) =>
			`${row.key} ${row.name} ${row.source} ${row.servers.join(' ')} ` +
			`${row.groups.join(' ')} ${row.versionNumber ?? ''}`}
		searchPlaceholder="Find a resource pack"
		selectable="single"
		bind:selected
		{rowActions}
		rowLabel={(row) => row.key}
		noun="pack"
		{sortValue}
		rowDim={(row) => !row.enabled}
		pageSize={25}
		emptyTitle="No resource packs"
		emptyText="Install one from Modrinth or upload a zip to get started."
	>
		{#snippet cell(row, col)}
			{#if col === 'name'}
				<a href="/packs/{encodeURIComponent(row.key)}">{row.key}</a>
				{#if row.name && row.name.toLowerCase() !== row.key}
					<span class="dim">({row.name})</span>
				{/if}
			{:else if col === 'state'}
				{#if !row.defFile}
					<StatusBadge
						state="warning"
						label="Unregistered"
						detail="the zip exists but no definition registers it — configure it to serve it"
					/>
				{:else if !row.present}
					<StatusBadge
						state="failed"
						label="File missing"
						detail="the definition points at {row.filename}, which does not exist"
					/>
				{:else if row.enabled}
					<StatusBadge state="ok" label="Enabled" />
				{:else}
					<StatusBadge state="stopped" label="Disabled" />
				{/if}
			{:else if col === 'priority'}
				{row.priority}
			{:else if col === 'required'}
				{#if row.required}
					<StatusBadge state="warning" label="Required" detail="players cannot decline this pack" />
				{:else}
					<span class="dim">optional</span>
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
				<span class="src {row.source}">{row.source}</span>
			{:else if col === 'version'}
				<span class="mono">{row.versionNumber ?? '–'}</span>
			{:else if col === 'auto'}
				<StatusBadge state={row.autoUpdate ? 'ok' : 'stopped'} label={row.autoUpdate ? 'On' : 'Off'} />
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<!-- install from Modrinth -->
<Modal title="Install a resource pack" bind:open={addOpen} wide>
	<AddonPicker
		endpoint="/respacks/search"
		bind:selected={addSlug}
		bind:provider={addProvider}
		placeholder="Search resource packs by name…"
	/>
	<p class="dim after">
		The pack is downloaded into <code>&lt;root&gt;/packs</code> and starts disabled — enable it and
		set its servers, or add it to an addon group.
	</p>
	{#snippet footer()}
		<Btn onclick={() => (addOpen = false)}>Cancel</Btn>
		<Btn variant="primary" disabled={!addSlug} loading={busy === 'add'} onclick={installPack}>
			Install
		</Btn>
	{/snippet}
</Modal>

<!-- upload from this computer -->
<Modal title="Upload resource pack" bind:open={uploadOpen}>
	<FileDrop bind:file={uploadFile} accept=".zip" hint="Drop a pack zip here, or click to browse" />
	<label class="field uploadname">
		<span class="lbl">Pack name</span>
		<span class="hint">Uploading under an existing pack's name replaces its file</span>
		<input class="input" bind:value={uploadName} placeholder="my-pack" />
	</label>
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

<!-- remove -->
<Modal title="Remove {removeTarget?.key}?" bind:open={removeOpen}>
	<p>
		Removes the registration — the proxy stops serving <b>{removeTarget?.key}</b> after the next
		reload.
	</p>
	<label class="checkrow">
		<Checkbox
			checked={removeKeepFile}
			label="Keep the zip"
			onchange={(value) => (removeKeepFile = value)}
		/>
		Keep the zip on disk (only the registration is removed)
	</label>
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

	.checkrow {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin-bottom: 0.75rem;
	}

	.rules {
		margin-right: 0.5rem;
	}

	// source column, tinted per origin like the plugins table
	.src {
		text-transform: capitalize;

		&.modrinth {
			color: var(--success);
		}

		&.manual {
			color: var(--warning);
		}
	}

	.uploadname {
		margin-top: 1rem;
	}

	// the sentence under the picker, explaining what installing actually does
	.after {
		margin: 0.75rem 0 0;
		font-size: 0.8125rem;
	}
</style>
