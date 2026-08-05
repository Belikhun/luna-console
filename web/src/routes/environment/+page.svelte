<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { api, del, post } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Environment manager: the variables every instance's JVM inherits at startup
	 * and config files substitute as ${NAME}.
	 *
	 * One row per *value*, not per name; a variable with a machine override and an
	 * instance override is three rows, each carrying the source scope it comes from.
	 * That is deliberate: the question this screen answers is "what values exist and
	 * where do they apply", and hiding the narrower ones in a second table made the
	 * cluster-wide value look like the whole truth. The variable's own screen is
	 * where the layering is shown as one object.
	 */

	type Scope = 'global' | 'machine' | 'instance';

	interface ValueRow {
		/** `<scope>:<target>:<name>`; unique per value, not per variable */
		id: string;
		name: string;
		scope: Scope;
		/** Machine name or instance name; null at global scope */
		target: string | null;
		value: string;
		secret: boolean;
		description: string;
		/** The wider value this one shadows, when there is one */
		shadows: string | null;
	}

	let rows: ValueRow[] = $state([]);
	let loading = $state(false);
	let lastUpdated: number | null = $state(null);
	let selected: Set<string> = $state(new Set());
	/** Secrets revealed this session, keyed by row id; dropped on reload */
	let revealed: Record<string, string> = $state({});

	async function refresh(): Promise<void> {
		loading = true;

		try {
			const data = await api('/env');

			const globals = new Map<string, { value: string; secret: boolean; description: string }>(
				(data.variables as Array<any>).map((entry) => [entry.name, entry])
			);

			const globalRows: ValueRow[] = (data.variables as Array<any>).map((entry) => ({
				id: `global::${entry.name}`,
				name: entry.name,
				scope: 'global',
				target: null,
				value: entry.value,
				secret: entry.secret,
				description: entry.description,
				shadows: null
			}));

			const overrideRows: ValueRow[] = (data.overrides as Array<any>).map((entry) => ({
				id: `${entry.scope}:${entry.target}:${entry.name}`,
				name: entry.name,
				scope: entry.scope,
				target: entry.target,
				value: entry.value,
				secret: entry.secret,
				description: globals.get(entry.name)?.description ?? '',
				shadows: globals.has(entry.name)
					? globals.get(entry.name)!.secret
						? '••••••••'
						: globals.get(entry.name)!.value
					: null
			}));

			rows = [...globalRows, ...overrideRows].sort(
				(a, b) => a.name.localeCompare(b.name) || SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]
			);

			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(t('web.env.loadFailed'), { detail: (err as Error).message });
		} finally {
			loading = false;
		}
	}

	/** Weakest scope first, so a name's rows read in precedence order. */
	const SCOPE_ORDER: Record<Scope, number> = { global: 0, machine: 1, instance: 2 };

	onMount(() => {
		void refresh();
	});

	/** The variable's own screen: scopes, usage, resolution, history. */
	function detailHref(row: { name: string }): string {
		return `/environment/${encodeURIComponent(row.name)}`;
	}

	/** The wizard, prefilled to edit exactly this value. */
	function editHref(row: ValueRow): string {
		const params = new URLSearchParams({ name: row.name });

		if (row.scope === 'machine' && row.target) {
			params.set('machine', row.target);
		}

		if (row.scope === 'instance' && row.target) {
			params.set('instance', row.target);
		}

		return `/environment/new?${params}`;
	}

	/** The `?scope=` query the delete endpoint takes for this row. */
	function scopeQuery(row: ValueRow): string {
		if (row.scope === 'machine') {
			return `&machine=${encodeURIComponent(row.target ?? '')}`;
		}

		if (row.scope === 'instance') {
			return `&instance=${encodeURIComponent(row.target ?? '')}`;
		}

		return '';
	}

	async function remove(row: ValueRow): Promise<void> {
		const narrower = rows.filter((entry) => entry.name === row.name && entry.scope !== 'global');

		const warning =
			row.scope === 'global' && narrower.length
				? `\n\n${t('web.env.narrowerStay', { count: narrower.length })}`
				: '';

		const where =
			row.scope === 'global'
				? t('web.env.fromEverywhere')
				: t('web.env.fromScope', { scope: row.scope, target: row.target ?? '' });

		if (!confirm(`${t('web.env.removeConfirm', { name: row.name, where })}${warning}`)) {
			return;
		}

		try {
			await del(`/env?name=${encodeURIComponent(row.name)}${scopeQuery(row)}`);
			Notify.success(t('web.env.removed', { name: row.name, where }), {
				detail: t('web.env.restartNote')
			});
			await refresh();
		} catch (err) {
			Notify.error(t('web.env.removeFailed', { name: row.name }), { detail: (err as Error).message });
		}
	}

	/**
	 * Reveal one secret in place. The value stays in this component's state and is
	 * dropped on reload; the server records the read, which the variable's History
	 * tab shows.
	 */
	async function reveal(row: ValueRow): Promise<void> {
		try {
			const result = await post(`/env/${encodeURIComponent(row.name)}/reveal`, {
				machine: row.scope === 'machine' ? row.target : undefined,
				instance: row.scope === 'instance' ? row.target : undefined
			});

			revealed = { ...revealed, [row.id]: result.value };
		} catch (err) {
			Notify.error(t('web.env.revealFailed', { name: row.name }), { detail: (err as Error).message });
		}
	}

	function hide(id: string): void {
		const next = { ...revealed };

		delete next[id];
		revealed = next;
	}

	const columns: Column[] = $derived([
		{ id: 'name', label: t('web.common.name'), sortable: true, width: 230 },
		{ id: 'value', label: t('web.common.value') },
		{ id: 'source', label: t('web.env.colSource'), sortable: true, width: 120 },
		{ id: 'target', label: t('web.env.colTarget'), sortable: true, width: 190 },
		{ id: 'description', label: t('web.env.colDescription') }
	]);

	const filters: TableFilterGroup<ValueRow>[] = $derived([
		{
			id: 'source',
			label: t('web.env.filterScope'),
			options: [
				{ value: 'any', label: t('web.catalog.anySource') },
				{ value: 'global', label: t('web.env.global'), match: (row) => row.scope === 'global' },
				{ value: 'machine', label: t('web.env.machine'), match: (row) => row.scope === 'machine' },
				{ value: 'instance', label: t('web.env.instance'), match: (row) => row.scope === 'instance' },
				{
					value: 'override',
					label: t('web.env.overridesOnly'),
					match: (row) => row.scope !== 'global'
				}
			]
		},
		{
			id: 'kind',
			label: t('web.env.filterKind'),
			options: [
				{ value: 'any', label: t('web.env.anyKind') },
				{ value: 'secret', label: t('web.env.secret'), match: (row) => row.secret },
				{ value: 'plain', label: t('web.env.plain'), match: (row) => !row.secret }
			]
		}
	]);

	function rowActions(row: ValueRow): ContextMenuItem[] {
		return [
			{ label: t('web.env.openDetails'), icon: 'circleInfo', action: () => goto(detailHref(row)) },
			{ label: t('web.env.editValue'), icon: 'pen', action: () => goto(editHref(row)) },
			{
				label: t('web.env.addOverride'),
				icon: 'layerGroup',
				action: () => goto(`/environment/new?name=${encodeURIComponent(row.name)}`)
			},
			{
				label: revealed[row.id] !== undefined ? t('web.env.hideValue') : t('web.env.revealValue'),
				icon: revealed[row.id] !== undefined ? 'eyeSlash' : 'eye',
				disabled: !row.secret,
				action: () => (revealed[row.id] !== undefined ? hide(row.id) : reveal(row))
			},
			{
				label: t('web.env.copyName'),
				icon: 'copy',
				action: () => navigator.clipboard?.writeText(row.name)
			},
			{
				label: t('web.env.copyValue'),
				icon: 'copy',
				// a secret's value only reaches the browser once it has been revealed
				disabled: row.secret && revealed[row.id] === undefined,
				action: () => navigator.clipboard?.writeText(revealed[row.id] ?? row.value)
			},
			{ separator: true },
			{
				label: row.scope === 'global' ? t('web.env.removeVariable') : t('web.env.removeOverride'),
				icon: 'trash',
				color: 'danger',
				action: () => remove(row)
			}
		];
	}

	/** The row the header's Actions dropdown acts on. */
	const one = $derived(rows.find((row) => selected.has(row.id)));

	/** Distinct variable names, for the header count; rows outnumber them. */
	const nameCount = $derived(new Set(rows.map((row) => row.name)).size);
