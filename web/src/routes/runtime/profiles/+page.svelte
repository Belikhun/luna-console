<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { api, del } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Java profiles: the named JVM flag sets instances launch with.
	 *
	 * Single-select on purpose. Every verb here takes one target (edit one flag
	 * set, rename one profile), so the table draws radios and says so, rather
	 * than promising a multi-select the actions could not honour.
	 */

	interface ProfileRow {
		name: string;
		java: string | null;
		runtime: string | null;
		flags: string[];
		jarArgs: string[];
		usedBy: string[];
	}

	let rows: ProfileRow[] = $state([]);
	let loading = $state(false);
	let lastUpdated: number | null = $state(null);
	let selected: Set<string> = $state(new Set());

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api('/profiles');

			rows = (data.profiles as Array<any>).map((profile) => ({
				name: profile.name,
				java: profile.java ?? null,
				runtime: profile.runtime ?? null,
				flags: profile.flags ?? [],
				jarArgs: profile.jarArgs ?? [],
				usedBy: profile.usedBy ?? []
			}));

			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.profiles.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void refresh();
	});

	/** The wizard, creating, duplicating or editing. */
	function wizardHref(opts: { name?: string; copy?: string } = {}): string {
		const params = new URLSearchParams();

		if (opts.name) {
			params.set('name', opts.name);
		}

		if (opts.copy) {
			params.set('copy', opts.copy);
		}

		const query = params.toString();

		return query ? `/runtime/profiles/new?${query}` : '/runtime/profiles/new';
	}

	async function remove(row: ProfileRow): Promise<void> {
		if (!confirm(t('web.profiles.removeConfirm', { name: row.name }))) {
			return;
		}

		try {
			await del(`/profiles/${encodeURIComponent(row.name)}`);
			Notify.success(t('web.profiles.removed', { name: row.name }));
			selected = new Set();
			await refresh();
		} catch (err) {
			Notify.error(t('web.profiles.removeFailed', { name: row.name }), {
				detail: (err as Error).message
			});
		}
	}

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.common.name'), sortable: true, width: 180 },
		{ id: 'runtime', label: t('web.profiles.colRuntime'), sortable: true, width: 200 },
		{ id: 'java', label: t('web.profiles.colJava'), width: 220 },
		{ id: 'flags', label: t('web.profiles.colFlags'), width: 100, align: 'right' },
		{ id: 'jarArgs', label: t('web.profiles.colJarArgs'), width: 150 },
		{ id: 'usedBy', label: t('web.profiles.colUsedBy') }
	]);

	const filters: TableFilterGroup<ProfileRow>[] = $derived([
		{
			id: 'usage',
			label: t('web.profiles.filterUsage'),
			options: [
				{ value: 'any', label: t('web.profiles.anyUsage') },
				{ value: 'used', label: t('web.profiles.inUse'), match: (row) => row.usedBy.length > 0 },
				{ value: 'idle', label: t('web.profiles.unused'), match: (row) => row.usedBy.length === 0 }
			]
		},
		{
			id: 'java',
			label: t('web.profiles.filterJava'),
			options: [
				{ value: 'any', label: t('web.profiles.anyJava') },
				{ value: 'runtime', label: t('web.profiles.pinsRuntime'), match: (row) => !!row.runtime },
				{ value: 'path', label: t('web.profiles.pinsPath'), match: (row) => !!row.java },
				{
					value: 'default',
					label: t('web.profiles.machineDefault'),
					match: (row) => !row.runtime && !row.java
				}
			]
		}
	]);

	function profileActions(row: ProfileRow | undefined): ContextMenuItem[] {
		if (!row) {
			return [];
		}

		const last = rows.length <= 1;

		return [
			{ label: t('web.profiles.edit'), icon: 'pen', action: () => goto(wizardHref({ name: row.name })) },
			{
				label: t('web.profiles.duplicate'),
				icon: 'copy',
				action: () => goto(wizardHref({ copy: row.name }))
			},
			{ separator: true },
			{
				label: t('web.profiles.remove'),
				icon: 'trash',
				color: 'danger',
				disabled: row.usedBy.length > 0 || last,
				// the reason is what tells an operator what to do next: move the
				// instances off it, or keep the one profile the cluster needs
				hint: row.usedBy.length
					? t('web.profiles.inUseBy', { instances: row.usedBy.join(', ') })
					: last
						? t('web.profiles.lastOne')
						: undefined,
				action: () => remove(row)
			}
		];
	}

	const one = $derived(rows.find((row) => selected.has(row.name)));
</script>

<svelte:head><title>{t('web.nav.javaProfiles')} | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.nav.javaProfiles')}
	count={rows.length}
	description={t('web.profiles.pageDescription')}
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="profiles" />
		<Dropdown label={t('web.common.actions')} disabled={!one} menu={profileActions(one)} />
		<Btn variant="primary" icon="sliders" href={wizardHref()}>
			{t('web.profiles.newProfile')}
		</Btn>
	{/snippet}
</PageHeader>

<Panel flush>
	<ResourceTable
		tableId="runtime-profiles"
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		{filters}
		{rows}
		getId={(row) => row.name}
		searchValue={(row) =>
			`${row.name} ${row.runtime ?? ''} ${row.java ?? ''} ${row.usedBy.join(' ')} ${row.flags.join(' ')}`}
		searchPlaceholder={t('web.profiles.searchPlaceholder')}
		selectable="single"
		bind:selected
		rowActions={(row) => profileActions(row)}
		rowLabel={(row) => row.name}
		noun={t('web.profiles.noun')}
		onRowClick={(row) => goto(wizardHref({ name: row.name }))}
		emptyTitle={t('web.profiles.emptyTitle')}
		emptyText={t('web.profiles.emptyText')}
	>
		{#snippet cell(row, col)}
			{#if col === 'name'}
				<b>{row.name}</b>
			{:else if col === 'runtime'}
				{#if row.runtime}
					<a class="mono" href="/runtime/java?q={encodeURIComponent(row.runtime)}">{row.runtime}</a>
				{:else}
					<span class="dim">–</span>
				{/if}
			{:else if col === 'java'}
				<span class="mono dim">{row.java ?? '–'}</span>
			{:else if col === 'flags'}
				{row.flags.length}
			{:else if col === 'jarArgs'}
				<span class="mono dim">{row.jarArgs.join(' ') || '–'}</span>
			{:else if col === 'usedBy'}
				{#if row.usedBy.length}
					{#each row.usedBy as instance, i (instance)}{#if i > 0}, {/if}<a
							href="/instances/{instance}">{instance}</a
						>{/each}
				{:else}
					<span class="dim">{t('web.profiles.nobody')}</span>
				{/if}
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<style lang="scss">
	// the table's own cells carry every style this screen needs; the form that
	// used to live here is the wizard at /runtime/profiles/new
	.dim {
		color: var(--text-dim);
	}
</style>
