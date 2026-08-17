<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * The server-selector editor: the chest as players see it, with everything
	 * behind it editable.
	 *
	 * cluster.json is the source of truth here; `Save` writes the metadata onto
	 * the instances, `Apply` generates `servers.yml` and reloads the proxy. They
	 * are separate on purpose: an admin mid-edit will often have a duplicate slot
	 * or an unnamed server, and being unable to save that is worse than saving it.
	 * Validation bites at apply, where the proxy would otherwise refuse the reload
	 * and say nothing useful about why.
	 */

	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { beforeNavigate } from '$app/navigation';

	import { api, patch, post } from '$lib/api';
	import { followJob } from '$lib/jobs';
	import { Notify } from '$lib/notifications.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import ColorPicker from '$lib/components/ColorPicker.svelte';
	import ConditionBuilder from '$lib/components/ConditionBuilder.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import ItemTooltip from '$lib/components/ItemTooltip.svelte';
	import MinecraftInventory from '$lib/components/MinecraftInventory.svelte';
	import MinecraftItem from '$lib/components/MinecraftItem.svelte';
	import MiniMessageInput from '$lib/components/MiniMessageInput.svelte';
	import MinecraftText from '$lib/components/MinecraftText.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import ProgressTree from '$lib/components/ProgressTree.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import Select from '$lib/components/Select.svelte';
	import Slider from '$lib/components/Slider.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import { loadRegistry, materialKey, type McAssetRegistry, type McAssetState } from '$lib/components/mcassets';
	import type { InventorySlot, SlotDragSource } from '$lib/components/minecraftinventory';
	import type { JobView } from '$lib/jobs';
	import {
		SELECTOR_STATUSES,
		type SelectorDraft,
		type SelectorIssue,
		type SelectorServerDraft,
		type SelectorStatus
	} from '$shared/selector';
	import { validateSelectorDraft } from '$shared/selector';
	import { resolveItem, type PreviewMetrics } from '$shared/selectorpreview';

	interface SelectorState {
		configured: boolean;
		fileExists: boolean;
		drift: boolean;
		driftPaths: string[];
		issues: SelectorIssue[];
		placed: number;
		pages: number;
		proxyReachable: boolean;
	}

	let draft: SelectorDraft | null = $state(null);
	let pristine = $state('');
	let selectorState: SelectorState | null = $state(null);
	let loading = $state(true);
	let busy = $state('');
	let lastUpdated: number | null = $state(null);

	/** How big the previewed GUI is drawn, as a percentage of its full size. */
	const GUI_SCALE_KEY = 'luna.selector.guiScale';

	let guiScale = $state(50);
	let page = $state(1);
	let selectedSlot: number | null = $state(null);
	let hoveredSlot: number | null = $state(null);
	let simulated: SelectorStatus | 'LIVE' = $state('LIVE');
	let tab = $state('item');

	let registry: McAssetRegistry | null = $state(null);
	let assets: McAssetState | null = $state(null);
	let telemetry: Record<string, PreviewMetrics> = $state({});
	let statuses: Record<string, SelectorStatus> = $state({});

	let yamlOpen = $state(false);
	let yamlText = $state('');
	let applyJob: JobView | null = $state(null);
	let applyOpen = $state(false);
	let importOpen = $state(false);
	let importReport: { imported: string[]; warnings: string[]; equal: boolean; diff: string[]; saved: boolean } | null =
		$state(null);

	const dirty = $derived(!!draft && JSON.stringify(draft) !== pristine);
	const issues = $derived(draft ? validateSelectorDraft(draft) : []);
	const errors = $derived(issues.filter((issue) => issue.level === 'error'));

	/** Typed so the entries keep their shape; Object.entries widens to unknown. */
	function entriesOf(source: SelectorDraft | null): Array<[string, SelectorServerDraft]> {
		return Object.entries(source?.servers ?? {}) as Array<[string, SelectorServerDraft]>;
	}

	const placedEntries = $derived(entriesOf(draft).filter(([, server]) => !!server.selector));
	const unplaced = $derived(entriesOf(draft).filter(([, server]) => !server.selector));
	const maxPage = $derived(Math.max(1, ...placedEntries.map(([, server]) => server.selector?.page ?? 1)));

	/** The status to draw a server in: live if we know it, else the simulated one. */
	function statusOf(name: string): SelectorStatus {
		if (simulated !== 'LIVE') {
			return simulated;
		}

		// the proxy's own verdict, which is not the same question as whether the
		// backend answered: a whitelisted one answers and is still in MAINT
		return statuses[name] ?? 'OFFLINE';
	}

	const slots = $derived.by(() => {
		const out: Array<InventorySlot | null> = Array.from({ length: 45 }, () => null);

		if (!draft) {
			return out;
		}

		for (const [name, server] of placedEntries) {
			const entry = server.selector!;

			if (entry.page !== page || entry.slot < 0 || entry.slot >= 45) {
				continue;
			}

			const status = statusOf(name);
			const item = resolveItem(name, server, draft, status, telemetry[name] ?? {});

			out[entry.slot] = {
				name,
				item: item.material,
				glint: item.glint ?? false,
				page: entry.page,
				accentColor: server.accentColor,
				status
			};
		}

		return out;
	});

	/** The plugin's own bottom row, drawn read-only so the preview is honest. */
	const footer: Array<InventorySlot | null> = [
		{ name: 'Về Sảnh', item: 'OAK_DOOR', page: 1 },
		{ name: 'Quay lại server trước', item: 'COMPASS', page: 1 },
		{ name: 'Bảng điều khiển', item: 'CLOCK', page: 1 },
		{ name: 'Đóng', item: 'BARRIER', page: 1 },
		null,
		null,
		null,
		{ name: 'Trang trước', item: 'MAP', page: 1 },
		{ name: 'Trang sau', item: 'PAPER', page: 1 }
	];

	const selectedName = $derived(selectedSlot === null ? null : (slots[selectedSlot]?.name ?? null));
	const selectedServer: SelectorServerDraft | null = $derived.by(() => {
		const name = selectedName;
		const current = draft;

		return name && current ? (current.servers[name] ?? null) : null;
	});

	const hovered = $derived.by(() => {
		if (hoveredSlot === null || !draft) {
			return null;
		}

		const slot = slots[hoveredSlot];

		if (!slot) {
			return null;
		}

		const server: SelectorServerDraft | undefined = draft.servers[slot.name];

		return server ? resolveItem(slot.name, server, draft, slot.status ?? 'OFFLINE', telemetry[slot.name] ?? {}) : null;
	});

	const materialOptions = $derived.by(() => {
		const loaded = registry;

		if (!loaded) {
			return [];
		}

		return Object.keys(loaded.items)
			.sort()
			.map((name) => ({ value: name, label: name }));
	});

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const body = await api('/selector');
			selectorState = body.state;

			// a refresh must never eat unsaved work; this screen auto-refreshes to
			// keep the live status honest, and adopting the stored draft while the
			// user is mid-edit would silently undo whatever they just did. Throwing
			// the edits away stays available, deliberately, as `Discard changes`.
			if (!dirty) {
				draft = body.draft;
				pristine = JSON.stringify(body.draft);
			}

			lastUpdated = Date.now();
		} catch (err) {
			Notify.error('Could not load the server selector', { detail: (err as Error).message });
		}

		try {
			assets = (await api('/mc/assets')).state;
			registry = await loadRegistry();
		} catch {
			// the editor still works without sprites; items fall back to tiles
		}

		try {
			const rows = (await api('/luna/telemetry'))?.backends ?? [];
			const nextMetrics: Record<string, PreviewMetrics> = {};
			const nextStatus: Record<string, SelectorStatus> = {};

			for (const row of rows as Array<Record<string, unknown>>) {
				const name = String(row.name);
				const metrics = (row.metrics ?? {}) as Record<string, number>;
				nextStatus[name] = SELECTOR_STATUSES.includes(row.status as SelectorStatus)
					? (row.status as SelectorStatus)
					: 'OFFLINE';

				// a backend that is down reports a row of zeroes, and those are an
				// absence rather than a measurement; taking them as numbers is what
				// draws `0/0 người chơi` on a card being previewed as ONLINE
				if (row.online !== true) {
					continue;
				}

				nextMetrics[name] = {
					online: metrics.onlinePlayers,
					max: metrics.maxPlayers,
					tps: metrics.tps,
					uptimeMillis: metrics.uptimeMillis,
					cpuUsage: metrics.systemCpuUsagePercent,
					ramUsedBytes: metrics.ramUsedBytes,
					ramMaxBytes: metrics.ramMaxBytes,
					latencyMs: metrics.heartbeatLatencyMillis
				};
			}

			telemetry = nextMetrics;
			statuses = nextStatus;
		} catch {
			// live values are a nicety; the preview falls back to its own samples
		}

		loading = false;
	}

	/** Remembered per browser: how close an admin works is not part of the draft. */
	function setGuiScale(next: number): void {
		guiScale = next;

		try {
			localStorage.setItem(GUI_SCALE_KEY, String(next));
		} catch {
			// a browser with storage disabled just forgets the zoom
		}
	}

	onMount(() => {
		try {
			const stored = Number(localStorage.getItem(GUI_SCALE_KEY));

			if (Number.isFinite(stored) && stored >= 25 && stored <= 150) {
				guiScale = stored;
			}
		} catch {
			// no storage, default size
		}

		void refresh();
	});

	beforeNavigate(({ cancel }) => {
		if (dirty && !confirm('You have unsaved selector changes. Leave anyway?')) {
			cancel();
		}
	});

	/** Mutate the draft through a copy, so `$derived` sees a new object. */
	function edit(mutate: (next: SelectorDraft) => void): void {
		if (!draft) {
			return;
		}

		const next = structuredClone($state.snapshot(draft)) as SelectorDraft;
		mutate(next);
		draft = next;
	}

	function editServer(name: string, mutate: (server: SelectorDraft['servers'][string]) => void): void {
		edit((next) => {
			const server = next.servers[name];

			if (server) {
				mutate(server);
			}
		});
	}

	function handleDrop(source: SlotDragSource, slot: number): void {
		edit((next) => {
			const moving = next.servers[source.name];

			if (!moving) {
				return;
			}

			const occupant = Object.entries(next.servers).find(
				([name, server]) => name !== source.name && server.selector?.page === page && server.selector?.slot === slot
			);

			// dropping onto an occupied slot swaps the two, which is what dragging
			// things around a grid is expected to do
			if (occupant && source.fromSlot !== undefined) {
				occupant[1].selector = { ...occupant[1].selector!, page, slot: source.fromSlot };
			} else if (occupant) {
				delete occupant[1].selector;
			}

			moving.selector = moving.selector
				? { ...moving.selector, page, slot }
				: { page, slot, glint: false };
		});

		selectedSlot = slot;
	}

	function unplace(name: string): void {
		editServer(name, (server) => {
			delete server.selector;
		});
		selectedSlot = null;
	}

	async function save(): Promise<void> {
		if (!draft) {
			return;
		}

		busy = 'save';
		const note = Notify.loading('Saving the selector…');

		try {
			await patch('/selector', { draft: $state.snapshot(draft) });
			pristine = JSON.stringify(draft);
			note.set({ level: 'success', message: t('web.selector.selectorSavedToClusterJson'), closeable: true });
			await refresh();
		} catch (err) {
			note.set({ level: 'error', message: t('web.selector.couldNotSave'), detail: (err as Error).message, closeable: true });
		}

		busy = '';
	}

	async function applyToProxy(): Promise<void> {
		busy = 'apply';
		applyOpen = true;
		const note = Notify.loading('Applying the selector…');

		try {
			const { job } = await post('/selector/apply', {});
			applyJob = job;
			const done = await followJob(job.id, (view) => (applyJob = view));
			const result = done.result as { placed: number; proxyReloaded: boolean };

			note.set({
				level: result.proxyReloaded ? 'success' : 'warning',
				message: result.proxyReloaded
					? `Applied; ${result.placed} server(s), proxy reloaded`
					: 'servers.yml written, but the proxy did not reload',
				closeable: true
			});

			await refresh();
		} catch (err) {
			note.set({ level: 'error', message: t('web.selector.applyFailed'), detail: (err as Error).message, closeable: true });
		}

		busy = '';
	}

	async function showYaml(): Promise<void> {
		yamlOpen = true;
		yamlText = 'loading…';

		const res = await fetch('/api/selector/preview');
		yamlText = res.ok ? await res.text() : `could not render: HTTP ${res.status}`;
	}

	async function runImport(force: boolean): Promise<void> {
		busy = 'import';

		try {
			const { report } = await post('/selector/import', { force });
			importReport = report;

			if (report.saved) {
				await refresh();
			}
		} catch (err) {
			Notify.error('Import failed', { detail: (err as Error).message });
		}

		busy = '';
	}

	async function extractAssets(): Promise<void> {
		busy = 'assets';
		const note = Notify.loading('Extracting Minecraft assets…');

		try {
			const { job } = await post('/mc/assets', {});
			await followJob(job.id, () => undefined);
			note.set({ level: 'success', message: t('web.selector.assetsExtracted'), closeable: true });
			registry = null;
			await refresh();
		} catch (err) {
			note.set({ level: 'error', message: t('web.selector.couldNotExtractAssets'), detail: (err as Error).message, closeable: true });
		}

		busy = '';
	}

	const statusOptions = [
		{ value: 'LIVE', label: t('web.selector.liveStatus') },
		...SELECTOR_STATUSES.map((status) => ({ value: status, label: `As ${status}` }))
	];
