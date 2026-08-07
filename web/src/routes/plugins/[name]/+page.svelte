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
	import { api, post } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Select from '$lib/components/Select.svelte';
	import MultiAddModal from '$lib/components/MultiAddModal.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import BrandLink from '$lib/components/BrandLink.svelte';
	import IdentifyAddonModal from '$lib/components/IdentifyAddonModal.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import DataTable from '$lib/components/DataTable.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import Icon from '$lib/components/Icon.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * One plugin identity in full: its families (one pooled build per platform),
	 * every pooled version of each family with its MC support and who runs it,
	 * cluster-wide usage, and the tools; pin/upgrade versions per instance,
	 * force-add to an instance, disable anywhere (overrides win over groups).
	 */

	/** how many MC versions a pin option lists before it trails off */
	const MC_LABEL_LIMIT = 6;

	/** how many MC versions the version table shows before the rest collapse to a count */
	const MC_CELL_LIMIT = 10;

	const name = $derived(page.params.name);

	let data: any = $state(null);
	let tab = $state('overview');
	let familySel = $state('');
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let busy = $state('');

	let addOpen = $state(false);

	// provider mapping, per family: each family build is its own lock entry, so
	// "which project is this?" is asked about one jar at a time
	let identifyOpen = $state(false);
	let identifyKey = $state('');
	let identifyFamily: PluginFamily = $state('paper');
	let identifyMapped = $state(false);

	/** Open the mapping dialog for one family build. */
	function openIdentify(family: { key: string; family: string; remote?: unknown }): void {
		identifyKey = family.key;
		identifyFamily = family.family as PluginFamily;
		identifyMapped = !!family.remote;
		identifyOpen = true;
	}

	let pinOpen = $state(false);
	let pinEntry = $state('');
	let pinVersions: any[] = $state([]);
	let pinVersion = $state('');
	let pinTargets: string[] = $state([]);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			data = await api(`/plugins/${name}`);
			lastUpdated = Date.now();

			if (!familySel && data.families.length) {
				familySel = data.families[0].key;
			}
		} catch (err) {
			Notify.error(`Could not load ${name}`, { detail: (err as Error).message });
		}

		loading = false;
	}

	onMount(() => {
		void refresh();
	});

	const selFamily = $derived(
		data?.families.find((family: any) => family.key === familySel) ?? data?.families[0]
	);

	/** Instances an entry's version reaches (pin > assign > primary). */
	function versionUsers(family: any, versionNumber: string): string[] {
		return family.effective.filter((instance: string) => {
			const assigned =
				family.pins[instance] ?? family.assign[instance] ?? family.installed?.versionNumber;

			return assigned === versionNumber;
		});
	}

	/** Run a plugin operation behind a loading flash. */
	async function run(label: string, pending: string, fn: () => Promise<string>): Promise<void> {
		busy = label;

		const note = Notify.loading(pending);

		try {
			const detail = await fn();

			note.set({ level: 'success', message: t('web.addonDetail.done'), detail, closeable: true });

			await refresh();
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

	const deployAll = () =>
		run('deploy', `Deploying ${name}…`, async () => {
			let changed = 0;

			for (const family of data.families) {
				const res = await post('/plugins/deploy', { plugin: family.key });

				changed += res.actions.filter((action: any) => action.action !== 'unchanged').length;
			}

			return `${changed} change(s) across ${data.families.length} family build(s).`;
		});

	const updateNow = () =>
		run('update', `Updating ${name} to the newest compatible versions…`, async () => {
			const res = await post('/plugins/update', {
				names: data.families.map((family: any) => family.key),
				deploy: true
			});

			if (!res.applied.length) {
				return 'Everything already runs the newest compatible version.';
			}

			return res.applied
				.map((entry: any) => `${entry.name} → ${entry.version} (${entry.targets.join(', ')})`)
				.join('; ');
		});

	/** Force-add / disable / re-enable through the per-instance override. */
	const setOverride = (instance: string, state: boolean | null, verb: string) =>
		run(`ovr-${instance}`, `${verb} ${name} on ${instance}…`, async () => {
			const res = await post(`/instances/${instance}/plugins`, { plugin: name, state });

			if (res.removed?.length) {
				return `Removed ${res.removed.join(', ')}; a running server keeps it loaded until restart.`;
			}

			return res.deployed ? `${res.deployed} deploy change(s).` : '';
		});

	/** Force-add this plugin to several instances at once (the Add popup's confirm). */
	const addToInstances = (instances: string[]) =>
		run('ovr-add', `Adding ${name} to ${instances.join(', ')}…`, async () => {
			let deployed = 0;

			for (const instance of instances) {
				const res = await post(`/instances/${instance}/plugins`, { plugin: name, state: true });

				deployed += res.deployed ?? 0;
			}

			return `${deployed} deploy change(s); running servers load it on restart.`;
		});

	async function openPin(family: any): Promise<void> {
		if (!family?.remote) {
			return;
		}

		pinOpen = true;
		pinEntry = family.key;
		pinVersions = [];
		pinTargets = [...family.effective];
		pinVersions = (await api(`/plugins/pin?name=${family.key}`)).versions;
		pinVersion = pinVersions[0]?.versionNumber ?? '';
	}

	const doPin = () =>
		run('pin', `Pinning ${pinEntry} to ${pinVersion}…`, async () => {
			await post('/plugins/pin', { name: pinEntry, version: pinVersion, targets: pinTargets });
			await post('/plugins/deploy', { plugin: pinEntry });

			pinOpen = false;

			return `Pinned on ${pinTargets.join(', ')} and deployed.`;
		});

	const doUnpin = (family: any) =>
		run('unpin', `Unpinning ${family.key}…`, async () => {
			await post('/plugins/unpin', { name: family.key });

			return 'Run Update to re-resolve versions.';
		});

	function toggleTarget(target: string): void {
		pinTargets = pinTargets.includes(target)
			? pinTargets.filter((entry) => entry !== target)
			: [...pinTargets, target];
	}

	const overviewCells: InfoCell[] = $derived.by(() => {
		if (!data) {
			return [];
		}

		const meta = data.families.find((family: any) => family.meta)?.meta ?? {};

		return [
			{ label: t('web.addonDetail.plugin'), value: data.plugin },
			{ label: t('web.addonDetail.families'), value: data.families.map((family: any) => family.family).join(', ') },
			{
				label: t('web.addonDetail.inGroups'),
				value: data.groups.join(', ') || '(none)'
			},
			{ label: t('web.addonDetail.authors'), value: meta.authors?.join(', ') ?? null },
			{
				label: t('web.addonDetail.description'),
				value: meta.description ?? null,
				colSpan: 2
			},
			{
				label: t('web.addonDetail.usedBy'),
				value:
					data.usage
						.filter((row: any) => !row.disabled)
						.map((row: any) => row.instance)
						.join(', ') || '(nowhere)',
				colSpan: 2
			}
		];
	});

	const usageCols: Column[] = $derived([
		{ id: 'instance', label: t('web.addonDetail.instance2'), sortable: true },
		{ id: 'state', label: t('web.addonDetail.instanceState'), width: 140 },
		{ id: 'env', label: t('web.addonDetail.environment') },
		{ id: 'family', label: t('web.addonDetail.family'), width: 110 },
		{ id: 'version', label: t('web.addonDetail.runsVersion') },
		{ id: 'origin', label: t('web.addonDetail.from') }
	]);

	/**
	 * One instance's verbs for this plugin. A row that is dimmed because the
	 * plugin is disabled there is exactly the row whose menu matters, which is
	 * why the menu; not a column of buttons; carries them.
	 */
	function usageActions(row: any): ContextMenuItem[] {
		const enable = {
			label: `Enable on ${row.instance}`,
			icon: 'circleCheck',
			disabled: !!busy,
			action: () => setOverride(row.instance, null, 'Re-enabling')
		};

		const remove = {
			label: `Remove from ${row.instance}`,
			icon: 'trash',
			color: 'danger' as const,
			disabled: !!busy,
			action: () => setOverride(row.instance, null, 'Removing')
		};

		const disable = {
			label: `Disable on ${row.instance}`,
			icon: 'ban',
			color: 'danger' as const,
			disabled: !!busy,
			hint: t('web.addonDetail.disablesItOnThisInstance'),
			action: () => setOverride(row.instance, false, 'Disabling')
		};

		return [
			row.disabled ? enable : row.origin === 'manual' ? remove : disable,
			{ separator: true },
			{
				label: t('web.addonDetail.openOnThisInstance'),
				icon: 'circleInfo',
				action: () => goto(`/instances/${row.instance}/plugins/${data.plugin}`)
			},
			{
				label: t('web.addonDetail.openInstance'),
				icon: 'server',
				action: () => goto(`/instances/${row.instance}`)
			}
		];
	}

	const familyCols: Column[] = $derived([
		{ id: 'family', label: t('web.addonDetail.family'), width: 130 },
		{ id: 'key', label: t('web.addonDetail.lockEntry') },
		{ id: 'display', label: t('web.addonDetail.displayName') },
		{ id: 'version', label: t('web.addonDetail.primaryVersion') },
		{ id: 'variants', label: t('web.addonDetail.pooledVariants'), width: 130, align: 'right' },
		{ id: 'source', label: t('web.addonDetail.source') }
	]);

	const versionCols: Column[] = $derived([
		{ id: 'kind', label: t('web.addonDetail.kind'), width: 100 },
		{ id: 'version', label: t('web.addonDetail.version'), width: 160 },
		{ id: 'mc', label: t('web.addonDetail.supportsMc'), width: 340 },
		{ id: 'source', label: t('web.addonDetail.source'), width: 140 },
		{ id: 'usedBy', label: t('web.addonDetail.usedBy') }
	]);

	/** A long MC-support list collapses to its newest entries plus a count. */
	function mcLabel(versions: string[]): string {
		if (!versions.length) {
			return 'unknown';
		}

		if (versions.length <= MC_CELL_LIMIT) {
			return versions.join(', ');
		}

		const newest = versions.slice(-MC_CELL_LIMIT).reverse();

		return `${newest.join(', ')} + ${versions.length - MC_CELL_LIMIT} older`;
	}

	const versionRows = $derived.by(() => {
		if (!selFamily) {
			return [];
		}

		const rows = [];

		if (selFamily.installed) {
			rows.push({
				kind: 'primary',
				version: selFamily.installed.versionNumber ?? '?',
				mc: selFamily.installed.gameVersions,
				url: selFamily.installed.url,
				usedBy: versionUsers(selFamily, selFamily.installed.versionNumber)
			});
		}

		for (const variant of selFamily.variants) {
			rows.push({
				kind: 'variant',
				version: variant.versionNumber,
				mc: variant.gameVersions,
				url: variant.url,
				usedBy: versionUsers(selFamily, variant.versionNumber)
			});
		}

		return rows;
	});

	// instances whose software fits some family and that don't already run/disable it
	const addable = $derived.by(() => {
		if (!data) {
			return [];
		}

		const used = new Set(data.usage.map((row: any) => row.instance));

		return data.instances.filter((inst: any) => {
			if (used.has(inst.name)) {
				return false;
			}

			return data.families.some(
				(family: any) => family.family === 'universal' || family.family === inst.software
			);
		});
	});

	const USAGE_STATE: Record<string, string> = {
		running: 'running',
		starting: 'starting',
		stopped: 'stopped'
	};

	// an addon whose every build is a mod is a mod, and the page says so; the
	// route is shared because the identity is, not because the kinds are
	const kindLabel = $derived(
		data?.families?.length &&
			data.families.every((family: any) => FAMILY_DIRS[family.family as PluginFamily] === 'mods')
			? 'Mods'
			: 'Plugins'
	);
</script>

<svelte:head><title>{name} | {kindLabel} | Luna Console</title></svelte:head>

{#if data}
	<PageHeader title={data.plugin} info>
		{#snippet extra()}
			{#each data.families as family (family.key)}
				<StatusBadge state="ok" label={family.family} />
			{/each}
		{/snippet}
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="plugin-info" />
			<Btn
				icon="download"
				loading={busy === 'update'}
				disabled={!!busy || !data.families.some((family: any) => family.remote)}
				onclick={updateNow}
			>
				Update
			</Btn>
			<Btn icon="upload" loading={busy === 'deploy'} disabled={!!busy} onclick={deployAll}>
				Deploy
			</Btn>
		{/snippet}
	</PageHeader>

	<Tabs
		tabs={[
			{ id: 'overview', label: t('web.addonDetail.overview') },
			{ id: 'usage', label: t('web.addonDetail.instanceUsage') },
			{ id: 'families', label: t('web.addonDetail.familiesVersions') }
		]}
		bind:active={tab}
	/>

	<div class="tabbody">
		{#if tab === 'overview'}
			<Panel title="{kindLabel.slice(0, -1)} summary">
				<InfoGrid cells={overviewCells} />
			</Panel>
			<div class="gap"></div>
			{#each data.families as family (family.key)}
				<Panel
					title="{family.family} build; {family.key}"
					description={family.meta?.description ?? `Pool file ${family.file}`}
				>
					{#snippet actions()}
						<Btn
							icon="link"
							disabled={family.source === 'luna' || !!busy}
							onclick={() => openIdentify(family)}
						>
							{family.remote ? 'Change provider mapping…' : 'Map to a provider…'}
						</Btn>
					{/snippet}
					<InfoGrid
						cells={[
							{ label: t('web.addonDetail.displayName'), value: family.displayName },
							{ id: `src-${family.key}`, label: t('web.addonDetail.source') },
							{ label: t('web.addonDetail.primaryVersion'), value: family.installed?.versionNumber ?? '?', style: 'mono' },
							{ label: t('web.addonDetail.declaredVersion'), value: family.meta?.version ?? null, style: 'mono' },
							{ label: t('web.addonDetail.updateChannel'), value: family.channel },
							{ label: t('web.addonDetail.autoUpdate'), value: family.autoUpdate ? 'Enabled' : 'Disabled' },
							{ label: t('web.addonDetail.authors'), value: family.meta?.authors?.join(', ') ?? null },
							{ id: `web-${family.key}`, label: t('web.addonDetail.website') },
							{ label: t('web.addonDetail.apiVersion'), value: family.meta?.apiVersion ?? null },
							{ label: t('web.addonDetail.poolFile'), value: family.file, copyable: true, style: 'mono' },
							{ label: t('web.addonDetail.configTemplateOps'), value: String(family.configOps) },
							{ label: t('web.addonDetail.deploysTo'), value: family.effective.join(', ') || '(nowhere)', colSpan: 2 }
						]}
					>
						{#snippet custom(cell)}
							{#if cell.id === `src-${family.key}`}
								<BrandLink source={family.source} href={family.url} />
							{:else if cell.id === `web-${family.key}`}
								{#if family.meta?.website}
									<a href={family.meta.website} target="_blank" rel="noreferrer">
										{family.meta.website.replace(/^https?:\/\//, '')}
										<Icon name="externalLink" size="0.625rem" />
									</a>
								{:else}
									<span class="dim">–</span>
								{/if}
							{/if}
						{/snippet}
					</InfoGrid>
				</Panel>
				<div class="gap"></div>
			{/each}
		{:else if tab === 'usage'}
			<Panel
				title="Instances using {data.plugin}"
				count={data.usage.length}
				description={t('web.addonDetail.overridesWinOverGroupsDisabling')}
				flush
			>
				{#snippet actions()}
					<Btn icon="plus" disabled={!!busy} onclick={() => (addOpen = true)}>
						{t('web.addonDetail.addToInstances')}
					</Btn>
				{/snippet}
				<ResourceTable
					tableId="plugin-usage"
					columns={usageCols}
					rows={data.usage}
					getId={(row) => row.instance}
					searchValue={(row) => `${row.instance} ${row.origin ?? ''} ${row.version ?? ''}`}
					searchPlaceholder={t('web.addonDetail.findAnInstance')}
					searchWidth="18rem"
					noun={t('web.addonDetail.instance')}
					pageSize={15}
					rowActions={usageActions}
					rowLabel={(row) => row.instance}
					rowDim={(row) => row.disabled}
					emptyTitle={t('web.addonDetail.notUsedAnywhere')}
					emptyText={t('web.addonDetail.addItToAnInstance')}
				>
					{#snippet cell(row, col)}
						{@const status = data.instances.find((inst: any) => inst.name === row.instance)}
						{#if col === 'instance'}
							<a href="/instances/{row.instance}/plugins/{data.plugin}">{row.instance}</a>
						{:else if col === 'state'}
							<StatusBadge state={USAGE_STATE[status?.state] ?? 'unknown'} />
						{:else if col === 'env'}
							{row.software}{row.mcVersion ? ` ${row.mcVersion}` : ''}
						{:else if col === 'family'}
							{row.family}
						{:else if col === 'version'}
							{#if row.disabled}
								<span class="dim">{t('web.addonDetail.disabled')}</span>
							{:else}
								<span class="mono">{row.version ?? '?'}</span>
								{#if row.pinned}
									<span class="pin"><Icon name="tag" size="0.75rem" /> {t('web.addonDetail.pinned')}</span>
								{:else if row.variant}
									<span class="variant">{t('web.addonDetail.variant')}</span>
								{/if}
							{/if}
						{:else if col === 'origin'}
							{#if row.origin === 'manual'}
								<span class="manual">{t('web.addonDetail.manual')}</span>
							{:else if row.origin === 'group'}
								<span class="dim">{row.groups.join(', ')}</span>
							{:else}
								<span class="dim">{t('web.addonDetail.explicit')}</span>
							{/if}
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
		{:else}
			<Panel title={t('web.addonDetail.families')} count={data.families.length} flush>
				<DataTable
					columns={familyCols}
					rows={data.families}
					getId={(family) => family.key}
					onRowClick={(family) => (familySel = family.key)}
				>
					{#snippet cell(family, col)}
						{#if col === 'family'}
							<b class:sel={family.key === familySel}>{family.family}</b>
						{:else if col === 'key'}
							<span class="mono">{family.key}</span>
						{:else if col === 'display'}
							{family.displayName}
						{:else if col === 'version'}
							<span class="mono">{family.installed?.versionNumber ?? '?'}</span>
						{:else if col === 'variants'}
							{family.variants.length}
						{:else if col === 'source'}
							<BrandLink source={family.source} href={family.url} />
						{/if}
					{/snippet}
				</DataTable>
			</Panel>
			<div class="gap"></div>
			{#if selFamily}
				<Panel
					title="Versions of {selFamily.key}"
					count={versionRows.length}
					description={t('web.addonDetail.pooledBuildsOfTheSelected')}
					flush
				>
					{#snippet actions()}
						<Btn
							icon="tag"
							disabled={!selFamily.remote || !!busy}
							onclick={() => openPin(selFamily)}
						>
							{t('web.addonDetail.pinAVersion')}
						</Btn>
						<Btn
							icon="unlink"
							disabled={!Object.keys(selFamily.pins).length || !!busy}
							loading={busy === 'unpin'}
							onclick={() => doUnpin(selFamily)}
						>
							{t('web.addonDetail.unpinAll')}
						</Btn>
					{/snippet}
					<DataTable columns={versionCols} rows={versionRows} getId={(row) => row.version}>
						{#snippet cell(row, col)}
							{#if col === 'kind'}
								<span style="color:{row.kind === 'primary' ? 'var(--success)' : 'var(--warning)'}">
									{row.kind}
								</span>
							{:else if col === 'version'}
								<span class="mono">{row.version}</span>
							{:else if col === 'mc'}
								<span class="dim mcs" title={row.mc.join(', ')}>{mcLabel(row.mc)}</span>
							{:else if col === 'source'}
								{#if row.url}
									<BrandLink source={selFamily.source} href={row.url} />
								{:else if selFamily.luna}
									<BrandLink source="luna" label="luna · {selFamily.luna.module}" />
								{:else}
									<BrandLink source={selFamily.source} />
								{/if}
							{:else if col === 'usedBy'}
								{#if row.usedBy.length}
									{#each row.usedBy as instance, index}
										{#if index > 0},&nbsp;{/if}
										<a href="/instances/{instance}">{instance}</a>
									{/each}
								{:else}
									<span class="dim">–</span>
								{/if}
							{/if}
						{/snippet}
					</DataTable>
				</Panel>
			{/if}
		{/if}
	</div>
{/if}

<MultiAddModal
	bind:open={addOpen}
	title="Add {data?.plugin ?? name} to instances"
	description={t('web.addonDetail.forceAddedAsAPer')}
	selectLabel="Instances"
	options={addable.map((inst: any) => inst.name)}
	busy={busy === 'ovr-add'}
	onconfirm={(instances) => void addToInstances(instances)}
/>

<!-- map an unidentified build to the project it came from -->
<IdentifyAddonModal
	bind:open={identifyOpen}
	kind={FAMILY_DIRS[identifyFamily] === 'mods' ? 'mod' : 'plugin'}
	target={identifyKey}
	family={identifyFamily}
	mapped={identifyMapped}
	onchanged={refresh}
/>

<!-- pin modal -->
<Modal title="Pin {pinEntry} to a version" bind:open={pinOpen}>
	{#if !pinVersions.length}
		<span class="dim">{t('web.addonDetail.loadingVersions')}</span>
	{:else}
		<div class="field">
			<span class="lbl">{t('web.addonDetail.version')}</span>
			<Select
				bind:value={pinVersion}
				width="100%"
				options={pinVersions.map((version) => ({
					value: version.versionNumber,
					label: `${version.versionNumber} (${version.channel}); MC ${version.gameVersions
						.slice(0, MC_LABEL_LIMIT)
						.join(', ')}${version.gameVersions.length > MC_LABEL_LIMIT ? '…' : ''}`
				}))}
			/>
		</div>
		<div class="tgtlbl">{t('web.addonDetail.onInstances')}</div>
		<div class="targets">
			{#each selFamily?.effective ?? [] as target}
				<label class="tchk">
					<Checkbox
						checked={pinTargets.includes(target)}
						label="Pin on {target}"
						onchange={() => toggleTarget(target)}
					/>
					{target}
				</label>
			{/each}
		</div>
	{/if}
	{#snippet footer()}
		<Btn onclick={() => (pinOpen = false)}>{t('web.addonDetail.cancel')}</Btn>
		<Btn
			variant="primary"
			disabled={!pinVersion || !pinTargets.length}
			loading={busy === 'pin'}
			onclick={doPin}
		>
			{t('web.addonDetail.pinDeploy')}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.tabbody {
		margin-top: 1rem;
	}

	.gap {
		height: 1rem;
	}

	// a plugin can list a hundred supported MC versions; the cell shows the newest
	.mcs {
		display: inline-block;
		max-width: 100%;
		@include ellipsis;
	}

	.sel {
		color: var(--link);
	}

	.pin {
		color: #bf7edb;
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		margin-left: 0.375rem;
	}

	.variant {
		color: var(--warning);
		font-size: 0.75rem;
		margin-left: 0.375rem;
	}

	.manual {
		color: var(--link);
		font-size: 0.8125rem;
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
