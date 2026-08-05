<script lang="ts">
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
	 * One row per *value*, not per name — a variable with a machine override and an
	 * instance override is three rows, each carrying the source scope it comes from.
	 * That is deliberate: the question this screen answers is "what values exist and
	 * where do they apply", and hiding the narrower ones in a second table made the
	 * cluster-wide value look like the whole truth. The variable's own screen is
	 * where the layering is shown as one object.
	 */

	type Scope = 'global' | 'machine' | 'instance';

	interface ValueRow {
		/** `<scope>:<target>:<name>` — unique per value, not per variable */
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
			Notify.error('Could not load the environment', { detail: (err as Error).message });
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
				? `\n\n${narrower.length} narrower value(s) of this name stay behind and keep applying where they are defined.`
				: '';

		const where =
			row.scope === 'global' ? 'from every instance in the cluster' : `from ${row.scope} ${row.target}`;

		if (!confirm(`Remove ${row.name} ${where}?${warning}`)) {
			return;
		}

		try {
			await del(`/env?name=${encodeURIComponent(row.name)}${scopeQuery(row)}`);
			Notify.success(`${row.name} removed ${where}`, {
				detail: 'Instances keep the old value until they restart.'
			});
			await refresh();
		} catch (err) {
			Notify.error(`Could not remove ${row.name}`, { detail: (err as Error).message });
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
			Notify.error(`Could not reveal ${row.name}`, { detail: (err as Error).message });
		}
	}

	function hide(id: string): void {
		const next = { ...revealed };

		delete next[id];
		revealed = next;
	}

	const columns: Column[] = [
		{ id: 'name', label: 'Name', sortable: true, width: 230 },
		{ id: 'value', label: 'Value' },
		{ id: 'source', label: 'Source', sortable: true, width: 120 },
		{ id: 'target', label: 'Applies to', sortable: true, width: 190 },
		{ id: 'description', label: 'Description' }
	];

	const filters: TableFilterGroup<ValueRow>[] = [
		{
			id: 'source',
			label: 'Filter source scope',
			options: [
				{ value: 'any', label: 'Any source' },
				{ value: 'global', label: 'Global', match: (row) => row.scope === 'global' },
				{ value: 'machine', label: 'Machine', match: (row) => row.scope === 'machine' },
				{ value: 'instance', label: 'Instance', match: (row) => row.scope === 'instance' },
				{
					value: 'override',
					label: 'Overrides only',
					match: (row) => row.scope !== 'global'
				}
			]
		},
		{
			id: 'kind',
			label: 'Filter kind',
			options: [
				{ value: 'any', label: 'Any kind' },
				{ value: 'secret', label: 'Secret', match: (row) => row.secret },
				{ value: 'plain', label: 'Plain', match: (row) => !row.secret }
			]
		}
	];

	function rowActions(row: ValueRow): ContextMenuItem[] {
		return [
			{ label: 'Open details', icon: 'circleInfo', action: () => goto(detailHref(row)) },
			{ label: 'Edit this value', icon: 'pen', action: () => goto(editHref(row)) },
			{
				label: 'Add an override',
				icon: 'layerGroup',
				action: () => goto(`/environment/new?name=${encodeURIComponent(row.name)}`)
			},
			{
				label: revealed[row.id] !== undefined ? 'Hide value' : 'Reveal value',
				icon: revealed[row.id] !== undefined ? 'eyeSlash' : 'eye',
				disabled: !row.secret,
				action: () => (revealed[row.id] !== undefined ? hide(row.id) : reveal(row))
			},
			{
				label: 'Copy name',
				icon: 'copy',
				action: () => navigator.clipboard?.writeText(row.name)
			},
			{
				label: 'Copy value',
				icon: 'copy',
				// a secret's value only reaches the browser once it has been revealed
				disabled: row.secret && revealed[row.id] === undefined,
				action: () => navigator.clipboard?.writeText(revealed[row.id] ?? row.value)
			},
			{ separator: true },
			{
				label: row.scope === 'global' ? 'Remove variable' : 'Remove this override',
				icon: 'trash',
				color: 'danger',
				action: () => remove(row)
			}
		];
	}

	/** The row the header's Actions dropdown acts on. */
	const one = $derived(rows.find((row) => selected.has(row.id)));

	/** Distinct variable names, for the header count — rows outnumber them. */
	const nameCount = $derived(new Set(rows.map((row) => row.name)).size);
</script>

<svelte:head><title>Environment | Luna Console</title></svelte:head>

<PageHeader
	title="Environment"
	count={nameCount}
	description="Variables exported into every instance's JVM at startup and substituted into config files as $&lbrace;NAME&rbrace;. One row per value: the source column is the scope it comes from, and a narrower scope wins — builtin < global < machine < instance. Builtins like LUNA_PORT are computed per instance and appear on each instance's own screen."
	info
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="environment" />
		<Dropdown label="Actions" disabled={!one} menu={one ? rowActions(one) : []} />
		<Btn variant="primary" icon="key" href="/environment/new">Define variable</Btn>
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
		searchPlaceholder="Find a value"
		selectable="single"
		bind:selected
		{rowActions}
		rowLabel={(row) => `${row.name} (${row.scope})`}
		noun="value"
		onRowClick={(row) => goto(detailHref(row))}
		emptyTitle="No variables defined"
		emptyText="Define DB_HOST, an API token or a shared port — instances export them at startup and config files reference them as ${'${NAME}'}."
	>
		{#snippet cell(row, col)}
			{#if col === 'name'}
				<a class="mono" href={detailHref(row)}><b>{row.name}</b></a>
			{:else if col === 'value'}
				{#if !row.secret}
					<span class="mono">{row.value || '(empty)'}</span>
				{:else if revealed[row.id] !== undefined}
					<span class="mono">{revealed[row.id] || '(empty)'}</span>
					<button class="peek" onclick={() => hide(row.id)} title="Hide again">hide</button>
				{:else}
					<StatusBadge state="warning" label="secret" />
					<span class="dim">••••••••</span>
					<button
						class="peek"
						onclick={() => reveal(row)}
						title="Reveal this value — the read is recorded"
					>
						reveal
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
					<span class="dim">every instance</span>
				{/if}
			{:else if col === 'description'}
				{#if row.shadows !== null}
					<span class="dim">shadows <span class="mono">{row.shadows || '(empty)'}</span></span>
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