</script>

<svelte:head><title>{t('web.selector.serverSelectorLunaConsole')}</title></svelte:head>

<PageHeader
	title={t('web.selector.serverSelector')}
	count={`${selectorState?.placed ?? 0}`}
	description={t('web.selector.theChestPlayersOpenWith')}
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="selector" />

		<Dropdown
			label={t('web.selector.actions')}
			items={[
				{ label: t('web.selector.importFromServersYml2'), icon: 'download', action: () => {
						importOpen = true;
					} },
				{ label: t('web.selector.viewGeneratedYaml'), icon: 'file', action: showYaml },
				{ label: t('web.selector.rebuildItemSprites'), icon: 'cube', action: extractAssets },
				{
					label: t('web.selector.discardChanges'), icon: 'rotate', danger: true, disabled: !dirty, hint: dirty ? undefined : 'nothing has been changed',
					action: () => {
						draft = JSON.parse(pristine);
					}
				}
			]}
		/>

		<Btn icon="floppyDisk" disabled={!dirty || !!busy} loading={busy === 'save'} onclick={save}>
			{dirty ? 'Save' : 'Saved'}
		</Btn>

		<Btn
			variant="primary"
			icon="cloudArrowUp"
			disabled={!!busy || errors.length > 0}
			title={errors.length > 0 ? 'fix the errors below first; the proxy would refuse the reload' : undefined}
			loading={busy === 'apply'}
			onclick={applyToProxy}
		>
			{t('web.selector.applyToProxy')}
		</Btn>
	{/snippet}
