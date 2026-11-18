<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { t } from '$lib/i18n.svelte';
	import { api, post } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import { Notify } from '$lib/notifications.svelte';
	import ScreenLink from '$lib/components/ScreenLink.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import NodeEditorModal from '$lib/components/NodeEditorModal.svelte';
	import type { NodeSpec } from '$lib/components/nodes';
	import Panel from '$lib/components/Panel.svelte';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import Select from '$lib/components/Select.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { menuGroups, type ContextMenuItem } from '$lib/components/contextmenu';
	import type { Column } from '$lib/components/table';
	import type { PermNode } from './player';

	/**
	 * A player's LuckPerms groups and the permission nodes set on them directly.
	 * Group membership is where most of a player's permissions come from, so it
	 * leads; the nodes under it are the exceptions made for this one player.
	 */
	let {
		player,
		active,
		refreshKey,
		servers
	}: {
		/** The uuid or name the profile was opened with */
		player: string;
		/** Whether this tab is the one on screen; a hidden tab waits for its turn to reload */
		active: boolean;
		/** Bumped by the screen on each refresh */
		refreshKey: number;
		/** Backends a node's server context can name */
		servers: string[];
	} = $props();

	interface GroupRow {
		name: string;
		displayName: string;
		primary: boolean;
	}

	let available = $state(true);
	let problem = $state('');
	let userGroups: string[] = $state([]);
	let primaryGroup = $state('');
	let nodes: PermNode[] = $state([]);
	let allGroups: Array<{ name: string; displayName: string }> = $state([]);
	let loaded = $state(false);
	let loadedKey = -1;

	let groupPick = $state('');
	let editorOpen = $state(false);
	let editing: PermNode | null = $state(null);

	const path = $derived(`/players/${encodeURIComponent(player)}/permissions`);

	async function load(): Promise<void> {
		try {
			const [user, groups] = await Promise.all([api(path), api('/permissions/groups')]);

			if (user.available === false) {
				available = false;
				problem = user.error ?? '';
				return;
			}

			available = true;
			primaryGroup = user.primaryGroup ?? '';
			userGroups = user.groups ?? [];
			nodes = user.nodes ?? [];
			allGroups = groups.available === false ? [] : (groups.groups ?? []);

			if (!groupPick) {
				groupPick = joinable[0]?.name ?? '';
			}
		} catch (err) {
			available = false;
			problem = (err as Error).message;
		} finally {
			loaded = true;
		}
	}

	$effect(() => {
		if (active && loadedKey !== refreshKey) {
			loadedKey = refreshKey;
			untrack(() => void load());
		}
	});

	const groupRows: GroupRow[] = $derived(
		userGroups.map((name) => ({
			name,
			displayName: allGroups.find((group) => group.name === name)?.displayName ?? '',
			primary: name === primaryGroup
		}))
	);

	/** Groups the player is not in yet: the only ones worth offering to add. */
	const joinable = $derived(allGroups.filter((group) => !userGroups.includes(group.name)));

	$effect(() => {
		if (!joinable.some((group) => group.name === groupPick)) {
			groupPick = joinable[0]?.name ?? '';
		}
	});

	async function act(run: () => Promise<any>, busy: string, done: string): Promise<void> {
		const note = Notify.loading(busy);

		try {
			const result = await run();

			if (result?.ok === false) {
				throw new Error(result.error ?? '');
			}

			note.set({ level: 'success', message: done, closeable: true });
		} catch (err) {
			note.set({ level: 'error', message: busy, detail: (err as Error).message, closeable: true });
		}

		await load();
	}

	async function editGroups(action: 'add' | 'remove' | 'set', group: string): Promise<void> {
		const done = action === 'add'
			? t('web.playerDetail.groupAdded', { group })
			: action === 'remove'
				? t('web.playerDetail.groupRemoved', { group })
				: t('web.playerDetail.groupSetOnly', { group });

		await act(
			() => post(path, { op: 'group', action, group }),
			t('web.playerDetail.updatingGroups'),
			done
		);
	}

	function contextsOf(node: PermNode): Record<string, string> {
		const contexts: Record<string, string> = {};

		for (const pair of node.contexts) {
			contexts[pair.key] = pair.value;
		}

		return contexts;
	}

	async function removeNode(node: PermNode): Promise<void> {
		await act(
			() => post(path, { op: 'node', action: 'remove', key: node.key, contexts: contextsOf(node) }),
			t('web.playerDetail.removingNode', { key: node.key }),
			t('web.playerDetail.nodeRemoved', { key: node.key })
		);
	}

	function openEditor(node: PermNode | null): void {
		editing = node;
		editorOpen = true;
	}

	/** Apply the node editor's result: an edit removes the original first. */
	async function saveNode(spec: NodeSpec): Promise<void> {
		const original = editing;

		await act(
			async () => {
				if (original) {
					await post(path, {
						op: 'node',
						action: 'remove',
						key: original.key,
						contexts: contextsOf(original)
					});
				}

				return await post(path, {
					op: 'node',
					action: 'add',
					key: spec.key,
					value: spec.value,
					...(spec.expirySeconds > 0 ? { expirySeconds: spec.expirySeconds } : {}),
					...(Object.keys(spec.contexts).length > 0 ? { contexts: spec.contexts } : {})
				});
			},
			original
				? t('web.playerDetail.savingNode', { key: spec.key })
				: t('web.playerDetail.addingNode', { key: spec.key }),
			original
				? t('web.playerDetail.nodeSaved', { key: spec.key })
				: t('web.playerDetail.nodeAdded', { key: spec.key })
		);
	}

	const groupCols: Column[] = $derived([
		{ id: 'name', label: t('web.playerDetail.group'), minWidth: 180 },
		{ id: 'display', label: t('web.playerDetail.displayName') },
		{ id: 'role', label: t('web.playerDetail.role'), width: 160 }
	]);

	function groupActions(row: GroupRow): ContextMenuItem[] {
		return menuGroups(
			[
				{
					label: t('web.playerDetail.openGroup'),
					icon: 'key',
					action: () => goto(`/permissions/${encodeURIComponent(row.name)}`)
				}
			],
			[
				{
					label: t('web.playerDetail.setAsOnlyGroup'),
					icon: 'userTick',
					disabled: userGroups.length === 1,
					hint: userGroups.length === 1 ? t('web.playerDetail.alreadyOnlyGroup') : undefined,
					action: () => void editGroups('set', row.name)
				}
			],
			[
				{
					label: t('web.playerDetail.removeFromGroup'),
					icon: 'userMinus',
					color: 'danger',
					action: () => void editGroups('remove', row.name)
				}
			]
		);
	}

	const nodeCols: Column[] = $derived([
		{ id: 'key', label: t('web.playerDetail.node2'), minWidth: 240 },
		{ id: 'value', label: t('web.playerDetail.value'), width: 130 },
		{ id: 'type', label: t('web.playerDetail.type'), width: 130 },
		{ id: 'contexts', label: t('web.playerDetail.contexts') },
		{ id: 'expiry', label: t('web.playerDetail.expires') }
	]);

	function nodeActions(node: PermNode): ContextMenuItem[] {
		return menuGroups(
			[
				{
					label: t('web.playerDetail.editNode'),
					icon: 'pen',
					action: () => openEditor(node)
				}
			],
			[
				{
					label: t('web.playerDetail.removeNode'),
					icon: 'trash',
					color: 'danger',
					action: () => void removeNode(node)
				}
			]
		);
	}