</script>

<svelte:head><title>{t('web.nav.environment')} | Luna Console</title></svelte:head>

<PageHeader
	title={t('web.nav.environment')}
	count={nameCount}
	description={t('web.env.pageDescription')}
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="environment" />
		<Dropdown label={t('web.common.actions')} disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn variant="primary" icon="key" href="/environment/new">{t('web.env.defineVariable')}</Btn>
	{/snippet}
</PageHeader>

<Panel flush>
	<ResourceTable
		tableId="environment"
		initialSearch={page.url.searchParams.get('q') ?? ''}
		{columns}
		{filters}
		{rows}
		getId={(row) => row.id}
		searchValue={(row) =>
			`${row.name} ${row.secret ? 'secret' : row.value} ${row.scope} ${row.target ?? ''} ${row.description}`}
		searchPlaceholder={t('web.env.searchPlaceholder')}
		selectable="single"
		bind:selected
		{rowActions}
		rowLabel={(row) => `${row.name} (${row.scope})`}
		noun={t('web.env.noun')}
		onRowClick={(row) => goto(detailHref(row))}
		emptyTitle={t('web.env.emptyTitle')}
		emptyText={t('web.env.emptyText')}
	>
		{#snippet cell(row, col)}
			{#if col === 'name'}
				<a class="mono" href={detailHref(row)}><b>{row.name}</b></a>
			{:else if col === 'value'}
				{#if !row.secret}
					<span class="mono">{row.value || t('web.env.empty')}</span>
				{:else if revealed[row.id] !== undefined}
					<span class="mono">{revealed[row.id] || t('web.env.empty')}</span>
					<button class="peek" onclick={() => hide(row.id)} title={t('web.env.hideAgain')}>{t('web.env.hide')}</button>
				{:else}
					<StatusBadge state="warning" label={t('web.env.secretBadge')} />
					<span class="dim">••••••••</span>
					<button
						class="peek"
						onclick={() => reveal(row)}
						title={t('web.env.revealTitle')}
					>
						{t('web.env.reveal')}
					</button>
				{/if}
			{:else if col === 'source'}
				<span class="scope {row.scope}">{row.scope}</span>
			{:else if col === 'target'}
				{#if row.scope === 'instance'}
					<a href="/instances/{row.target}">{row.target}</a>
				{:else if row.scope === 'machine'}
					<a href="/machines/{row.target}">{row.target}</a>
				{:else}
					<span class="dim">{t('web.env.everyInstance')}</span>
				{/if}
			{:else if col === 'description'}
				{#if row.shadows !== null}
					<span class="dim">{t('web.env.shadows')} <span class="mono">{row.shadows || t('web.env.empty')}</span></span>
				{:else}
					<span class="dim">{row.description || '–'}</span>
				{/if}
			{/if}
		{/snippet}
	</ResourceTable>
</Panel>

<style lang="scss">
	// the scope vocabulary keeps one colour per layer everywhere it appears
	.scope {
		font-size: 0.75rem;

		&.global {
			color: var(--link);
		}

		&.machine {
			color: var(--warning);
		}

		&.instance {
			color: var(--success);
		}
	}

	.peek {
		@include bare-button;

		margin-left: 0.5rem;
		color: var(--link);
		font-size: 0.75rem;

		&:hover {
			text-decoration: underline;
		}
	}
</style>
