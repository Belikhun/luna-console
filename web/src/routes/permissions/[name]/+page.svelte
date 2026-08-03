<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, post, del } from '$lib/api';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import RefreshControl from '$lib/components/RefreshControl.svelte';
	import OverviewBar from '$lib/components/OverviewBar.svelte';
	import OverviewCell from '$lib/components/OverviewCell.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import ResourceTable from '$lib/components/ResourceTable.svelte';
	import type { Column, TableFilterGroup } from '$lib/components/table';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import PlayerSkin from '$lib/components/PlayerSkin.svelte';
	import NodeEditorModal from '$lib/components/NodeEditorModal.svelte';
	import type { NodeSpec } from '$lib/components/nodes';
	import Modal from '$lib/components/Modal.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { Notify } from '$lib/notifications.svelte';

	/**
	 * One LuckPerms group, read like a resource: identity and meta, the full
	 * node list (inheritance and meta nodes included — this screen hides
	 * nothing), and the direct members, each with their own verbs. Structural
	 * editing lives in the edit wizard; the administration verbs here are the
	 * ones an operator reaches for while *reading* — add or remove a member,
	 * drop a single node, clone the group as a starting point, delete it.
	 */

	interface PermNode {
		key: string;
		value: boolean;
		type: string;
		expiryEpochMillis: number;
		contexts: Array<{ key: string; value: string }>;
	}

	interface Member {
		uuid: string;
		username: string;
	}

	const name = $derived(page.params.name ?? '');

	let loading = $state(true);
	let lastUpdated: number | null = $state(null);
	let available = $state(true);
	let missing = $state(false);
	let problem = $state('');

	let displayName = $state('');
	let weight = $state(0);
	let prefix = $state('');
	let suffix = $state('');
	let parents: string[] = $state([]);
	let nodes: PermNode[] = $state([]);
	let members: Member[] = $state([]);

	// dialogs
	let addMemberOpen = $state(false);
	let addMemberName = $state('');
	let cloneOpen = $state(false);
	let cloneName = $state('');
	let deleteOpen = $state(false);
	let nodeEditorOpen = $state(false);
	let nodeBeingEdited: PermNode | null = $state(null);
	let servers: string[] = $state([]);

	async function refresh(): Promise<void> {
		try {
			const data = await api(`/permissions/groups/${encodeURIComponent(name)}`);

			if (data.available === false) {
				available = false;
				problem = data.error ?? 'LuckPerms is unreachable';
			} else {
				available = true;
				problem = '';
				displayName = data.displayName ?? '';
				weight = data.weight ?? 0;
				prefix = data.prefix ?? '';
				suffix = data.suffix ?? '';
				parents = data.parents ?? [];
				nodes = data.nodes ?? [];
				members = data.members ?? [];
			}

			lastUpdated = Date.now();
		} catch (err) {
			// the route answers 404 for a group LuckPerms does not know
			missing = true;
			problem = (err as Error).message;
		}

		loading = false;
	}

	onMount(() => {
		void refresh();

		// backend names feed the node editor's server-context shortcut
		void api('/instances').then((data) => {
			servers = data.instances
				.filter((inst: any) => inst.name !== 'proxy')
				.map((inst: any) => inst.name)
				.sort();
		});
	});

	async function act(run: () => Promise<any>, pending: string, done: string): Promise<void> {
		const note = Notify.loading(pending);

		try {
			const result = await run();

			if (result?.ok === false) {
				throw new Error(result.error ?? 'LuckPerms refused the change');
			}

			note.set({ level: 'success', message: done, closeable: true });

			await refresh();
		} catch (err) {
			note.set({ level: 'error', message: pending, detail: (err as Error).message, closeable: true });
		}
	}

	async function copy(text: string): Promise<void> {
		const { copyText } = await import('$lib/clipboard');

		await copyText(text);
	}

	// ------------------------------------------------------------- admin verbs

	function headerActions(): ContextMenuItem[] {
		return [
			{
				label: 'Add a member…',
				icon: 'userPlus',
				action: () => {
					addMemberName = '';
					addMemberOpen = true;
				}
			},
			{
				label: 'Clone group…',
				icon: 'copy',
				action: () => {
					cloneName = '';
					cloneOpen = true;
				}
			},
			{
				label: 'Copy name',
				icon: 'clipboard',
				action: () => void copy(name)
			},
			{ separator: true },
			{
				label: 'Delete group',
				icon: 'trash',
				color: 'danger',
				disabled: name === 'default',
				hint: name === 'default' ? 'LuckPerms requires it' : undefined,
				action: () => {
					deleteOpen = true;
				}
			}
		];
	}

	async function doAddMember(): Promise<void> {
		const player = addMemberName.trim();

		addMemberOpen = false;

		if (!player) {
			return;
		}

		await act(
			() =>
				post(`/players/${encodeURIComponent(player)}/permissions`, {
					op: 'group',
					action: 'add',
					group: name
				}),
			`Adding ${player} to ${name}…`,
			`${player} added to ${name}`
		);
	}

	async function removeMember(member: Member): Promise<void> {
		await act(
			() =>
				post(`/players/${encodeURIComponent(member.uuid)}/permissions`, {
					op: 'group',
					action: 'remove',
					group: name
				}),
			`Removing ${member.username || member.uuid} from ${name}…`,
			`${member.username || member.uuid} removed from ${name}`
		);
	}

	/**
	 * Clone: create the target group with the same weight and display name,
	 * then copy every node across. Temporary nodes keep their remaining
	 * lifetime; already-expired ones are skipped.
	 */
	async function doClone(): Promise<void> {
		const target = cloneName.trim().toLowerCase();

		cloneOpen = false;

		if (!target) {
			return;
		}

		const note = Notify.loading(`Cloning ${name} to ${target}…`);

		try {
			const created = await post('/permissions/groups', {
				name: target,
				weight,
				...(displayName ? { displayName } : {})
			});

			if (created?.ok === false) {
				throw new Error(created.error ?? 'could not create the group');
			}

			let copied = 0;

			for (const node of nodes) {
				const remaining = node.expiryEpochMillis
					? Math.floor((node.expiryEpochMillis - Date.now()) / 1000)
					: 0;

				if (node.expiryEpochMillis && remaining <= 0) {
					continue;
				}

				const contexts: Record<string, string> = {};

				for (const pair of node.contexts) {
					contexts[pair.key] = pair.value;
				}

				await post(`/permissions/groups/${encodeURIComponent(target)}`, {
					op: 'node',
					action: 'add',
					key: node.key,
					value: node.value,
					...(remaining > 0 ? { expirySeconds: remaining } : {}),
					...(Object.keys(contexts).length > 0 ? { contexts } : {})
				});
				copied++;
			}

			note.set({
				level: 'success',
				message: `${target} created with ${copied} node(s) from ${name}`,
				closeable: true
			});

			await goto(`/permissions/${encodeURIComponent(target)}`);
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not clone ${name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	async function doDelete(): Promise<void> {
		deleteOpen = false;

		const note = Notify.loading(`Deleting ${name}…`);

		try {
			const result = await del(`/permissions/groups/${encodeURIComponent(name)}`);

			if (result?.ok === false) {
				throw new Error(result.error ?? 'LuckPerms refused the deletion');
			}

			note.set({ level: 'success', message: `Group ${name} deleted`, closeable: true });

			await goto('/permissions');
		} catch (err) {
			note.set({
				level: 'error',
				message: `Could not delete ${name}`,
				detail: (err as Error).message,
				closeable: true
			});
		}
	}

	async function removeNode(node: PermNode): Promise<void> {
		const contexts: Record<string, string> = {};

		for (const pair of node.contexts) {
			contexts[pair.key] = pair.value;
		}

		await act(
			() =>
				post(`/permissions/groups/${encodeURIComponent(name)}`, {
					op: 'node',
					action: 'remove',
					key: node.key,
					contexts
				}),
			`Removing ${node.key}…`,
			`Node ${node.key} removed`
		);
	}

	function openNodeEditor(node: PermNode | null): void {
		nodeBeingEdited = node;
		nodeEditorOpen = true;
	}

	/** Apply the editor's result: an edit removes the original node first. */
	async function saveNode(spec: NodeSpec): Promise<void> {
		const original = nodeBeingEdited;
		const groupPath = `/permissions/groups/${encodeURIComponent(name)}`;

		await act(
			async () => {
				if (original) {
					const originalContexts: Record<string, string> = {};

					for (const pair of original.contexts) {
						originalContexts[pair.key] = pair.value;
					}

					await post(groupPath, {
						op: 'node',
						action: 'remove',
						key: original.key,
						contexts: originalContexts
					});
				}

				return await post(groupPath, {
					op: 'node',
					action: 'add',
					key: spec.key,
					value: spec.value,
					...(spec.expirySeconds > 0 ? { expirySeconds: spec.expirySeconds } : {}),
					...(Object.keys(spec.contexts).length > 0 ? { contexts: spec.contexts } : {})
				});
			},
			original ? `Saving ${spec.key}…` : `Adding ${spec.key}…`,
			original ? `Node ${spec.key} saved` : `Node ${spec.key} added`
		);
	}

	// ----------------------------------------------------------------- tables

	const summaryCells: InfoCell[] = $derived([
		{ label: 'Name', value: name, style: 'mono', copyable: true },
		{ label: 'Display name', value: displayName || '–' },
		{ label: 'Weight', value: weight },
		{ label: 'Prefix', value: prefix || '–', style: prefix ? 'mono' : 'default' },
		{ label: 'Suffix', value: suffix || '–', style: suffix ? 'mono' : 'default' },
		{ id: 'parents', label: 'Inherits from', value: parents.join(', ') || '–' },
		{ label: 'Direct members', value: members.length },
		{ label: 'Nodes', value: nodes.length }
	]);

	const nodeCols: Column[] = [
		{ id: 'key', label: 'Node', sortable: true, minWidth: 240 },
		{ id: 'value', label: 'Value', width: 110 },
		{ id: 'type', label: 'Type', sortable: true, width: 140 },
		{ id: 'contexts', label: 'Contexts' },
		{ id: 'expiry', label: 'Expires', sortable: true }
	];

	const nodeTypes = $derived([...new Set(nodes.map((node) => node.type))].sort());

	const nodeFilters: TableFilterGroup<PermNode>[] = $derived([
		{
			id: 'type',
			label: 'Filter type',
			options: [
				{ value: 'any', label: 'Any type' },
				...nodeTypes.map((type) => ({
					value: type,
					label: type,
					match: (node: PermNode) => node.type === type
				}))
			]
		},
		{
			id: 'value',
			label: 'Filter value',
			options: [
				{ value: 'any', label: 'Granted and negated' },
				{ value: 'true', label: 'Granted', match: (node: PermNode) => node.value },
				{ value: 'false', label: 'Negated', match: (node: PermNode) => !node.value }
			]
		}
	]);

	function nodeSort(node: PermNode, col: string): string | number | null {
		switch (col) {
			case 'key':
				return node.key;

			case 'type':
				return node.type;

			case 'expiry':
				return node.expiryEpochMillis || Number.MAX_SAFE_INTEGER;

			default:
				return null;
		}
	}

	function nodeActions(node: PermNode): ContextMenuItem[] {
		return [
			{
				label: 'Edit node…',
				icon: 'pen',
				action: () => openNodeEditor(node)
			},
			{
				label: node.value ? 'Negate node' : 'Grant node',
				icon: 'rotate',
				action: () => void flipNode(node)
			},
			{
				label: 'Copy key',
				icon: 'copy',
				action: () => void copy(node.key)
			},
			...(node.type === 'inheritance'
				? [
						{
							label: `Open ${node.key.replace(/^group\./, '')}`,
							icon: 'key',
							action: () => goto(`/permissions/${encodeURIComponent(node.key.replace(/^group\./, ''))}`)
						}
					]
				: []),
			{ separator: true },
			{
				label: 'Remove node',
				icon: 'trash',
				color: 'danger',
				action: () => void removeNode(node)
			}
		];
	}

	/** Flip granted ↔ negated in place: remove the node, re-add inverted. */
	async function flipNode(node: PermNode): Promise<void> {
		const contexts: Record<string, string> = {};

		for (const pair of node.contexts) {
			contexts[pair.key] = pair.value;
		}

		const groupPath = `/permissions/groups/${encodeURIComponent(name)}`;
		const remaining = node.expiryEpochMillis
			? Math.max(0, Math.floor((node.expiryEpochMillis - Date.now()) / 1000))
			: 0;

		await act(
			async () => {
				await post(groupPath, { op: 'node', action: 'remove', key: node.key, contexts });

				return await post(groupPath, {
					op: 'node',
					action: 'add',
					key: node.key,
					value: !node.value,
					...(remaining > 0 ? { expirySeconds: remaining } : {}),
					...(Object.keys(contexts).length > 0 ? { contexts } : {})
				});
			},
			`Flipping ${node.key}…`,
			`Node ${node.key} is now ${node.value ? 'negated' : 'granted'}`
		);
	}

	const memberCols: Column[] = [
		{ id: 'username', label: 'Player', sortable: true, minWidth: 180 },
		{ id: 'uuid', label: 'UUID', width: 300 }
	];

	function memberActions(member: Member): ContextMenuItem[] {
		return [
			{
				label: 'View profile',
				icon: 'user',
				action: () => goto(`/players/${member.uuid}`)
			},
			{
				label: 'Copy UUID',
				icon: 'copy',
				action: () => void copy(member.uuid)
			},
			{ separator: true },
			{
				label: `Remove from ${name}`,
				icon: 'userMinus',
				color: 'danger',
				action: () => void removeMember(member)
			}
		];
	}

	function nodeId(node: PermNode): string {
		const contexts = [...node.contexts]
			.map((pair) => `${pair.key}=${pair.value}`)
			.sort()
			.join(',');

		return `${node.key}|${node.value}|${contexts}`;
	}
</script>

<svelte:head><title>{name} | Permission groups | Luna Console</title></svelte:head>

<PageHeader
	title={name}
	info
	description={displayName && displayName !== name
		? `${displayName} — LuckPerms group`
		: 'LuckPerms group'}
>
	{#snippet actions()}
		<RefreshControl onrefresh={refresh} {lastUpdated} {loading} storageKey="permission-group" />
		<Dropdown label="Actions" disabled={!available || missing} menu={headerActions()} />
		<Btn
			variant="primary"
			icon="pen"
			disabled={!available || missing}
			onclick={() => goto(`/permissions/${encodeURIComponent(name)}/edit`)}
		>
			Edit group
		</Btn>
	{/snippet}
</PageHeader>

{#if missing}
	<Flash kind="error">
		<b>Unknown group:</b> LuckPerms has no group named <code>{name}</code>. It may have been
		deleted — <a href="/permissions">back to permission groups</a>.
	</Flash>
{:else if !available}
	<Flash kind="warning">
		<b>LuckPerms is not answering:</b> {problem}. The proxy may be stopped, LuckPerms may be
		missing, or LunaCore is running a build without the permissions API.
	</Flash>
{:else}
	<OverviewBar title="Group overview">
		<OverviewCell label="Weight">
			{weight}
		</OverviewCell>
		<OverviewCell label="Direct members">
			{members.length}
		</OverviewCell>
		<OverviewCell label="Nodes">
			{nodes.length}
		</OverviewCell>
		<OverviewCell label="Inherits from">
			{parents.length ? `${parents.length} group(s)` : '–'}
		</OverviewCell>
	</OverviewBar>

	<div class="body">
		<Panel title="Group summary">
			<InfoGrid cells={summaryCells}>
				{#snippet custom(cell)}
					{#if cell.id === 'parents'}
						{#if parents.length > 0}
							<span class="parents">
								{#each parents as parent, index}
									<a href="/permissions/{encodeURIComponent(parent)}">{parent}</a>{index <
									parents.length - 1
										? ', '
										: ''}
								{/each}
							</span>
						{:else}
							<span class="dim">–</span>
						{/if}
					{/if}
				{/snippet}
			</InfoGrid>
		</Panel>

		<Panel
			flush
			title="Permission nodes"
			count={nodes.length}
			description="Everything the group carries — permissions, inheritance, prefix/suffix and weight nodes alike"
		>
			{#snippet actions()}
				<Btn icon="plus" onclick={() => openNodeEditor(null)}>Add node</Btn>
			{/snippet}

			<ResourceTable
				tableId="permission-group-nodes"
				columns={nodeCols}
				rows={nodes}
				getId={nodeId}
				searchValue={(node) =>
					`${node.key} ${node.type} ${node.contexts.map((pair) => `${pair.key}=${pair.value}`).join(' ')}`}
				searchPlaceholder="Find node"
				noun="node"
				sortValue={nodeSort}
				filters={nodeFilters}
				rowActions={nodeActions}
				rowLabel={(node) => node.key}
				pageSize={25}
				emptyTitle="No nodes"
				emptyText="This group carries nothing yet — open the edit wizard to add permissions."
			>
				{#snippet cell(node, col)}
					{#if col === 'key'}
						{#if node.type === 'inheritance'}
							<a class="mono" href="/permissions/{encodeURIComponent(node.key.replace(/^group\./, ''))}">
								{node.key}
							</a>
						{:else}
							<span class="mono">{node.key}</span>
						{/if}
					{:else if col === 'value'}
						<StatusBadge state={node.value ? 'passed' : 'failed'} label={node.value ? 'true' : 'false'} />
					{:else if col === 'type'}
						<span class="dim">{node.type}</span>
					{:else if col === 'contexts'}
						{#if node.contexts.length > 0}
							<span class="mono dim">
								{node.contexts.map((pair) => `${pair.key}=${pair.value}`).join(', ')}
							</span>
						{:else}
							<span class="dim">global</span>
						{/if}
					{:else if col === 'expiry'}
						{node.expiryEpochMillis ? fmtDateTime(node.expiryEpochMillis) : 'never'}
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>

		<Panel
			flush
			title="Members"
			count={members.length}
			description="Players holding this group directly — members inheriting it through a parent are not listed"
		>
			{#snippet actions()}
				<Btn
					icon="userPlus"
					onclick={() => {
						addMemberName = '';
						addMemberOpen = true;
					}}
				>
					Add member
				</Btn>
			{/snippet}

			<ResourceTable
				tableId="permission-group-members"
				columns={memberCols}
				rows={members}
				getId={(member) => member.uuid}
				searchValue={(member) => `${member.username} ${member.uuid}`}
				searchPlaceholder="Find member"
				noun="member"
				sortValue={(member, col) => (col === 'username' ? member.username.toLowerCase() : null)}
				rowActions={memberActions}
				rowLabel={(member) => member.username || member.uuid}
				pageSize={25}
				emptyTitle="No direct members"
				emptyText="Add one here, or from the Permissions tab on a player's profile."
			>
				{#snippet cell(member, col)}
					{#if col === 'username'}
						<span class="who">
							<PlayerSkin player={member.uuid} view="face" px={3} />
							<a href="/players/{member.uuid}"><b>{member.username || member.uuid}</b></a>
						</span>
					{:else if col === 'uuid'}
						<span class="mono dim">{member.uuid}</span>
					{/if}
				{/snippet}
			</ResourceTable>
		</Panel>
	</div>
{/if}

<NodeEditorModal bind:open={nodeEditorOpen} node={nodeBeingEdited} {servers} onsubmit={(spec) => void saveNode(spec)} />

<Modal title="Add a member to {name}" bind:open={addMemberOpen}>
	<label class="field">
		<span class="lbl">Player</span>
		<span class="hint">Name or UUID — resolved through the player directory, then LuckPerms</span>
		<input class="input" bind:value={addMemberName} placeholder="e.g. Belikhun" />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (addMemberOpen = false)}>Cancel</Btn>
		<Btn variant="primary" disabled={!addMemberName.trim()} onclick={doAddMember}>Add member</Btn>
	{/snippet}
</Modal>

<Modal title="Clone {name}" bind:open={cloneOpen}>
	<p>
		Creates a new group with the same weight, display name and every node this group carries —
		a starting point for a similar role. Members are not copied.
	</p>
	<label class="field">
		<span class="lbl">New group name</span>
		<span class="hint">Lowercase; this is the LuckPerms group id</span>
		<input class="input" bind:value={cloneName} placeholder="e.g. {name}-2" />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (cloneOpen = false)}>Cancel</Btn>
		<Btn variant="primary" disabled={!cloneName.trim()} onclick={doClone}>Clone</Btn>
	{/snippet}
</Modal>

<Modal title="Delete group {name}" bind:open={deleteOpen}>
	<p>
		The group is removed from LuckPerms on every server. Players holding it lose the
		membership; their other groups stay.
	</p>
	{#snippet footer()}
		<Btn onclick={() => (deleteOpen = false)}>Cancel</Btn>
		<Btn variant="danger" onclick={doDelete}>Delete</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.body {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		margin-top: 1rem;
	}

	.who {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
	}

	.parents {
		word-break: break-word;
	}
</style>
