<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post, patch, del } from '$lib/api';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Select from '$lib/components/Select.svelte';
	import MultiAddModal from '$lib/components/MultiAddModal.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * One addon group in full: its three member lists (plugins with per-family
	 * availability, resource packs with their server rules, data packs with the
	 * worlds they reach), the instances using it, and the update tools — push
	 * the group to every user and restart them now, on a schedule, or not at all.
	 */

	const name = $derived(page.params.name);

	type Kind = 'plugins' | 'respacks' | 'datapacks';

	let data: any = $state(null);
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let busy = $state('');

	let description = $state('');
	let addOpen = $state(false);
	let addKind: Kind = $state('plugins');
	let deleteOpen = $state(false);

	let restartOpen = $state(false);
	let restartMode = $state('now');
	let restartAt = $state('');
	/** what a confirmed restart choice applies to: a pending edit or a plain sync */
	let pendingEdit: Partial<Record<Kind, string[]>> | null = $state(null);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			data = await api(`/addons/groups/${name}`);
			description = data.description;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(`Could not load group ${name}`, { detail: (err as Error).message });
		}

		loading = false;
	}

	onMount(() => {
		// the groups table deep-links straight into the add dialog; the picker is
		// built from this group's membership, so it opens once that has landed
		void refresh().then(() => {
			if (page.url.searchParams.get('add')) {
				addOpen = true;
			}
		});
	});

	const pluginMembers = $derived((data?.plugins ?? []).map((entry: any) => entry.plugin));
	const respackMembers = $derived((data?.respacks ?? []).map((entry: any) => entry.key));
	const datapackMembers = $derived((data?.datapacks ?? []).map((entry: any) => entry.name));

	/** Current membership of every kind — the base a single-kind edit patches. */
	const membership = $derived<Record<Kind, string[]>>({
		plugins: pluginMembers,
		respacks: respackMembers,
		datapacks: datapackMembers
	});

	const addable = $derived.by(() => {
		if (!data) {
			return [];
		}

		if (addKind === 'respacks') {
			return data.respackKeys.filter((key: string) => !respackMembers.includes(key));
		}

		if (addKind === 'datapacks') {
			return data.datapackNames.filter((pack: string) => !datapackMembers.includes(pack));
		}

		return data.pluginNames.filter((plugin: string) => !pluginMembers.includes(plugin));
	});

	const ADD_TITLES: Record<Kind, string> = {
		plugins: 'Add plugins',
		respacks: 'Add resource packs',
		datapacks: 'Add data packs'
	};

	const ADD_LABELS: Record<Kind, string> = {
		plugins: 'Plugins',
		respacks: 'Resource packs',
		datapacks: 'Data packs'
	};

	const ADD_HINTS: Record<Kind, string> = {
		plugins:
			'Every family of a picked plugin deploys where it fits on the instances using this group.',
		respacks:
			"Picked packs gain this group's backends in their server rules, and the proxy is reloaded.",
		datapacks: 'Picked packs are deployed into the world of every instance using this group.'
	};

	function openAdd(kind: Kind): void {
		addKind = kind;
		addOpen = true;
	}

	/** Save a membership/description change, then apply the restart choice. */
	async function save(
		members: Partial<Record<Kind, string[]>>,
		restart?: { mode: string; at?: string }
	): Promise<void> {
		busy = 'save';

		const note = Notify.loading(`Saving group ${name}…`);

		try {
			const result = await patch(`/addons/groups/${name}`, {
				...members,
				description,
				restart
			});

			const group = result.group;
			const bits = [
				`${group.plugins.length} plugin(s), ${group.respacks?.length ?? 0} resource pack(s), ` +
					`${group.datapacks?.length ?? 0} data pack(s)`
			];

			if (result.deployed) {
				bits.push(`${result.deployed} jar change(s)`);
			}

			if (result.packs) {
				bits.push(`${result.packs} pack change(s)`);
			}

			if (result.restarted?.length) {
				bits.push(`restarted ${result.restarted.join(', ')}`);
			}

			if (result.scheduled) {
				bits.push(`restart scheduled ${new Date(result.scheduled).toLocaleString('sv')}`);
			}

			note.set({
				level: 'success',
				message: `Group ${name} saved`,
				detail: bits.join(' · '),
				closeable: true
			});

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not save ${name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = '';
	}

	/** Membership edits go through the restart dialog so the operator chooses the fallout. */
	function changeMembers(members: Partial<Record<Kind, string[]>>): void {
		pendingEdit = members;
		restartMode = 'none';
		restartAt = '';
		restartOpen = true;
	}

	/** Push the group's current members to every instance using it. */
	function syncInstances(): void {
		pendingEdit = null;
		restartMode = 'now';
		restartAt = '';
		restartOpen = true;
	}

	async function confirmRestart(): Promise<void> {
		const restart =
			restartMode === 'none' ? undefined : { mode: restartMode, at: restartAt || undefined };

		restartOpen = false;

		if (pendingEdit) {
			await save(pendingEdit, restart);

			return;
		}

		busy = 'sync';

		const note = Notify.loading(`Updating the instances using ${name}…`);

		try {
			const result = await post(`/addons/groups/${name}`, { action: 'sync', restart });

			const bits = [`${result.deployed} jar change(s)`, `${result.packs} pack change(s)`];

			if (result.restarted?.length) {
				bits.push(`restarted ${result.restarted.join(', ')}`);
			}

			if (result.scheduled) {
				bits.push(`restart scheduled ${new Date(result.scheduled).toLocaleString('sv')}`);
			}

			note.set({
				level: 'success',
				message: `${name} synced to ${result.affected.length} instance(s)`,
				detail: bits.join(' · '),
				closeable: true
			});

			await refresh();
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not sync ${name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}

		busy = '';
	}

	async function remove(): Promise<void> {
		try {
			await del(`/addons/groups/${name}`);

			Notify.success(`Group ${name} deleted`, {
				detail: 'Deployed jars and packs stay on the instances until removed.'
			});

			await goto('/addons/groups');
		} catch (err) {
			Notify.error(`Could not delete ${name}`, { detail: (err as Error).message });
			deleteOpen = false;
		}
	}

	const pluginCols: Column[] = [
		{ id: 'plugin', label: 'Plugin', sortable: true },
		{ id: 'families', label: 'Families' },
		{ id: 'versions', label: 'Primary versions' }
	];

	const respackCols: Column[] = [
		{ id: 'key', label: 'Resource pack', sortable: true },
		{ id: 'state', label: 'State', width: 140 },
		{ id: 'servers', label: 'Server rules' },
		{ id: 'version', label: 'Version', width: 120 }
	];

	const datapackCols: Column[] = [
		{ id: 'name', label: 'Data pack', sortable: true },
		{ id: 'state', label: 'State', width: 140 },
		{ id: 'targets', label: 'Deploys to' },
		{ id: 'version', label: 'Version', width: 120 }
	];

	/** A member row's verbs: leave the group, and go look at the thing itself. */
	function pluginActions(row: any): ContextMenuItem[] {
		return [
			{
				label: 'Remove from this group',
				icon: 'trash',
				color: 'danger',
				disabled: row.locked || !!busy,
				hint: row.locked ? 'baseline members of the default group are locked' : undefined,
				action: () =>
					changeMembers({
						plugins: pluginMembers.filter((plugin: string) => plugin !== row.plugin)
					})
			},
			{ separator: true },
			{
				label: 'Plugin details',
				icon: 'circleInfo',
				action: () => goto(`/plugins/${encodeURIComponent(row.plugin)}`)
			}
		];
	}

	function respackActions(row: any): ContextMenuItem[] {
		return [
			{
				label: 'Remove from this group',
				icon: 'trash',
				color: 'danger',
				disabled: !!busy,
				action: () =>
					changeMembers({
						respacks: respackMembers.filter((key: string) => key !== row.key)
					})
			},
			{ separator: true },
			{
				label: 'Pack details',
				icon: 'circleInfo',
				action: () => goto(`/packs/${encodeURIComponent(row.key)}`)
			},
			{
				label: 'Configure pack',
				icon: 'pen',
				action: () => goto(`/packs/${encodeURIComponent(row.key)}/configure`)
			}
		];
	}

	function datapackActions(row: any): ContextMenuItem[] {
		return [
			{
				label: 'Remove from this group',
				icon: 'trash',
				color: 'danger',
				disabled: !!busy,
				action: () =>
					changeMembers({
						datapacks: datapackMembers.filter((pack: string) => pack !== row.name)
					})
			},
			{ separator: true },
			{
				label: 'Manage in Data packs',
				icon: 'box',
				action: () => goto(`/datapacks?q=${encodeURIComponent(row.name)}`)
			}
		];
	}

	const instCols: Column[] = [
		{ id: 'name', label: 'Instance', sortable: true },
		{ id: 'state', label: 'State', width: 140 },
		{ id: 'env', label: 'Environment' }
	];
</script>

<svelte:head><title>{name} | Addon groups | Luna Console</title></svelte:head>

{#if data}
	<PageHeader title={name ?? ''} info>
		{#snippet extra()}
			{#if data.builtin}<StatusBadge state="ok" label="builtin" />{/if}
		{/snippet}
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="addon-group" />
			<Btn
				icon="upload"
				loading={busy === 'sync'}
				disabled={!!busy || !data.instances.length}
				onclick={syncInstances}
			>
				Update instances
			</Btn>
			<Btn
				variant="danger"
				icon="trash"
				disabled={data.builtin}
				title={data.builtin ? 'the default group is built in and cannot be deleted' : undefined}
				onclick={() => (deleteOpen = true)}
			>
				Delete group
			</Btn>
		{/snippet}
	</PageHeader>

	<Panel title="Group details">
		<label class="field desc">
			<span class="lbl">Description</span>
			<input
				class="input"
				bind:value={description}
				placeholder="What this set is for"
				onblur={() => {
					if (description !== data.description) {
						void save({});
					}
				}}
			/>
		</label>
		{#if data.builtin}
			<p class="dim note">
				The default group applies to every instance; its baseline plugins are locked and can only
				be joined by extras.
			</p>
		{/if}
	</Panel>

	<div class="gap"></div>

	<Panel
		title="Plugins in this group"
		count={data.plugins.length}
		description="Every family of a member deploys where it fits — paper builds to backends, velocity builds to the proxy, universal to both. Changes deploy to every instance using the group, with the restart choice up to you."
		flush
	>
		{#snippet actions()}
			<Btn icon="plus" disabled={!!busy} onclick={() => openAdd('plugins')}>Add a plugin</Btn>
		{/snippet}
		<ResourceTable
			tableId="group-members"
			columns={pluginCols}
			rows={data.plugins}
			getId={(row) => row.plugin}
			searchValue={(row) => `${row.plugin} ${row.displayName ?? ''} ${row.source ?? ''}`}
			searchPlaceholder="Find a member"
			searchWidth="20rem"
			noun="member"
			pageSize={25}
			rowActions={pluginActions}
			rowLabel={(row) => row.plugin}
			emptyTitle="No plugins yet"
			emptyText="Add members with the control above."
		>
			{#snippet cell(row, col)}
				{#if col === 'plugin'}
					<a href="/plugins/{row.plugin}">{row.plugin}</a>
					{#if row.locked}<StatusBadge state="stopped" label="locked" />{/if}
					{#if !row.pooled}<StatusBadge state="failed" label="not pooled" />{/if}
				{:else if col === 'families'}
					<span class="dim">
						{row.families.map((family: any) => family.family).join(', ') || '–'}
					</span>
				{:else if col === 'versions'}
					<span class="mono dim">
						{row.families
							.map((family: any) => family.version)
							.filter(Boolean)
							.join(', ') || '–'}
					</span>
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>

	<div class="gap"></div>

	<Panel
		title="Resource packs in this group"
		count={data.respacks.length}
		description="The proxy serves these to players on the group's backends. Membership is written into each pack's server rules, so leaving the group takes exactly those names back out."
		flush
	>
		{#snippet actions()}
			<Btn icon="plus" disabled={!!busy} onclick={() => openAdd('respacks')}>Add a pack</Btn>
		{/snippet}
		<ResourceTable
			tableId="group-respacks"
			columns={respackCols}
			rows={data.respacks}
			getId={(row) => row.key}
			searchValue={(row) => `${row.key} ${row.servers.join(' ')}`}
			searchPlaceholder="Find a resource pack"
			searchWidth="20rem"
			noun="pack"
			pageSize={25}
			rowActions={respackActions}
			rowLabel={(row) => row.key}
			emptyTitle="No resource packs"
			emptyText="Add one to serve it on every instance using this group."
		>
			{#snippet cell(row, col)}
				{#if col === 'key'}
					<a href="/packs?q={encodeURIComponent(row.key)}">{row.key}</a>
				{:else if col === 'state'}
					{#if !row.pooled}
						<StatusBadge state="failed" label="Not pooled" detail="no zip under <root>/packs" />
					{:else if row.enabled}
						<StatusBadge state="ok" label="Enabled" />
					{:else}
						<StatusBadge
							state="stopped"
							label="Disabled"
							detail="the pack is registered but switched off — players are not offered it"
						/>
					{/if}
				{:else if col === 'servers'}
					<span class="mono rules">{row.servers.join(', ') || '–'}</span>
					{#if row.matched.length}
						<span class="dim">→ {row.matched.join(', ')}</span>
					{/if}
				{:else if col === 'version'}
					<span class="mono dim">{row.version ?? '–'}</span>
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>

	<div class="gap"></div>

	<Panel
		title="Data packs in this group"
		count={data.datapacks.length}
		description="Copied into the world of every instance using the group. Servers load them on their next restart (or /minecraft:reload)."
		flush
	>
		{#snippet actions()}
			<Btn icon="plus" disabled={!!busy} onclick={() => openAdd('datapacks')}>Add a pack</Btn>
		{/snippet}
		<ResourceTable
			tableId="group-datapacks"
			columns={datapackCols}
			rows={data.datapacks}
			getId={(row) => row.name}
			searchValue={(row) => `${row.name} ${row.targets.join(' ')}`}
			searchPlaceholder="Find a data pack"
			searchWidth="20rem"
			noun="pack"
			pageSize={25}
			rowActions={datapackActions}
			rowLabel={(row) => row.name}
			emptyTitle="No data packs"
			emptyText="Add one to deploy it into every world using this group."
		>
			{#snippet cell(row, col)}
				{#if col === 'name'}
					<a href="/datapacks?q={encodeURIComponent(row.name)}">{row.name}</a>
				{:else if col === 'state'}
					{#if !row.pooled}
						<StatusBadge state="failed" label="Not pooled" detail="no entry in packs.lock.json" />
					{:else if !row.present}
						<StatusBadge
							state="warning"
							label="File missing"
							detail="the pool zip is gone — reinstall or re-upload the pack"
						/>
					{:else}
						<StatusBadge state="ok" label="Pooled" />
					{/if}
				{:else if col === 'targets'}
					<span class="dim">{row.targets.join(', ') || 'nowhere'}</span>
				{:else if col === 'version'}
					<span class="mono dim">{row.version ?? '–'}</span>
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>

	<div class="gap"></div>

	<Panel
		title="Instances using this group"
		count={data.instances.length}
		description={data.builtin
			? 'The default group covers every managed instance'
			: 'Instances that list this group in their configuration'}
		flush
	>
		<ResourceTable
			tableId="group-instances"
			columns={instCols}
			rows={data.instances}
			getId={(row) => row.name}
			searchValue={(row) => row.name}
			searchPlaceholder="Find an instance"
			searchWidth="18rem"
			noun="instance"
			pageSize={15}
			emptyTitle="Not used by any instance"
			emptyText="Attach it from an instance's configuration tab, or in the launch wizard."
		>
			{#snippet cell(row, col)}
				{#if col === 'name'}
					<a href="/instances/{row.name}">{row.name}</a>
				{:else if col === 'state'}
					<StatusBadge state={row.state} />
				{:else if col === 'env'}
					{row.software}{row.mcVersion ? ` ${row.mcVersion}` : ''}
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>
{/if}

<MultiAddModal
	bind:open={addOpen}
	title="{ADD_TITLES[addKind]} to {name}"
	description={ADD_HINTS[addKind]}
	selectLabel={ADD_LABELS[addKind]}
	options={addable}
	onconfirm={(names) => changeMembers({ [addKind]: [...membership[addKind], ...names] })}
/>

<!-- restart choice for member changes and syncs -->
<Modal title="Apply to the instances using {name}" bind:open={restartOpen}>
	<p class="dim intro">
		The change applies immediately; running servers load it on their next restart. Pick what
		happens to <b>{(data?.instances ?? []).map((row: any) => row.name).join(', ') || 'nobody'}</b>:
	</p>
	<div class="field">
		<span class="lbl">Restart</span>
		<Select
			bind:value={restartMode}
			width="100%"
			options={[
				{ value: 'none', label: 'Do not restart — applies on their next restart' },
				{ value: 'now', label: 'Restart running instances now' },
				{ value: 'schedule', label: 'Schedule a restart…' }
			]}
		/>
		{#if restartMode === 'schedule'}
			<input class="input at" type="datetime-local" bind:value={restartAt} />
		{/if}
	</div>
	{#snippet footer()}
		<Btn onclick={() => (restartOpen = false)}>Cancel</Btn>
		<Btn
			variant="primary"
			disabled={restartMode === 'schedule' && !restartAt}
			onclick={confirmRestart}
		>
			{pendingEdit ? 'Save & apply' : 'Update instances'}
		</Btn>
	{/snippet}
</Modal>

<Modal title="Delete group {name}" bind:open={deleteOpen}>
	<p>
		Removes the group from the registry. Instances stop receiving its addons on their next apply;
		jars and packs already on disk stay until removed.
	</p>
	{#snippet footer()}
		<Btn onclick={() => (deleteOpen = false)}>Cancel</Btn>
		<Btn variant="danger" onclick={remove}>Delete group</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.gap {
		height: 1rem;
	}

	.desc {
		max-width: 30rem;
	}

	.note {
		margin: 0.625rem 0 0;
		font-size: 0.8125rem;
	}

	.intro {
		margin: 0 0 0.75rem;
		font-size: 0.8125rem;
	}

	.rules {
		margin-right: 0.5rem;
	}

	.at {
		margin-top: 0.5rem;
	}
</style>
