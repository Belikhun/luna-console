<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import Wizard from '$lib/components/Wizard.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Select from '$lib/components/Select.svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import type { Column } from '$lib/components/table';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * Edit one LuckPerms group as a wizard: everything is edited locally -
	 * meta, parents, permission nodes; and nothing reaches LuckPerms until the
	 * single save, which diffs the form against what was loaded and applies
	 * only the changes. Parents and meta are edited through their own fields,
	 * so the node table shows plain permission nodes only; inheritance and
	 * meta nodes would double-represent them.
	 */

	interface PermNode {
		key: string;
		value: boolean;
		type: string;
		expiryEpochMillis: number;
		contexts: Array<{ key: string; value: string }>;
	}

	/** Node types the meta fields and parent chips already represent. */
	const HIDDEN_NODE_TYPES = new Set(['inheritance', 'prefix', 'suffix', 'weight', 'display_name']);

	const name = $derived(page.params.name ?? '');

	let loading = $state(true);
	let saving = $state(false);
	let missing = $state('');

	// the form
	let weight = $state(0);
	let displayName = $state('');
	let prefix = $state('');
	let suffix = $state('');
	let parents: string[] = $state([]);
	let nodes: PermNode[] = $state([]);

	// what was loaded, for the diff on save
	let initialWeight = 0;
	let initialDisplay = '';
	let initialPrefix = '';
	let initialSuffix = '';
	let initialParents: string[] = [];
	let initialNodes: PermNode[] = [];

	/** Facts the form shows but does not edit. */
	let members: Array<{ uuid: string; username: string }> = $state([]);
	let otherGroups: string[] = $state([]);

	// node add form
	let nodeKey = $state('');
	let nodeGrant = $state(true);
	let nodeServer = $state('');
	let parentPick = $state('');
	let servers: string[] = $state([]);

	function nodeIdentity(node: PermNode): string {
		const contexts = [...node.contexts]
			.map((pair) => `${pair.key}=${pair.value}`)
			.sort()
			.join(',');

		return `${node.key.toLowerCase()}|${contexts}`;
	}

	async function load(): Promise<void> {
		loading = true;

		try {
			const data = await api(`/permissions/groups/${encodeURIComponent(name)}`);

			if (data.available === false) {
				throw new Error(data.error ?? 'group not found');
			}

			weight = data.weight ?? 0;
			displayName = data.displayName ?? '';
			prefix = data.prefix ?? '';
			suffix = data.suffix ?? '';
			parents = [...(data.parents ?? [])];
			nodes = (data.nodes ?? []).filter((node: PermNode) => !HIDDEN_NODE_TYPES.has(node.type));
			members = data.members ?? [];

			initialWeight = weight;
			initialDisplay = displayName;
			initialPrefix = prefix;
			initialSuffix = suffix;
			initialParents = [...parents];
			initialNodes = [...nodes];
		} catch (err) {
			missing = (err as Error).message;
		}

		loading = false;
	}

	onMount(() => {
		void load();

		void api('/permissions/groups').then((data) => {
			otherGroups = (data.groups ?? [])
				.map((group: any) => String(group.name))
				.filter((groupName: string) => groupName !== name);
		});

		void api('/instances').then((data) => {
			servers = data.instances
				.filter((inst: any) => inst.name !== 'proxy')
				.map((inst: any) => inst.name)
				.sort();
		});
	});

	function addNode(): void {
		const key = nodeKey.trim();

		if (!key) {
			return;
		}

		const draft: PermNode = {
			key,
			value: nodeGrant,
			type: 'permission',
			expiryEpochMillis: 0,
			contexts: nodeServer ? [{ key: 'server', value: nodeServer }] : []
		};

		// same key + contexts replaces the row; LuckPerms would reject the duplicate
		nodes = [...nodes.filter((node) => nodeIdentity(node) !== nodeIdentity(draft)), draft];
		nodeKey = '';
	}

	function removeNode(target: PermNode): void {
		nodes = nodes.filter((node) => node !== target);
	}

	function addParent(): void {
		if (parentPick && !parents.includes(parentPick)) {
			parents = [...parents, parentPick];
		}

		parentPick = '';
	}

	function removeParent(target: string): void {
		parents = parents.filter((parent) => parent !== target);
	}

	/** The change set the save applies, kept derived so the recap can show it. */
	const changes = $derived.by(() => {
		const out: string[] = [];

		if (weight !== initialWeight) {
			out.push(`weight ${initialWeight} → ${weight}`);
		}

		if (displayName !== initialDisplay) {
			out.push('display name');
		}

		if (prefix !== initialPrefix) {
			out.push('prefix');
		}

		if (suffix !== initialSuffix) {
			out.push('suffix');
		}

		const addedParents = parents.filter((parent) => !initialParents.includes(parent));
		const removedParents = initialParents.filter((parent) => !parents.includes(parent));

		if (addedParents.length + removedParents.length > 0) {
			out.push(`parents +${addedParents.length}/−${removedParents.length}`);
		}

		const before = new Map(initialNodes.map((node) => [nodeIdentity(node), node]));
		const after = new Map(nodes.map((node) => [nodeIdentity(node), node]));
		let addedNodes = 0;
		let removedNodes = 0;

		for (const [id, node] of after) {
			const previous = before.get(id);

			if (!previous || previous.value !== node.value) {
				addedNodes++;
			}
		}

		for (const [id, node] of before) {
			const next = after.get(id);

			if (!next || next.value !== node.value) {
				removedNodes++;
			}
		}

		if (addedNodes + removedNodes > 0) {
			out.push(`nodes +${addedNodes}/−${removedNodes}`);
		}

		return out;
	});

	async function save(): Promise<void> {
		saving = true;

		const note = Notify.loading(`Saving ${name}…`);
		const groupPath = `/permissions/groups/${encodeURIComponent(name)}`;

		try {
			if (weight !== initialWeight) {
				await post(groupPath, { op: 'meta', field: 'weight', value: String(weight) });
			}

			if (displayName !== initialDisplay) {
				await post(groupPath, { op: 'meta', field: 'displayname', value: displayName });
			}

			if (prefix !== initialPrefix) {
				await post(groupPath, { op: 'meta', field: 'prefix', value: prefix });
			}

			if (suffix !== initialSuffix) {
				await post(groupPath, { op: 'meta', field: 'suffix', value: suffix });
			}

			for (const parent of initialParents.filter((entry) => !parents.includes(entry))) {
				await post(groupPath, { op: 'node', action: 'remove', key: `group.${parent}` });
			}

			for (const parent of parents.filter((entry) => !initialParents.includes(entry))) {
				await post(groupPath, { op: 'node', action: 'add', key: `group.${parent}` });
			}

			// a changed value is a remove + add: identity is key + contexts
			const before = new Map(initialNodes.map((node) => [nodeIdentity(node), node]));
			const after = new Map(nodes.map((node) => [nodeIdentity(node), node]));

			for (const [id, node] of before) {
				const next = after.get(id);

				if (!next || next.value !== node.value) {
					const contexts: Record<string, string> = {};

					for (const pair of node.contexts) {
						contexts[pair.key] = pair.value;
					}

					await post(groupPath, { op: 'node', action: 'remove', key: node.key, contexts });
				}
			}

			for (const [id, node] of after) {
				const previous = before.get(id);

				if (!previous || previous.value !== node.value) {
					const contexts: Record<string, string> = {};

					for (const pair of node.contexts) {
						contexts[pair.key] = pair.value;
					}

					await post(groupPath, { op: 'node', action: 'add', key: node.key, value: node.value, contexts });
				}
			}

			note.set({ level: 'success', message: `${name} saved`, closeable: true });

			await goto(`/permissions/${encodeURIComponent(name)}`);
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not save ${name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}

		saving = false;
	}

	const nodeCols: Column[] = $derived([
		{ id: 'key', label: t('web.permEdit.node'), minWidth: 240 },
		{ id: 'value', label: t('web.permEdit.value'), width: 110 },
		{ id: 'contexts', label: t('web.permEdit.contexts') },
		{ id: 'expiry', label: t('web.permEdit.expires') }
	]);

	function nodeRowActions(node: PermNode): ContextMenuItem[] {
		return [
			{
				label: node.value ? 'Negate node' : 'Grant node',
				icon: 'rotate',
				action: () => {
					nodes = nodes.map((entry) => (entry === node ? { ...entry, value: !entry.value } : entry));
				}
			},
			{
				label: t('web.permEdit.removeNode'),
				icon: 'trash',
				color: 'danger',
				action: () => removeNode(node)
			}
		];
	}

	const parentOptions = $derived([
		{ value: '', label: t('web.permEdit.pickAGroup') },
		...otherGroups
			.filter((groupName) => !parents.includes(groupName))
			.map((groupName) => ({ value: groupName, label: groupName }))
	]);
</script>

{#if missing}
	<Wizard
		title="Edit group {name}"
		submitLabel={t('web.permEdit.saveChanges')}
		disabled
		onsubmit={() => {}}
	>
		{#snippet summary()}
			{t('web.permEdit.groupNotFound')}
		{/snippet}

		<Panel title={t('web.permEdit.unknownGroup')}>
			<p class="dim">
				{missing}; it may have been deleted, or LuckPerms is not answering.
				<a href="/permissions">{t('web.permEdit.backToPermissionGroups')}</a>
			</p>
		</Panel>
	</Wizard>
{:else}
	<Wizard
		title="Edit group {name}"
		windowTitle="Edit {name}"
		description={t('web.permEdit.changesAreHeldInThe')}
		submitLabel={t('web.permEdit.saveChanges')}
		disabled={loading || changes.length === 0}
		loading={saving}
		onsubmit={save}
	>
		{#snippet summary()}
			{#if loading}
				loading…
			{:else if changes.length === 0}
				{t('web.permEdit.noChangesYet')}
			{:else}
				{changes.join(' · ')}
			{/if}
		{/snippet}

		<Panel
			title={t('web.permEdit.meta')}
			description={t('web.permEdit.weightDecidesWhichGroupWins')}
		>
			<div class="meta">
				<label class="field">
					<span class="lbl">{t('web.permEdit.weight')}</span>
					<input class="input num" type="number" bind:value={weight} disabled={loading} />
				</label>
				<label class="field">
					<span class="lbl">{t('web.permEdit.displayName')}</span>
					<input class="input" bind:value={displayName} placeholder={name} disabled={loading} />
				</label>
				<label class="field">
					<span class="lbl">{t('web.permEdit.prefix')}</span>
					<input class="input mono" bind:value={prefix} placeholder={t('web.permEdit.eG6Admin')} disabled={loading} />
				</label>
				<label class="field">
					<span class="lbl">{t('web.permEdit.suffix')}</span>
					<input class="input mono" bind:value={suffix} disabled={loading} />
				</label>
			</div>
		</Panel>

		<Panel
			title={t('web.permEdit.inheritsFrom')}
			count={parents.length}
			description={t('web.permEdit.parentsContributeEveryNodeThey')}
		>
			<div class="chips">
				{#each parents as parent}
					<span class="chip">
						{parent}
						<button
							class="chipbtn"
							title="Stop inheriting from {parent}"
							onclick={() => removeParent(parent)}
						>×</button>
					</span>
				{:else}
					<span class="dim">{t('web.permEdit.noParentsThisGroup')}</span>
				{/each}
			</div>
			<div class="chipadd">
				<Select bind:value={parentPick} options={parentOptions} width="14rem" />
				<Btn icon="plus" disabled={!parentPick} onclick={addParent}>{t('web.permEdit.addParent')}</Btn>
			</div>
		</Panel>

		<Panel
			flush
			title={t('web.permEdit.permissionNodes')}
			count={nodes.length}
			description={t('web.permEdit.plainPermissionNodesParentsAnd')}
		>
			<div class="nodeadd">
				<input class="input key" bind:value={nodeKey} placeholder={t('web.permEdit.permissionNodeKey')} disabled={loading} />
				<label class="grant">
					<Toggle checked={nodeGrant} onchange={(checked) => (nodeGrant = checked)} />
					<span>{nodeGrant ? 'granted' : 'negated'}</span>
				</label>
				<Select
					bind:value={nodeServer}
					options={[
						{ value: '', label: t('web.permEdit.everyServer') },
						...servers.map((server) => ({ value: server, label: `server=${server}` }))
					]}
					width="13rem"
				/>
				<Btn icon="plus" disabled={!nodeKey.trim()} onclick={addNode}>{t('web.permEdit.addNode')}</Btn>
			</div>

			<DataTable
				tableId="group-edit-nodes"
				columns={nodeCols}
				rows={nodes}
				getId={nodeIdentity}
				rowActions={nodeRowActions}
				rowLabel={(node) => node.key}
				paging
				pageSize={25}
				emptyTitle={t('web.permEdit.noNodes')}
				emptyText={t('web.permEdit.addPermissionNodesAboveThey')}
			>
				{#snippet cell(node, col)}
					{#if col === 'key'}
						<span class="mono">{node.key}</span>
					{:else if col === 'value'}
						<StatusBadge state={node.value ? 'passed' : 'failed'} label={node.value ? 'true' : 'false'} />
					{:else if col === 'contexts'}
						{#if node.contexts.length > 0}
							<span class="mono dim">
								{node.contexts.map((pair) => `${pair.key}=${pair.value}`).join(', ')}
							</span>
						{:else}
							<span class="dim">{t('web.permEdit.global')}</span>
						{/if}
					{:else if col === 'expiry'}
						{node.expiryEpochMillis ? fmtDateTime(node.expiryEpochMillis) : 'never'}
					{/if}
				{/snippet}
			</DataTable>
		</Panel>

		<Panel
			title={t('web.permEdit.members')}
			count={members.length}
			description={t('web.permEdit.playersHoldingThisGroupDirectly')}
		>
			<div class="chips">
				{#each members as member}
					<a class="chip" href="/players/{member.uuid}">
						{member.username || member.uuid}
					</a>
				{:else}
					<span class="dim">{t('web.permEdit.nobodyHoldsThisGroup')}</span>
				{/each}
			</div>
		</Panel>
	</Wizard>
{/if}

<style lang="scss">
	.meta {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 1rem;

		@include below($bp-medium) {
			grid-template-columns: 1fr;
		}
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.lbl {
		font-weight: 700;
		color: var(--text-heading);
	}

	// wide enough for any weight anyone would type, narrow enough not to read
	// as a text field
	.num {
		width: 8rem;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 1rem;

		&:last-child {
			margin-bottom: 0;
		}
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0.75rem;
		background: var(--bg-panel-raised);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-button);
	}

	.chipbtn {
		border: none;
		background: none;
		color: var(--text-secondary);
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 0.125rem;

		&:hover {
			color: var(--error);
		}
	}

	.chipadd {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.nodeadd {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		padding: 0.75rem 1rem;
		border-bottom: 0.1rem solid var(--border-divider);

		.key {
			flex: 1;
			min-width: 14rem;
		}
	}

	.grant {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--text-secondary);
	}
</style>
