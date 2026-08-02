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
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * One plugin group in full: its members with per-family availability, the
	 * instances using it (live state), membership management, and the update
	 * tools — push the group's plugins to every user and restart them now, on a
	 * schedule, or not at all.
	 */

	const name = $derived(page.params.name);

	let data: any = $state(null);
	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let busy = $state('');

	let description = $state('');
	let addOpen = $state(false);
	let deleteOpen = $state(false);

	let restartOpen = $state(false);
	let restartMode = $state('now');
	let restartAt = $state('');
	/** what confirmed restart choice applies to: a pending save or a plain sync */
	let pendingPlugins: string[] | null = $state(null);

	async function refresh(): Promise<void> {
		loading = true;

		try {
			data = await api(`/plugins/groups/${name}`);
			description = data.description;
			lastUpdated = Date.now();
		} catch (err) {
			Notify.error(`Could not load group ${name}`, { detail: (err as Error).message });
		}

		loading = false;
	}

	onMount(() => {
		void refresh();
	});

	const memberNames = $derived((data?.plugins ?? []).map((entry: any) => entry.plugin));

	const addable = $derived(
		(data?.pluginNames ?? []).filter((plugin: string) => !memberNames.includes(plugin))
	);

	/** Save a membership/description change, then apply the restart choice. */
	async function save(plugins: string[], restart?: { mode: string; at?: string }): Promise<void> {
		busy = 'save';

		const note = Notify.loading(`Saving group ${name}…`);

		try {
			const result = await patch(`/plugins/groups/${name}`, {
				plugins,
				description,
				restart
			});

			const bits = [`${result.group.plugins.length} plugin(s)`];

			if (result.deployed) {
				bits.push(`${result.deployed} deploy change(s)`);
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
	function changeMembers(plugins: string[]): void {
		pendingPlugins = plugins;
		restartMode = 'none';
		restartAt = '';
		restartOpen = true;
	}

	/** Push the group's current members to every instance using it. */
	function syncInstances(): void {
		pendingPlugins = null;
		restartMode = 'now';
		restartAt = '';
		restartOpen = true;
	}

	async function confirmRestart(): Promise<void> {
		const restart =
			restartMode === 'none'
				? undefined
				: { mode: restartMode, at: restartAt || undefined };

		restartOpen = false;

		if (pendingPlugins) {
			await save(pendingPlugins, restart);

			return;
		}

		busy = 'sync';

		const note = Notify.loading(`Updating the instances using ${name}…`);

		try {
			const result = await post(`/plugins/groups/${name}`, { action: 'sync', restart });

			const bits = [`${result.deployed} deploy change(s)`];

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
			await del(`/plugins/groups/${name}`);

			Notify.success(`Group ${name} deleted`, {
				detail: 'Deployed jars stay on the instances until removed.'
			});

			await goto('/plugins/groups');
		} catch (err) {
			Notify.error(`Could not delete ${name}`, { detail: (err as Error).message });
			deleteOpen = false;
		}
	}

	const pluginCols: Column[] = [
		{ id: 'plugin', label: 'Plugin', sortable: true },
		{ id: 'families', label: 'Families' },
		{ id: 'versions', label: 'Primary versions' },
		{ id: 'actions', label: '', width: 110, align: 'right' }
	];

	const instCols: Column[] = [
		{ id: 'name', label: 'Instance', sortable: true },
		{ id: 'state', label: 'State', width: 140 },
		{ id: 'env', label: 'Environment' }
	];
</script>

<svelte:head><title>{name} | Plugin groups | Luna Console</title></svelte:head>

{#if data}
	<PageHeader title={name ?? ''} info>
		{#snippet extra()}
			{#if data.builtin}<StatusBadge state="ok" label="builtin" />{/if}
		{/snippet}
		{#snippet actions()}
			<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="plugin-group" />
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
						void save(memberNames);
					}
				}}
			/>
		</label>
		{#if data.builtin}
			<p class="dim note">
				The default group applies to every instance; its baseline members are locked and can
				only be joined by extras.
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
			<Btn icon="plus" disabled={!!busy} onclick={() => (addOpen = true)}>Add a plugin</Btn>
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
				{:else if col === 'actions'}
					<Btn
						variant="icon"
						icon="trash"
						title={row.locked ? 'Baseline members of the default group are locked' : 'Remove from the group'}
						disabled={row.locked || !!busy}
						onclick={() =>
							changeMembers(memberNames.filter((plugin: string) => plugin !== row.plugin))}
					/>
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
	title="Add plugins to {name}"
	description="Every family of a picked plugin deploys where it fits on the instances using this group."
	selectLabel="Plugins"
	options={addable}
	onconfirm={(names) => changeMembers([...memberNames, ...names])}
/>

<!-- restart choice for member changes and syncs -->
<Modal title="Apply to the instances using {name}" bind:open={restartOpen}>
	<p class="dim intro">
		The change deploys immediately; running servers load it on their next restart. Pick what
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
			{pendingPlugins ? 'Save & apply' : 'Update instances'}
		</Btn>
	{/snippet}
</Modal>

<Modal title="Delete group {name}" bind:open={deleteOpen}>
	<p>
		Removes the group from the registry. Instances stop receiving its plugins on their next
		deploy; jars already on disk stay until removed.
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

	.at {
		margin-top: 0.5rem;
	}
</style>