</PageHeader>

{#if assets && !assets.present}
	<div class="banner">
		<Icon name="triangleExclamation" style="solid" />
		<span>
			{t('web.selector.minecraftSItemTextures')}
			<button class="link" onclick={extractAssets}>{t('web.selector.extractThemNow')}</button>; one download of the {assets.wanted} client.
		</span>
	</div>
{/if}

{#if selectorState && !selectorState.configured}
	<div class="banner">
		<Icon name="circleInfo" style="solid" />
		<span>
			{t('web.selector.clusterJsonHasNo')}
			<button class="link" onclick={() => (importOpen = true)}>{t('web.selector.importTheExistingServers')}</button> to adopt what the
			{t('web.selector.proxyRunsToday')}
		</span>
	</div>
{/if}

{#if issues.length > 0}
	<div class="issues" class:hasErrors={errors.length > 0}>
		{#each issues.slice(0, 6) as issue (issue.path + issue.message)}
			<p>
				<Icon
					name={issue.level === 'error' ? 'circleXmark' : 'triangleExclamation'}
					style="solid"
					color={issue.level === 'error' ? 'var(--error)' : 'var(--warning)'}
				/>
				<code class="inline">{issue.path}</code>
				{issue.message}
			</p>
		{/each}
		{#if issues.length > 6}
			<p class="dim">…and {issues.length - 6} more</p>
		{/if}
	</div>
{/if}

<div class="layout">
	<div class="left">
		<Panel title={t('web.selector.preview')} description={t('web.selector.hoverAnItemForIts')}>
			{#snippet actions()}
				<div class="zoom">
					<Icon name="magnifyingGlassPlus" style="solid" />
					<Slider
						value={guiScale}
						min={25}
						max={150}
						step={5}
						unit="%"
						width="11rem"
						label={t('web.selector.guiSize')}
						onchange={setGuiScale}
					/>
				</div>
				<Select
					value={simulated}
					options={statusOptions}
					width="10rem"
					onchange={(next) => (simulated = next as SelectorStatus | 'LIVE')}
				/>
			{/snippet}

			<div class="pages">
				{#each { length: maxPage } as _, index (index)}
					<Btn variant={page === index + 1 ? 'primary' : 'normal'} onclick={() => (page = index + 1)}>
						{index + 1}
					</Btn>
				{/each}
				<Btn variant="link" onclick={() => (page = maxPage + 1)}>{t('web.selector.page')}</Btn>
			</div>

			<div class="chestwrap">
				<MinecraftInventory
					{slots}
					{footer}
					scale={guiScale / 100}
					selected={selectedSlot}
					onselect={(slot) => (selectedSlot = slots[slot] ? slot : null)}
					ondropslot={handleDrop}
					onhover={(slot) => (hoveredSlot = slot)}
				>
					{#snippet title()}
						{#if draft?.global.title}
							<MinecraftText source={draft.global.title} inline values={{ player_name: 'Steve' }} />
						{/if}
					{/snippet}

					{#snippet tooltip()}
						{#if hovered}
							<ItemTooltip name={hovered.name} lore={hovered.lore} values={hovered.values} />
						{/if}
					{/snippet}
				</MinecraftInventory>
			</div>
		</Panel>

		<Panel title={t('web.selector.notInTheGrid')} count={`${unplaced.length}`} description={t('web.selector.dragOneOntoASlot')}>
			<div class="palette">
				{#each unplaced as [name, server] (name)}
					<div
						class="chip"
						draggable="true"
						role="button"
						tabindex="0"
						ondragstart={() => {
							const inventory = document.querySelector('.chestwrap');
							void inventory;
						}}
					>
						<MinecraftItem item={server.serverIcon} size="1.5rem" fallbackLabel={name} fallbackColor={server.accentColor} />
						<span class="chipname">{name}</span>
						<Btn
							variant="link"
							onclick={() =>
								edit((next) => {
									const free = Array.from({ length: 45 }, (_, index) => index).find(
										(slot) =>
											!Object.values(next.servers).some(
												(other) => other.selector?.page === page && other.selector?.slot === slot
											)
									);

									const target = next.servers[name];

									if (target && free !== undefined) {
										target.selector = { page, slot: free, glint: false };
									}
								})}
						>
							place
						</Btn>
					</div>
				{:else}
					<p class="dim">{t('web.selector.everyServerIsOn')}</p>
				{/each}
			</div>
		</Panel>
	</div>

	<div class="right">
		<Panel flush>
			<Tabs
				tabs={[
					{ id: 'item', label: selectedName ? `Item; ${selectedName}` : 'Item' },
					{ id: 'global', label: t('web.selector.global') }
				]}
				bind:active={tab}
			/>

			<div class="tabbody">
				{#if tab === 'item'}
					{#if selectedName && selectedServer && draft}
						<MiniMessageInput
							label={t('web.selector.displayName')}
							value={selectedServer.serverDisplay ?? ''}
							hint={t('web.selector.shownInTheItemS')}
							onchange={(next) => editServer(selectedName, (server) => (server.serverDisplay = next))}
						/>

						<ColorPicker
							label={t('web.selector.accentColour')}
							value={selectedServer.accentColor ?? ''}
							onchange={(next) => editServer(selectedName, (server) => (server.accentColor = next))}
						/>

						<div class="field">
							<span class="lbl">{t('web.selector.material')}</span>
							<Select
								value={materialKey(selectedServer.serverIcon) || 'STONE'}
								options={materialOptions}
								width="100%"
								onchange={(next) => editServer(selectedName, (server) => (server.serverIcon = next))}
							/>
						</div>

						<div class="field">
							<span class="lbl">{t('web.selector.materialPerStatus')}</span>
							{#each SELECTOR_STATUSES as status (status)}
								<div class="statusrow">
									<span class="statuslabel">{status}</span>
									<Select
										value={materialKey(selectedServer.serverStatusIcons?.[status]) || ''}
										options={[{ value: '', label: t('web.selector.inherit') }, ...materialOptions]}
										width="100%"
										onchange={(next) =>
											editServer(selectedName, (server) => {
												server.serverStatusIcons = { ...(server.serverStatusIcons ?? {}) };

												if (next) {
													server.serverStatusIcons[status] = next;
												} else {
													delete server.serverStatusIcons[status];
												}
											})}
									/>
								</div>
							{/each}
						</div>

						<div class="field">
							<span class="lbl">{t('web.selector.enchantmentGlint')}</span>
							<Toggle
								checked={selectedServer.selector?.glint === true}
								onchange={(checked) =>
									editServer(selectedName, (server) => {
										server.selector = { ...server.selector!, glint: checked };
									})}
							/>
						</div>

						<!-- the same name, colour, material and description carry this server
						     on the public page, which is why the switch for it lives here
						     rather than on a screen of its own -->
						<div class="field">
							<span class="lbl">{t('web.selector.publicPage')}</span>
							<Toggle
								checked={selectedServer.publicListed === true}
								onchange={(checked) =>
									editServer(selectedName, (server) => (server.publicListed = checked))}
							/>
							<span class="hint">{t('web.selector.publicPageHint')}</span>
						</div>

						<!--
							One field, not a row per line: the lines are a paragraph an admin
							writes and re-orders, and a control per line made moving one a retype.
							A blank line is a blank lore line, which is how the templates space
							their blocks; so only an empty field is no description at all.
						-->
						<div class="field">
							<MiniMessageInput
								label={t('web.selector.description')}
								value={(selectedServer.description ?? []).join('\n')}
								multiline
								rows={6}
								baseColor="#aaaaaa"
								hint={t('web.selector.oneLinePerLoreLine')}
								onchange={(next) =>
									editServer(selectedName, (server) => {
										server.description = next === '' ? [] : next.split('\n');
									})}
							/>
						</div>

						<div class="field">
							<span class="lbl">{t('web.selector.permission')}</span>
							<input
								class="input"
								placeholder={t('web.selector.everyone')}
								value={selectedServer.selector?.permission ?? ''}
								oninput={(event) => {
									const next = (event.currentTarget as HTMLInputElement).value;
									editServer(selectedName, (server) => {
										server.selector = { ...server.selector!, permission: next };
									});
								}}
							/>
							<span class="hint">{t('web.selector.playersWithoutItSee')}</span>
						</div>

						<MiniMessageInput
							label={t('web.selector.connectMessage')}
							value={selectedServer.selector?.connectMessage ?? ''}
							hint={t('web.selector.blankUsesTheGlobalConnecting')}
							italicDefault={false}
							onchange={(next) =>
								editServer(selectedName, (server) => {
									server.selector = { ...server.selector!, connectMessage: next };
								})}
						/>

						<div class="field">
							<span class="lbl">{t('web.selector.conditionalOverrides')}</span>
							{#each selectedServer.selector?.conditional ?? [] as rule, index (index)}
								<div class="rule">
									<ConditionBuilder
										value={rule.when}
										onchange={(next) =>
											editServer(selectedName, (server) => {
												const rules = [...(server.selector?.conditional ?? [])];
												rules[index] = { ...rules[index]!, when: next };
												server.selector = { ...server.selector!, conditional: rules };
											})}
									/>

									<div class="ruleitem">
										<Select
											value={materialKey(rule.material) || ''}
											options={[{ value: '', label: t('web.selector.keepMaterial') }, ...materialOptions]}
											width="100%"
											onchange={(next) =>
												editServer(selectedName, (server) => {
													const rules = [...(server.selector?.conditional ?? [])];
													rules[index] = { ...rules[index]!, material: next || undefined };
													server.selector = { ...server.selector!, conditional: rules };
												})}
										/>
										<Btn
											variant="icon"
											title={t('web.selector.removeThisRule')}
											onclick={() =>
												editServer(selectedName, (server) => {
													const rules = [...(server.selector?.conditional ?? [])];
													rules.splice(index, 1);
													server.selector = { ...server.selector!, conditional: rules };
												})}
										>
											<Icon name="trash" style="solid" />
										</Btn>
									</div>
								</div>
							{/each}
							<Btn
								variant="link"
								onclick={() =>
									editServer(selectedName, (server) => {
										const rules = [...(server.selector?.conditional ?? [])];
										rules.push({ when: 'status == OFFLINE', material: 'RED_CONCRETE', glint: false });
										server.selector = { ...server.selector!, conditional: rules };
									})}
							>
								+ rule
							</Btn>
						</div>

						{#if selectedServer.selector?.template}
							<p class="note">
								<Icon name="lock" style="solid" /> This server carries a raw per-server template block. It is kept as-is
								{t('web.selector.andNotEditableHere')}
							</p>
						{/if}

						<Btn variant="danger" icon="upload" onclick={() => unplace(selectedName)}>
							{t('web.selector.removeFromTheGrid')}
						</Btn>
					{:else}
						<p class="dim">{t('web.selector.pickAnItemIn')}</p>
					{/if}
				{:else if draft}
					<div class="field">
						<span class="lbl">{t('web.selector.selectorEnabled')}</span>
						<Toggle
							checked={draft.global.enabled !== false}
							onchange={(checked) => edit((next) => (next.global.enabled = checked))}
						/>
					</div>

					<MiniMessageInput
						label={t('web.selector.guiTitle')}
						value={draft.global.title ?? ''}
						italicDefault={false}
						onchange={(next) => edit((updated) => (updated.global.title = next))}
					/>

					<MiniMessageInput
						label={t('web.selector.itemNameTemplate')}
						value={draft.global.template?.name ?? ''}
						hint={t('web.selector.serverDisplayIsTheServer')}
						onchange={(next) =>
							edit((updated) => {
								updated.global.template = { ...(updated.global.template ?? {}), name: next };
							})}
					/>

					<MiniMessageInput
						label={t('web.selector.bodyLine')}
						value={draft.global.template?.bodyLine ?? ''}
						hint={t('web.selector.everyDescriptionLineIsWrapped')}
						onchange={(next) =>
							edit((updated) => {
								updated.global.template = { ...(updated.global.template ?? {}), bodyLine: next };
							})}
					/>

					<div class="field">
						<span class="lbl">{t('web.selector.statusIcons')}</span>
						{#each SELECTOR_STATUSES as status (status)}
							<div class="statusrow">
								<span class="statuslabel">{status}</span>
								<input
									class="input"
									value={draft.global.statusIcons?.[status] ?? ''}
									oninput={(event) => {
										const next = (event.currentTarget as HTMLInputElement).value;
										edit((updated) => {
											updated.global.statusIcons = { ...(updated.global.statusIcons ?? {}), [status]: next };
										});
									}}
								/>
							</div>
						{/each}
					</div>

					<div class="field">
						<span class="lbl">{t('web.selector.messages')}</span>
						{#each [['opening', 'Opening'], ['offline', 'Offline'], ['maint', 'Maintenance'], ['noPermission', 'No permission'], ['connecting', 'Connecting'], ['notFound', 'Not found'], ['playerOnly', 'Player only']] as [key, label] (key)}
							<MiniMessageInput
								label={label}
								italicDefault={false}
								value={(draft.global.messages ?? {})[key as keyof typeof draft.global.messages] ?? ''}
								onchange={(next) =>
									edit((updated) => {
										updated.global.messages = { ...(updated.global.messages ?? {}), [key]: next };
									})}
							/>
						{/each}
					</div>
				{/if}
			</div>
		</Panel>
	</div>
</div>

<Modal title={t('web.selector.generatedServersYml')} bind:open={yamlOpen} wide>
	<pre class="yaml">{yamlText}</pre>
</Modal>

<Modal title={t('web.selector.importFromServersYml')} bind:open={importOpen}>
	<p>
		Reads the proxy's current <code class="inline">servers.yml</code> into cluster.json. It only saves when regenerating
		{t('web.selector.theFileReproducesThe')}
	</p>

	{#if importReport}
		<p class={importReport.equal ? 'ok' : 'bad'}>
			{importReport.equal
				? `Round-trip check passed; ${importReport.imported.length} server(s) imported.`
				: `Round-trip check failed on ${importReport.diff.length} path(s).`}
		</p>

		{#each importReport.warnings as warning (warning)}
			<p class="dim">{warning}</p>
		{/each}

		{#each importReport.diff.slice(0, 10) as line (line)}
			<p class="mono">{line}</p>
		{/each}
	{/if}

	{#snippet footer()}
		<Btn onclick={() => runImport(false)} loading={busy === 'import'}>{t('web.selector.import')}</Btn>
		{#if importReport && !importReport.equal}
			<Btn variant="danger" onclick={() => runImport(true)}>{t('web.selector.importAnyway')}</Btn>
		{/if}
	{/snippet}
</Modal>

<Modal title={t('web.selector.applyingTheSelector')} bind:open={applyOpen}>
	<ProgressTree root={applyJob?.progress ?? null} state={applyJob?.state} />
</Modal>

<style lang="scss">
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 24rem);
		gap: 1rem;
		align-items: start;

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.left,
	.right {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
	}

	.pages {
		display: flex;
		gap: 0.25rem;
		margin-bottom: 0.75rem;
	}

	.chestwrap {
		position: relative;
	}

	.palette {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.chip {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.5rem;
		border: var(--hairline) solid var(--border-divider);
		border-radius: var(--radius-button);
		background: var(--bg-panel-raised);
		cursor: grab;
	}

	.chipname {
		font-weight: 700;
	}

	.tabbody {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 1rem;
	}

	.statusrow {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}

	.statuslabel {
		width: 4.5rem;
		flex: none;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	// the zoom sits with the status switch in the panel's action row
	.zoom {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
	}

	.rule {
		margin-bottom: 0.75rem;
		padding: 0.5rem;
		border: var(--hairline) solid var(--border-divider);
		border-radius: var(--radius-input);
	}

	.ruleitem {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin-top: 0.5rem;
	}

	.note {
		padding: 0.5rem;
		border-radius: var(--radius-input);
		background: var(--bg-panel-raised);
		color: var(--text-secondary);
		font-size: 0.8125rem;
	}

	.banner,
	.issues {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin-bottom: 1rem;
		padding: 0.75rem 1rem;
		border-radius: var(--radius-container);
		background: var(--bg-panel);
		font-size: 0.8125rem;
	}

	.banner {
		flex-direction: row;
		align-items: center;
		gap: 0.5rem;
	}

	.issues p {
		margin: 0;
	}

	.issues.hasErrors {
		box-shadow: inset 0.1875rem 0 0 var(--error);
	}

	.link {
		@include bare-button;

		color: var(--link);
		text-decoration: underline;
	}

	.yaml {
		max-height: 60vh;
		overflow: auto;
		padding: 0.75rem;
		border-radius: var(--radius-input);
		background: var(--bg-terminal);
		font-family: var(--font-mono);
		font-size: 0.75rem;
	}

	.ok {
		color: var(--success);
	}

	.bad {
		color: var(--error);
	}
</style>
