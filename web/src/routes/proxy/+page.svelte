<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { api, post } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import ProxyRegistrationModal from '$lib/components/ProxyRegistrationModal.svelte';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { goto } from '$app/navigation';

	/** One row of the sync preview: what velocity.toml has vs what it should have. */
	interface RouteRow {
		server: string;
		address: string;
		state: 'sync' | 'change' | 'add' | 'remove';
		to?: string;
	}

	let data: any = $state(null);
	let reload = $state(true);
	let busy = $state(false);
	let loading = $state(false);
	let lastUpdated: number | null = $state(null);

	// the registration dialog: an empty target offers the instance picker
	let regOpen = $state(false);
	let regTarget = $state('');

	const columns: Column[] = $derived([
		{ id: 'server', label: t('web.proxy.colServer'), width: 180 },
		{ id: 'address', label: t('web.proxy.colAddress'), width: 220 },
		{ id: 'state', label: t('web.proxy.colState') }
	]);

	const rows = $derived.by(() => {
		if (!data) {
			return [];
		}

		const out: RouteRow[] = [];
		const desired = data.desired as Record<string, string>;
		const onDisk = data.onDisk as Record<string, string>;

		for (const [name, address] of Object.entries(onDisk)) {
			if (desired[name] === address) {
				out.push({ server: name, address, state: 'sync' });
			} else if (desired[name]) {
				out.push({ server: name, address, state: 'change', to: desired[name] });
			} else {
				out.push({ server: name, address, state: 'remove' });
			}
		}

		for (const name of Object.keys(desired).filter((entry) => !(entry in onDisk))) {
			out.push({ server: name, address: '', state: 'add', to: desired[name] });
		}

		return out;
	});

	const forcedHostsLabel = $derived.by(() => {
		if (!data) {
			return '';
		}

		const entries = Object.entries(data.forcedHosts as Record<string, string[]>);

		return entries.map(([host, servers]) => `${host} → ${servers}`).join(' · ') || t('web.proxy.none');
	});

	async function refresh(): Promise<void> {
		loading = true;

		try {
			data = await api('/proxy');
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.proxy.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	onMount(refresh);

	/** The registry entry behind a route row; a stale velocity.toml line has none. */
	function instanceOf(server: string): any | undefined {
		return (data?.instances ?? []).find((entry: any) => entry.name === server);
	}

	function editRegistration(server: string): void {
		regTarget = server;
		regOpen = true;
	}

	/** A route's verbs. A row named in velocity.toml but not in the registry has
	 *  no registration to edit, so its menu is only the copy actions. */
	function rowActions(row: RouteRow): ContextMenuItem[] {
		const target = row.to ?? row.address;
		const entry = instanceOf(row.server);

		return [
			{
				// an external server has no instance page; its registration is
				// still editable below
				label: t('web.cleanup.openInstance', { name: row.server }),
				icon: 'server',
				disabled: !entry || entry.external,
				action: () => goto(`/instances/${row.server}`)
			},
			{
				label: t('web.proxy.editRegistration'),
				icon: 'route',
				disabled: !entry,
				action: () => editRegistration(row.server)
			},
			{ separator: true },
			{
				label: t('web.proxy.copyAddress'),
				icon: 'copy',
				disabled: !target,
				action: () => navigator.clipboard?.writeText(target)
			}
		];
	}

	async function apply(): Promise<void> {
		busy = true;

		const note = Notify.loading(t('web.proxy.writing'));

		try {
			const res = await post('/proxy', { reload });

			note.set({
				level: 'success',
				message: t(res.changed ? 'web.proxy.updated' : 'web.proxy.alreadySync'),
				detail: res.reloaded ? t('web.proxy.reloaded') : '',
				closeable: true
			});

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.proxy.applyFailed'),
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = false;
	}

	let selected: Set<string> = $state(new Set());

	/** The row the header's Actions dropdown acts on. */
	const one = $derived(rows.find((row: any) => selected.has(row.server)));
</script>

<svelte:head><title>{t('web.nav.proxyRouting')} | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.nav.proxyRouting')}
	description={t('web.proxy.pageDescription')}
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="proxy" />
		<Dropdown label={t('web.common.actions')} disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn
			icon="plus"
			disabled={!data}
			onclick={() => {
				regTarget = '';
				regOpen = true;
			}}
		>
			{t('web.proxy.registerServer')}
		</Btn>
		<label class="reload">
			<Checkbox
				checked={reload}
				label={t('web.proxy.reloadAfter')}
				onchange={(value) => (reload = value)}
			/>
			{t('web.proxy.runWord')} <code class="inline">{t('web.proxy.velocityReload')}</code> {t('web.proxy.afterApply')}
		</label>
		<Btn variant="primary" loading={busy} disabled={!data} onclick={apply}>{t('web.proxy.sync')}</Btn>
	{/snippet}
</PageHeader>

{#if data}
	{#if data.changed}
		<Flash kind="warning">{t('web.proxy.differs')}</Flash>
	{:else}
		<Flash kind="success">{t('web.proxy.matches')}</Flash>
	{/if}

	<div class="cols">
		<Panel title={t('web.proxy.registeredServers')} flush>
			<ResourceTable
				tableId="proxy-routes"
				initialSearch={page.url.searchParams.get('q') ?? ''}
				{columns}
				{rows}
				getId={(row) => row.server}
				searchValue={(row) => `${row.server} ${row.address} ${row.to ?? ''} ${row.state}`}
				searchPlaceholder={t('web.proxy.findServer')}
				searchWidth="18rem"
				selectable="single"
				bind:selected
				{rowActions}
				rowLabel={(row) => row.server}
				noun={t('web.proxy.noun')}
				pageSize={15}
				emptyTitle={t('web.proxy.emptyTitle')}
			>
				{#snippet cell(row, col)}
					{#if col === 'server'}
						{row.server}
					{:else if col === 'address'}
						<span class="mono">{row.address || '–'}</span>
					{:else if row.state === 'sync'}
						<span class="ok">{t('web.proxy.inSync')}</span>
					{:else if row.state === 'change'}
						<span class="warn">→ {row.to}</span>
					{:else if row.state === 'add'}
						<span class="ok">{t('web.proxy.willBeAdded', { address: row.to ?? '' })}</span>
					{:else}
						<span class="err">{t('web.proxy.willBeRemoved')}</span>
					{/if}
				{/snippet}
			</ResourceTable>
			<div class="meta dim">
				{t('web.proxy.tryOrder')} {data.tryList.join(' → ') || t('web.proxy.emptyList')}<br />
				{t('web.proxy.forcedHosts')} {forcedHostsLabel}
			</div>
		</Panel>
		<Panel title={t('web.proxy.generatedToml')} flush>
			<pre class="code mono">{data.preview}</pre>
		</Panel>
	</div>
{/if}

<ProxyRegistrationModal
	bind:open={regOpen}
	instance={regTarget}
	choices={data?.instances ?? []}
	oncommitted={() => void refresh()}
/>

<style lang="scss">
	.reload {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		font-size: 0.875rem;
	}

	.cols {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;

		@include below($bp-wide) {
			grid-template-columns: 1fr;
		}
	}

	.code {
		margin: 0;
		padding: 0.875rem 1rem;
		font-size: 0.75rem;
		overflow-x: auto;
		background: var(--bg-terminal);
		min-height: 100%;
	}

	.ok {
		color: var(--success);
	}

	.warn {
		color: var(--warning);
	}

	.err {
		color: var(--error);
	}

	.meta {
		padding: 0.75rem 1rem;
		border-top: 0.1rem solid var(--border-divider);
		font-size: 0.75rem;
	}
</style>
