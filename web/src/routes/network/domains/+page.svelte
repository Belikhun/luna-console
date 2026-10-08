<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { api, del, patch, post } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Tabs from '$lib/components/Tabs.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import Select from '$lib/components/Select.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';
	import type { AuditRow, HostnameRow, RecordRow, SettingsView } from './domains';

	/**
	 * Hostnames under the network's base domain: which exist, which instance each
	 * routes to (a velocity forced host), the live DNS records under the base and
	 * what was changed. Modded servers are reached this way, since their clients
	 * cannot pass through the vanilla lobby.
	 */

	let settings: SettingsView | null = $state(null);
	let hostnames: HostnameRow[] = $state([]);
	let audit: AuditRow[] = $state([]);
	let instances: string[] = $state([]);
	let records: RecordRow[] = $state([]);
	let recordsZone = $state('');
	let recordsLoading = $state(false);
	let recordsLoaded = $state(false);
	let recordsError: string | null = $state(null);

	let loading = $state(false);
	let loaded = $state(false);
	let lastUpdated: number | null = $state(null);
	let tab = $state(page.url.searchParams.get('tab') ?? 'hostnames');
	let selected: Set<string> = $state(new Set());
	let busy = $state(false);

	let createOpen = $state(false);
	let createLabel = $state('');
	let createInstance = $state('');
	let createAddress = $state('');
	let createAdopt = $state(false);

	let linkOpen = $state(false);
	let linkRow: HostnameRow | null = $state(null);
	let linkInstance = $state('');

	let pointOpen = $state(false);
	let pointRow: HostnameRow | null = $state(null);
	let pointAddress = $state('');

	let deleteOpen = $state(false);
	let deleteRows: HostnameRow[] = $state([]);

	let unlinkOpen = $state(false);
	let unlinkRows: HostnameRow[] = $state([]);

	let settingsOpen = $state(false);
	let formApiUser = $state('');
	let formUserName = $state('');
	let formClientIp = $state('');
	let formApiKey = $state('');
	let formSandbox = $state(false);
	let formBase = $state('');
	let formAddress = $state('');
	let formTtl = $state('300');
	let formDrop = $state(false);
	let checkResult: { ok: boolean; error?: string; zone: string | null; domains: { name: string }[] } | null = $state(null);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api('/domains');

			settings = data.settings;
			hostnames = data.hostnames;
			instances = data.instances;
			// a deleted hostname must not stay selected, or the Actions menu targets a ghost
			selected = new Set([...selected].filter((fqdn) => hostnames.some((row) => row.fqdn === fqdn)));
			audit = data.audit.map((entry: Omit<AuditRow, 'key'>, index: number) => ({ ...entry, key: `${entry.t}-${index}` }));
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.domains.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
			loaded = true;
		}

		if (tab === 'records' && settings?.configured) {
			void loadRecords();
		}
	}

	async function loadRecords(): Promise<void> {
		recordsLoading = true;
		recordsError = null;

		try {
			const data = await api('/domains/records');

			recordsZone = data.zone;
			records = data.records.map((record: Omit<RecordRow, 'key'>, index: number) => ({ ...record, key: `${record.name}-${record.type}-${index}` }));
		} catch (err) {
			recordsError = (err as Error).message;
		} finally {
			recordsLoading = false;
			recordsLoaded = true;
		}
	}

	onMount(() => {
		void refresh();
	});

	$effect(() => {
		if (tab === 'records' && settings?.configured && !recordsLoaded && !recordsLoading && !recordsError) {
			void loadRecords();
		}
	});

	const picked = $derived(hostnames.filter((row) => selected.has(row.fqdn)));
	const linkedCount = $derived(hostnames.filter((row) => row.instance).length);
	const instanceOptions = $derived(instances.map((name) => ({ value: name, label: name })));
	const createInstanceOptions = $derived([
		{ value: '', label: t('web.domains.noInstance') },
		...instanceOptions
	]);

	async function runBulk(rows: HostnameRow[], verb: string, run: (row: HostnameRow) => Promise<unknown>): Promise<void> {
		if (rows.length === 0) {
			return;
		}

		const failed: string[] = [];

		for (const row of rows) {
			try {
				await run(row);
			} catch (err) {
				failed.push(`${row.fqdn}: ${(err as Error).message}`);
			}
		}

		const done = rows.length - failed.length;

		if (failed.length === 0) {
			Notify.success(t('web.domains.bulkDone', { verb, count: done }));
		} else if (done === 0) {
			Notify.error(t('web.domains.bulkFailed', { verb }), { detail: failed.join('\n') });
		} else {
			Notify.warning(t('web.domains.bulkPartial', { verb, done, failed: failed.length }), { detail: failed.join('\n') });
		}

		records = [];
		recordsLoaded = false;
		await refresh();
	}

	function openCreate(): void {
		createLabel = '';
		createInstance = '';
		createAddress = '';
		createAdopt = false;
		createOpen = true;
	}

	async function createConfirmed(): Promise<void> {
		busy = true;

		try {
			const result = await post('/domains', {
				name: createLabel.trim(),
				instance: createInstance || undefined,
				address: createAddress.trim() || undefined,
				adopt: createAdopt
			});

			Notify.success(t('web.domains.created', { fqdn: result.hostname.fqdn }));
			createOpen = false;
			records = [];
			recordsLoaded = false;
			await refresh();
		} catch (err) {
			Notify.error(t('web.domains.createFailed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}

	function openLink(row: HostnameRow): void {
		linkRow = row;
		linkInstance = row.instance ?? instances[0] ?? '';
		linkOpen = true;
	}

	async function linkConfirmed(): Promise<void> {
		if (!linkRow || !linkInstance) {
			return;
		}

		busy = true;

		try {
			await post(`/domains/${encodeURIComponent(linkRow.fqdn)}/link`, { instance: linkInstance });
			Notify.success(t('web.domains.linked', { fqdn: linkRow.fqdn, instance: linkInstance }));
			linkOpen = false;
			await refresh();
		} catch (err) {
			Notify.error(t('web.domains.linkFailed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}

	function openPoint(row: HostnameRow): void {
		pointRow = row;
		pointAddress = row.address;
		pointOpen = true;
	}

	async function pointConfirmed(): Promise<void> {
		if (!pointRow) {
			return;
		}

		busy = true;

		try {
			await patch(`/domains/${encodeURIComponent(pointRow.fqdn)}`, { address: pointAddress.trim() });
			Notify.success(t('web.domains.pointed', { fqdn: pointRow.fqdn, address: pointAddress.trim() }));
			pointOpen = false;
			records = [];
			recordsLoaded = false;
			await refresh();
		} catch (err) {
			Notify.error(t('web.domains.pointFailed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}

	function openSettings(): void {
		formApiUser = settings?.provider?.apiUser ?? '';
		formUserName = settings?.provider?.userName ?? '';
		formClientIp = settings?.provider?.clientIp ?? '';
		formApiKey = '';
		formSandbox = settings?.provider?.sandbox ?? false;
		formBase = settings?.baseDomain ?? '';
		formAddress = settings?.publicAddress ?? '';
		formTtl = String(settings?.ttl ?? 300);
		formDrop = settings?.dropUnsupported ?? false;
		checkResult = null;
		settingsOpen = true;
	}

	async function saveSettings(): Promise<boolean> {
		busy = true;

		try {
			const providerTouched = formApiUser.trim() || formApiKey.trim() || settings?.provider;

			settings = await patch('/domains/settings', {
				...(providerTouched
					? {
						provider: {
							apiUser: formApiUser.trim(),
							userName: formUserName.trim(),
							clientIp: formClientIp.trim(),
							apiKey: formApiKey.trim(),
							sandbox: formSandbox
						}
					}
					: {}),
				baseDomain: formBase.trim(),
				publicAddress: formAddress.trim() || null,
				ttl: Number(formTtl),
				dropUnsupported: formDrop
			});

			formApiKey = '';

			return true;
		} catch (err) {
			Notify.error(t('web.domains.settingsFailed'), { detail: (err as Error).message });

			return false;
		} finally {
			busy = false;
		}
	}

	async function saveAndCheck(): Promise<void> {
		if (!(await saveSettings())) {
			return;
		}

		busy = true;

		try {
			checkResult = await post('/domains/check');
		} finally {
			busy = false;
		}

		records = [];
		recordsLoaded = false;
		await refresh();
	}

	async function saveAndClose(): Promise<void> {
		if (await saveSettings()) {
			Notify.success(t('web.domains.settingsSaved'));
			settingsOpen = false;
			records = [];
			recordsLoaded = false;
			await refresh();
		}
	}

	function hostnameActions(rows: HostnameRow[]): ContextMenuItem[] {
		const one = rows.length === 1 ? rows[0] : undefined;
		const linked = rows.filter((row) => row.instance);

		return [
			{
				label: t('web.domains.linkAction'),
				icon: 'link',
				disabled: !one,
				hint: one ? undefined : t('web.domains.pickOne'),
				action: () => openLink(one!)
			},
			{
				label: t('web.domains.pointAction'),
				icon: 'pen',
				disabled: !one,
				hint: one ? undefined : t('web.domains.pickOne'),
				action: () => openPoint(one!)
			},
			{
				label: t('web.domains.unlinkAction', { count: linked.length }),
				icon: 'linkHorizontalSlash',
				color: 'warning',
				disabled: linked.length === 0,
				hint: linked.length ? undefined : t('web.domains.noneLinked'),
				action: () => {
					unlinkRows = linked;
					unlinkOpen = true;
				}
			},
			{ separator: true },
			{
				label: t('web.domains.deleteAction', { count: rows.length }),
				icon: 'trash',
				color: 'danger',
				disabled: rows.length === 0,
				action: () => {
					deleteRows = rows;
					deleteOpen = true;
				}
			}
		];
	}

	function rowActions(row: HostnameRow): ContextMenuItem[] {
		return hostnameActions(selected.has(row.fqdn) && picked.length > 1 ? picked : [row]);
	}

	const hostnameColumns: Column[] = $derived([
		{ id: 'fqdn', label: t('web.domains.colHostname'), sortable: true, width: 280 },
		{ id: 'instance', label: t('web.domains.colInstance'), sortable: true, width: 180 },
		{ id: 'address', label: t('web.domains.colAddress'), sortable: true, width: 160 },
		{ id: 'by', label: t('web.domains.colBy'), sortable: true, width: 160 },
		{ id: 'created', label: t('web.domains.colCreated'), sortable: true, width: 180 }
	]);

	const hostnameFilters: TableFilterGroup<HostnameRow>[] = $derived([
		{
			id: 'link',
			label: t('web.domains.filterLink'),
			options: [
				{ value: 'any', label: t('web.domains.anyLink') },
				{ value: 'linked', label: t('web.domains.linkedOnly'), match: (row) => Boolean(row.instance) },
				{ value: 'unlinked', label: t('web.domains.unlinkedOnly'), match: (row) => !row.instance }
			]
		}
	]);

	const recordColumns: Column[] = $derived([
		{ id: 'name', label: t('web.domains.colName'), sortable: true, width: 260 },
		{ id: 'type', label: t('web.domains.colType'), sortable: true, width: 100 },
		{ id: 'address', label: t('web.domains.colValue'), sortable: true },
		{ id: 'ttl', label: t('web.domains.colTtl'), sortable: true, width: 100 },
		{ id: 'managed', label: t('web.domains.colManaged'), sortable: true, width: 140 }
	]);

	const auditColumns: Column[] = $derived([
		{ id: 'when', label: t('web.domains.colWhen'), sortable: true, width: 180 },
		{ id: 'action', label: t('web.domains.colAction'), sortable: true, width: 210 },
		{ id: 'actor', label: t('web.domains.colBy'), sortable: true, width: 170 },
		{ id: 'hostname', label: t('web.domains.colHostname'), sortable: true, width: 260 },
		{ id: 'detail', label: t('web.domains.colDetail') }
	]);

	/** Whether a record is the one luna wrote for a hostname it manages. */
	function managedRecord(record: RecordRow): boolean {
		if (!settings || record.type !== 'A') {
			return false;
		}

		const fqdn = `${record.name}.${recordsZone}`.toLowerCase();

		return hostnames.some((row) => row.fqdn === fqdn);
	}

	function auditTone(action: string): string {
		return action.endsWith('delete') || action.endsWith('unlink')
			? 'warning'
			: 'info';
	}
</script>

<svelte:head><title>{t('web.nav.domains')} | Luna Console</title></svelte:head>

<PageHeader title={t('web.nav.domains')} count={hostnames.length} description={t('web.domains.pageDescription')} info>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="network-domains" />
		<Dropdown label={t('web.common.actions')} disabled={tab !== 'hostnames' || picked.length === 0} menu={hostnameActions(picked)} />
		<Btn icon="gear" onclick={openSettings}>{t('web.domains.settings')}</Btn>
		<Btn variant="primary" icon="plus" disabled={!settings?.configured} onclick={openCreate}>{t('web.domains.create')}</Btn>
	{/snippet}
</PageHeader>

{#if settings && !settings.configured}
	<Flash kind="info">
		{t('web.domains.notConfigured')}
		<Btn icon="gear" onclick={openSettings}>{t('web.domains.configure')}</Btn>
	</Flash>
{/if}

<OverviewBar title={t('web.domains.overview')}>
	<OverviewCell label={t('web.domains.overviewProvider')}>
		{#if settings?.configured}
			<StatusBadge state="ok" label={`Namecheap · ${settings.provider?.apiUser ?? ''}`} />
		{:else}
			<StatusBadge state="unknown" label={t('web.domains.notSet')} />
		{/if}
	</OverviewCell>
	<OverviewCell label={t('web.domains.overviewBase')}>
		<span class="mono">*.{settings?.baseDomain ?? '–'}</span>
	</OverviewCell>
	<OverviewCell label={t('web.domains.overviewAddress')}>
		<span class="mono">{settings?.effectiveAddress ?? '–'}</span>
	</OverviewCell>
	<OverviewCell label={t('web.domains.overviewHostnames')}>
		{hostnames.length}
		<span class="dim">({t('web.domains.linkedCount', { count: linkedCount })})</span>
	</OverviewCell>
</OverviewBar>

<Tabs
	tabs={[
		{ id: 'hostnames', label: t('web.domains.tabHostnames') },
		{ id: 'records', label: t('web.domains.tabRecords') },
		{ id: 'activity', label: t('web.domains.tabActivity') }
	]}
	bind:active={tab}
/>

<div class="tabbody">
	{#if tab === 'hostnames'}
		<Panel flush>
			<ResourceTable
				tableId="network-domains"
				initialSearch={page.url.searchParams.get('q') ?? ''}
				columns={hostnameColumns}
				filters={hostnameFilters}
				rows={hostnames}
				loading={!loaded}
				getId={(row) => row.fqdn}
				searchValue={(row) => `${row.fqdn} ${row.instance ?? ''} ${row.address}`}
				searchPlaceholder={t('web.domains.search')}
				selectable="multi"
				bind:selected
				{rowActions}
				rowLabel={(row) => row.fqdn}
				rowDim={(row) => !row.instance}
				noun={t('web.domains.noun')}
				sortValue={(row, col) =>
					col === 'created'
						? row.createdAt
						: col === 'instance'
							? (row.instance ?? '')
							: col === 'by'
								? row.createdBy
								: null}
				emptyTitle={t('web.domains.emptyTitle')}
				emptyText={t('web.domains.emptyText')}
			>
				{#snippet cell(row, col)}
					{#if col === 'fqdn'}
						<b class="mono">{row.fqdn}</b>
					{:else if col === 'instance'}
						{#if row.instance}
							<a href="/instances/{row.instance}">{row.instance}</a>
						{:else}
							<span class="dim">{t('web.domains.notLinked')}</span>
						{/if}
					{:else if col === 'address'}
						<span class="mono">{row.address}</span>
					{:else if col === 'by'}
						<span class="dim">{row.createdBy}</span>
					{:else if col === 'created'}
						<span class="dim">{fmtDateTime(row.createdAt)}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{:else if tab === 'records'}
		{#if !settings?.configured}
			<Flash kind="info">{t('web.domains.recordsNeedProvider')}</Flash>
		{:else if recordsError}
			<Flash kind="error">{recordsError}</Flash>
		{:else}
			<Flash kind="info">{t('web.domains.recordsNote', { zone: recordsZone || '…', base: settings.baseDomain })}</Flash>
			<Panel flush>
				<ResourceTable
					tableId="network-domain-records"
					columns={recordColumns}
					rows={records}
					loading={!recordsLoaded}
					getId={(row) => row.key}
					searchValue={(row) => `${row.name} ${row.type} ${row.address}`}
					searchPlaceholder={t('web.domains.searchRecords')}
					noun={t('web.domains.recordNoun')}
					sortValue={(row, col) => (col === 'ttl' ? (row.ttl ?? 0) : col === 'managed' ? (managedRecord(row) ? 1 : 0) : null)}
					emptyTitle={recordsLoading ? t('web.domains.recordsLoading') : t('web.domains.recordsEmptyTitle')}
					emptyText={recordsLoading ? '' : t('web.domains.recordsEmptyText')}
				>
					{#snippet cell(row, col)}
						{#if col === 'name'}
							<span class="mono">{row.name}.{recordsZone}</span>
						{:else if col === 'type'}
							<span class="mono">{row.type}</span>
						{:else if col === 'address'}
							<span class="mono value">{row.address}</span>
						{:else if col === 'ttl'}
							<span class="mono dim">{row.ttl ? `${row.ttl}s` : '–'}</span>
						{:else if col === 'managed'}
							{#if managedRecord(row)}
								<StatusBadge state="ok" label={t('web.domains.managedByLuna')} />
							{:else}
								<span class="dim">{t('web.domains.notManaged')}</span>
							{/if}
						{/if}
					{/snippet}
				</ResourceTable>
			</Panel>
		{/if}
	{:else}
		<Panel flush>
			<ResourceTable
				tableId="network-domains-audit"
				columns={auditColumns}
				rows={audit}
				loading={!loaded}
				getId={(row) => row.key}
				searchValue={(row) => `${row.action} ${row.actor} ${row.hostname ?? ''} ${row.instance ?? ''} ${row.detail ?? ''}`}
				searchPlaceholder={t('web.domains.searchActivity')}
				noun={t('web.domains.activityNoun')}
				sortValue={(row, col) => (col === 'when' ? row.t : null)}
				emptyTitle={t('web.domains.noActivityTitle')}
				emptyText={t('web.domains.noActivityText')}
			>
				{#snippet cell(row, col)}
					{#if col === 'when'}
						<span class="dim">{fmtDateTime(row.t)}</span>
					{:else if col === 'action'}
						<StatusBadge state={auditTone(row.action)} label={row.action} />
					{:else if col === 'actor'}
						<span>{row.actor}</span>
					{:else if col === 'hostname'}
						<span class="mono" class:dim={!row.hostname}>{row.hostname ?? '–'}</span>
					{:else if col === 'detail'}
						<span class="dim">{row.instance ?? row.detail ?? '–'}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	{/if}
</div>

<Modal title={t('web.domains.createTitle')} bind:open={createOpen}>
	<FormGrid cols={1}>
		<label class="field">
			<span class="lbl">{t('web.domains.label')}</span>
			<span class="hint">{t('web.domains.labelHint', { base: settings?.baseDomain ?? '' })}</span>
			<span class="suffixed">
				<input class="input mono" type="text" spellcheck="false" placeholder="create" bind:value={createLabel} />
				<span class="suffix mono">.{settings?.baseDomain ?? ''}</span>
			</span>
		</label>

		<div class="field">
			<span class="lbl">{t('web.domains.instance')}</span>
			<span class="hint">{t('web.domains.instanceHint')}</span>
			<Select options={createInstanceOptions} bind:value={createInstance} searchable />
		</div>

		<label class="field">
			<span class="lbl">{t('web.domains.address')}</span>
			<span class="hint">{t('web.domains.addressHint', { address: settings?.effectiveAddress ?? '–' })}</span>
			<input class="input mono" type="text" spellcheck="false" placeholder={settings?.effectiveAddress ?? ''} bind:value={createAddress} />
		</label>

		<label class="check">
			<Checkbox checked={createAdopt} label={t('web.domains.adopt')} onchange={(value) => (createAdopt = value)} />
			{t('web.domains.adopt')}
		</label>
	</FormGrid>

	{#snippet footer()}
		<Btn onclick={() => (createOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" loading={busy} disabled={!createLabel.trim()} onclick={createConfirmed}>{t('web.domains.create')}</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.domains.linkTitle', { fqdn: linkRow?.fqdn ?? '' })} bind:open={linkOpen}>
	<p class="modalnote">{t('web.domains.linkLead')}</p>
	<Select options={instanceOptions} bind:value={linkInstance} searchable />

	{#snippet footer()}
		<Btn onclick={() => (linkOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" loading={busy} disabled={!linkInstance} onclick={linkConfirmed}>{t('web.domains.linkAction')}</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.domains.pointTitle', { fqdn: pointRow?.fqdn ?? '' })} bind:open={pointOpen}>
	<label class="field">
		<span class="lbl">{t('web.domains.address')}</span>
		<input class="input mono" type="text" spellcheck="false" bind:value={pointAddress} />
	</label>

	{#snippet footer()}
		<Btn onclick={() => (pointOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" loading={busy} disabled={!pointAddress.trim()} onclick={pointConfirmed}>{t('web.domains.pointAction')}</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.domains.settingsTitle')} bind:open={settingsOpen}>
	<FormGrid cols={2}>
		<label class="field">
			<span class="lbl">{t('web.domains.apiUser')}</span>
			<input class="input" type="text" spellcheck="false" autocomplete="off" bind:value={formApiUser} />
		</label>

		<label class="field">
			<span class="lbl">{t('web.domains.userName')}</span>
			<span class="hint">{t('web.domains.userNameHint')}</span>
			<input class="input" type="text" spellcheck="false" autocomplete="off" placeholder={formApiUser} bind:value={formUserName} />
		</label>

		<label class="field">
			<span class="lbl">{t('web.domains.apiKey')}</span>
			<span class="hint">
				{settings?.provider?.apiKeyHint
					? t('web.domains.apiKeyKeep', { hint: settings.provider.apiKeyHint })
					: t('web.domains.apiKeyHint')}
			</span>
			<input class="input mono" type="password" autocomplete="new-password" bind:value={formApiKey} />
		</label>

		<label class="field">
			<span class="lbl">{t('web.domains.clientIp')}</span>
			<span class="hint">{t('web.domains.clientIpHint')}</span>
			<input class="input mono" type="text" spellcheck="false" bind:value={formClientIp} />
		</label>

		<label class="field">
			<span class="lbl">{t('web.domains.baseDomain')}</span>
			<span class="hint">{t('web.domains.baseDomainHint')}</span>
			<input class="input mono" type="text" spellcheck="false" bind:value={formBase} />
		</label>

		<label class="field">
			<span class="lbl">{t('web.domains.publicAddress')}</span>
			<span class="hint">{t('web.domains.publicAddressHint')}</span>
			<input class="input mono" type="text" spellcheck="false" placeholder={formClientIp} bind:value={formAddress} />
		</label>

		<label class="field">
			<span class="lbl">{t('web.domains.ttl')}</span>
			<input class="input mono" type="number" min="60" max="86400" bind:value={formTtl} />
		</label>

		<div class="field wide">
			<span class="lbl">{t('web.domains.dropLabel')}</span>
			<span class="hint">{t('web.domains.dropHint')}</span>
			<label class="check">
				<Checkbox checked={formDrop} label={t('web.domains.drop')} onchange={(value) => (formDrop = value)} />
				{t('web.domains.drop')}
			</label>
		</div>

		<div class="field">
			<span class="lbl">{t('web.domains.sandboxLabel')}</span>
			<label class="check">
				<Checkbox checked={formSandbox} label={t('web.domains.sandbox')} onchange={(value) => (formSandbox = value)} />
				{t('web.domains.sandbox')}
			</label>
		</div>
	</FormGrid>

	{#if checkResult}
		{#if checkResult.ok}
			<Flash kind="success">
				{t('web.domains.checkOk', { count: checkResult.domains.length, zone: checkResult.zone ?? t('web.domains.noZone') })}
			</Flash>
		{:else}
			<Flash kind="error">{t('web.domains.checkFailed', { error: checkResult.error ?? '?' })}</Flash>
		{/if}
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (settingsOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn icon="plug" loading={busy} onclick={saveAndCheck}>{t('web.domains.saveAndCheck')}</Btn>
		<Btn variant="primary" loading={busy} onclick={saveAndClose}>{t('web.common.save')}</Btn>
	{/snippet}
</Modal>

<ConfirmModal
	bind:open={unlinkOpen}
	title={t('web.domains.unlinkTitle', { count: unlinkRows.length })}
	lead={t('web.domains.unlinkLead', { names: unlinkRows.map((row) => row.fqdn).join(', ') })}
	notes={[t('web.domains.unlinkNote')]}
	confirmLabel={t('web.domains.unlinkConfirm')}
	onconfirm={() => void runBulk(unlinkRows, t('web.domains.verbUnlink'), (row) => post(`/domains/${encodeURIComponent(row.fqdn)}/unlink`))}
/>

<ConfirmModal
	bind:open={deleteOpen}
	title={t('web.domains.deleteTitle', { count: deleteRows.length })}
	lead={t('web.domains.deleteLead', { names: deleteRows.map((row) => row.fqdn).join(', ') })}
	notes={[t('web.domains.deleteNote')]}
	confirmLabel={t('web.common.delete')}
	onconfirm={() => void runBulk(deleteRows, t('web.domains.verbDelete'), (row) => del(`/domains/${encodeURIComponent(row.fqdn)}`))}
/>

<style lang="scss">
	.tabbody {
		margin-top: 1rem;

		:global(.flash) {
			margin-bottom: 1rem;
		}
	}

	.modalnote {
		margin: 0 0 0.75rem;
		font-size: 0.8125rem;
	}

	.suffixed {
		display: flex;
		align-items: center;
		gap: 0.375rem;

		.input {
			flex: 1;
			min-width: 0;
		}
	}

	.suffix {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		white-space: nowrap;
	}

	.value {
		overflow-wrap: anywhere;
	}

	.wide {
		grid-column: 1 / -1;
	}

	.check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
	}
</style>