</script>

{#if !available}
	<Flash kind="warning">
		<b>{t('web.playerDetail.luckpermsIsNotAnswering')}</b> {problem}
	</Flash>
{:else}
	<Panel
		title={t('web.playerDetail.groups')}
		count={loaded ? userGroups.length : undefined}
		description={t('web.playerDetail.primaryGroupIsTheOne')}
		flush
	>
		{#snippet actions()}
			<Select
				bind:value={groupPick}
				ariaLabel={t('web.playerDetail.group')}
				options={joinable.map((group) => ({ value: group.name, label: group.name }))}
				width="12rem"
				disabled={joinable.length === 0}
			/>
			<Btn
				onclick={() => void editGroups('set', groupPick)}
				disabled={!groupPick}
				title={groupPick ? undefined : t('web.playerDetail.inEveryGroup')}
			>
				{t('web.playerDetail.setAsOnlyGroup')}
			</Btn>
			<Btn
				variant="primary"
				icon="plus"
				onclick={() => void editGroups('add', groupPick)}
				disabled={!groupPick}
				title={groupPick ? undefined : t('web.playerDetail.inEveryGroup')}
			>
				{t('web.playerDetail.addGroup')}
			</Btn>
		{/snippet}

		<DataTable
			columns={groupCols}
			rows={groupRows}
			loading={!loaded}
			getId={(row) => row.name}
			rowActions={groupActions}
			rowLabel={(row) => row.name}
			emptyTitle={t('web.playerDetail.noGroups')}
			emptyText={t('web.playerDetail.noGroupMembershipsLuckperms')}
		>
			{#snippet cell(row, col)}
				{#if col === 'name'}
					<ScreenLink href="/permissions/{encodeURIComponent(row.name)}">{row.name}</ScreenLink>
				{:else if col === 'display'}
					{row.displayName || '–'}
				{:else if col === 'role'}
					{#if row.primary}
						<StatusBadge state="info" label={t('web.playerDetail.primary')} />
					{:else}
						<span class="dim">–</span>
					{/if}
				{/if}
			{/snippet}
		</DataTable>
	</Panel>

	<Panel
		title={t('web.playerDetail.permissionNodes')}
		count={loaded ? nodes.length : undefined}
		description={t('web.playerDetail.directNodesOnlyPermissionsInherited')}
		flush
	>
		{#snippet actions()}
			<Btn variant="primary" icon="plus" onclick={() => openEditor(null)}>{t('web.playerDetail.addNode')}</Btn>
		{/snippet}

		<ResourceTable
			tableId="player-nodes"
			loading={!loaded}
			columns={nodeCols}
			rows={nodes}
			getId={(node) => `${node.key}|${node.contexts.map((pair) => `${pair.key}=${pair.value}`).join(',')}`}
			searchValue={(node) => node.key}
			searchPlaceholder={t('web.playerDetail.findNode')}
			noun={t('web.playerDetail.node')}
			pageSize={25}
			rowActions={nodeActions}
			rowLabel={(node) => node.key}
			emptyTitle={t('web.playerDetail.noNodesOnThisUser')}
		>
			{#snippet cell(node, col)}
				{#if col === 'key'}
					<span class="mono">{node.key}</span>
				{:else if col === 'value'}
					<StatusBadge
						state={node.value ? 'passed' : 'failed'}
						label={node.value ? t('web.playerDetail.granted') : t('web.playerDetail.negated')}
					/>
				{:else if col === 'type'}
					<span class="dim">{node.type}</span>
				{:else if col === 'contexts'}
					{#if node.contexts.length > 0}
						<span class="mono dim">
							{node.contexts.map((pair) => `${pair.key}=${pair.value}`).join(', ')}
						</span>
					{:else}
						<span class="dim">{t('web.playerDetail.global')}</span>
					{/if}
				{:else if col === 'expiry'}
					<DateTime
						at={node.expiryEpochMillis || null}
						text={node.expiryEpochMillis ? fmtDateTime(node.expiryEpochMillis) : undefined}
						empty={t('web.access.never')}
					/>
				{/if}
			{/snippet}
		</ResourceTable>
	</Panel>
{/if}

<NodeEditorModal
	bind:open={editorOpen}
	node={editing}
	{servers}
	onsubmit={(spec) => void saveNode(spec)}
/>
