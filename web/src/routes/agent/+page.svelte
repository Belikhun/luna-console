<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { Authz } from '$lib/authz.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { Agent, ChatSession } from '$lib/agent.svelte';
	import { fmtDateTime } from '$lib/format';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import ContextMenu from '$lib/components/ContextMenu.svelte';
	import AgentChat from '$lib/components/AgentChat.svelte';
	import AgentDialogs from '$lib/components/AgentDialogs.svelte';
	import SearchInput from '$lib/components/SearchInput.svelte';
	import { bucketOf, conversationVerbs, CONVERSATION_BUCKETS } from '$lib/components/agentmenu';
	import type { ConversationBucket } from '$lib/components/agentmenu';
	import type { ConversationRow } from '$lib/agent.svelte';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import { score } from '$lib/search/match';

	/**
	 * Mèo Béo on a screen of its own: the conversations down the left, and up to
	 * three chats side by side, each a full `AgentChat` with its own run. The
	 * open chats live in the address (`?c=<id>,<id>`), so a reload or a shared
	 * link brings the same ones back. A chat opened here follows its run like the
	 * docked panel does; nothing stops the same conversation from being open in
	 * the panel or a window too, since every view replays the same stream.
	 *
	 * The list is searchable and sorted the way VS Code sorts chat sessions:
	 * pinned first, then by when each last changed. A filter switches between
	 * this account's own, those shared with it, and the archived ones.
	 */

	/** More than three and each chat is narrower than the docked panel */
	const MAX_PANES = 3;

	interface Pane {
		key: number;
		session: ChatSession;
	}

	const account = $derived(page.data.account ?? null);

	let panes: Pane[] = $state([]);
	let active = $state(0);
	let nextKey = 0;

	let listMenu: ContextMenu | undefined = $state();
	let menuFor: string | null = $state(null);
	let dialogHost: AgentDialogs | undefined = $state();

	/** Which conversations the list shows */
	type ListFilter = 'all' | 'mine' | 'shared' | 'archived';

	let query = $state('');
	let filter: ListFilter = $state('all');

	const FILTERS: ListFilter[] = ['all', 'mine', 'shared', 'archived'];

	function passes(row: ConversationRow): boolean {
		switch (filter) {
			case 'archived':
				return row.archived;

			case 'mine':
				return !row.archived && row.role === 'owner';

			case 'shared':
				return !row.archived && (row.role !== 'owner' || (row.shares?.length ?? 0) > 0);

			default:
				return !row.archived;
		}
	}

	/** The list as it shows: filtered, searched (best match first), else bucketed by date */
	const listed = $derived.by(() => {
		const rows = Agent.conversations.filter(passes);
		const term = query.trim();

		if (term) {
			return [{
				bucket: null,
				rows: rows
					.map((row) => ({ row, rank: score(`${row.title} ${row.owner}`, term) }))
					.filter((entry) => entry.rank > 0)
					.sort((left, right) => right.rank - left.rank)
					.map((entry) => entry.row)
			}];
		}

		const now = new Date();
		const buckets = new Map<ConversationBucket, ConversationRow[]>();

		for (const row of rows) {
			const bucket = bucketOf(row, now);

			buckets.set(bucket, [...(buckets.get(bucket) ?? []), row]);
		}

		return CONVERSATION_BUCKETS
			.filter((bucket) => buckets.has(bucket))
			.map((bucket) => ({ bucket, rows: buckets.get(bucket)! }));
	});

	const listedCount = $derived(listed.reduce((sum, section) => sum + section.rows.length, 0));

	/** Open a branch: beside the focused chat when there is room, else in its place. */
	function openBranch(id: string): void {
		if (panes.length < MAX_PANES) {
			addPane(id);
		} else {
			void panes[active]?.session.select(id);
		}
	}

	function addPane(conversation: string | null): Pane {
		const session = new ChatSession();
		const pane: Pane = { key: nextKey++, session };

		if (conversation) {
			void session.select(conversation);
		}

		panes = [...panes, pane];
		active = panes.length - 1;

		return pane;
	}

	function closePane(index: number): void {
		const pane = panes[index];

		if (!pane) {
			return;
		}

		pane.session.dispose();
		panes = panes.filter((_, at) => at !== index);

		if (panes.length === 0) {
			addPane(null);
		}

		active = Math.min(active, panes.length - 1);
	}

	/** Show a conversation in the focused chat, or bring it forward when another pane has it. */
	function openHere(id: string): void {
		const already = panes.findIndex((pane) => pane.session.conversationId === id);

		if (already >= 0) {
			active = already;

			return;
		}

		void panes[active]?.session.select(id);
	}

	function openBeside(id: string | null): void {
		if (panes.length >= MAX_PANES) {
			return;
		}

		addPane(id);
	}

	// SvelteKit refuses shallow address updates until its router has started,
	// which is after this page's first effects run
	let routerReady = $state(false);

	// the address follows the open chats; a new chat that has not been sent has
	// no id yet, so it is simply left out
	$effect(() => {
		const ids = panes
			.map((pane) => pane.session.conversationId)
			.filter((id): id is string => !!id);
		const url = new URL(location.href);

		if (ids.length) {
			url.searchParams.set('c', ids.join(','));
		} else {
			url.searchParams.delete('c');
		}

		if (routerReady && url.href !== location.href) {
			replaceState(url, page.state);
		}
	});

	onMount(() => {
		setTimeout(() => {
			routerReady = true;
		});

		const wanted = (page.url.searchParams.get('c') ?? '')
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean)
			.slice(0, MAX_PANES);

		void Agent.loadAll().catch(() => {});

		if (wanted.length === 0) {
			addPane(null);
		}

		for (const id of wanted) {
			addPane(id);
		}

		active = 0;

		return () => {
			for (const pane of panes) {
				pane.session.dispose();
			}
		};
	});

	const listItems: ContextMenuItem[] = $derived.by(() => {
		const row = Agent.conversations.find((entry) => entry.id === menuFor);

		if (!row) {
			return [];
		}

		const items: ContextMenuItem[] = [
			{ label: t('web.agentScreen.openHere'), icon: 'messagePlus', action: () => openHere(row.id) },
			{
				label: t('web.agentScreen.openBeside'),
				icon: 'tableColumns',
				disabled: panes.length >= MAX_PANES,
				hint: panes.length >= MAX_PANES ? t('web.agentScreen.tooManyPanes', { max: MAX_PANES }) : undefined,
				action: () => openBeside(row.id)
			},
			{ label: t('web.agent.popOut'), icon: 'arrowUpRightFromSquare', action: () => Agent.popOut(row.id) },
			{ separator: true },
			...(dialogHost ? conversationVerbs(row, dialogHost.dialogs) : [])
		];

		return items;
	});

	async function openListMenu(event: MouseEvent, id: string): Promise<void> {
		event.preventDefault();
		menuFor = id;
		await listMenu?.openAt(event.clientX, event.clientY);
	}

	function paneActions(pane: Pane, index: number): ContextMenuItem[] {
		const row = pane.session.row;

		return [
			{
				label: t('web.agent.newChat'),
				icon: 'messagePlus',
				disabled: pane.session.items.length === 0,
				action: () => pane.session.newChat()
			},
			{ label: t('web.agent.popOut'), icon: 'arrowUpRightFromSquare', action: () => Agent.popOut(pane.session.conversationId) },
			{
				label: t('web.agentScreen.closePane'),
				icon: 'close',
				disabled: panes.length === 1,
				action: () => closePane(index)
			},
			...(row && dialogHost ? [{ separator: true }, ...conversationVerbs(row, dialogHost.dialogs)] : [])
		];
	}

	/** A conversation's title is its first message; a pane header shows the start of it, on one line. */
	const PANE_TITLE_MAX = 48;

	function paneTitle(pane: Pane): string {
		const title = pane.session.row?.title || t('web.agent.newChat');

		return title.length > PANE_TITLE_MAX
			? `${title.slice(0, PANE_TITLE_MAX - 1).trimEnd()}…`
			: title;
	}

	let paneMenu: ContextMenu | undefined = $state();
	let paneMenuItems: ContextMenuItem[] = $state([]);

	async function openPaneMenu(event: MouseEvent, pane: Pane, index: number): Promise<void> {
		event.stopPropagation();
		paneMenuItems = paneActions(pane, index);
		await paneMenu?.openAtElement(event.currentTarget as HTMLElement, 'bottom');
	}
</script>

<PageHeader title="Mèo Béo" description={t('web.agentScreen.description')}>
	{#snippet actions()}
		<Btn
			icon="gear"
			href="/console/agent"
			disabled={!Authz.can('agent:Configure')}
			title={Authz.can('agent:Configure') ? undefined : t('web.common.notAllowed', { action: 'agent:Configure' })}
		>
			{t('web.agent.settings')}
		</Btn>
		<Btn
			icon="tableColumns"
			disabled={panes.length >= MAX_PANES}
			title={panes.length >= MAX_PANES ? t('web.agentScreen.tooManyPanes', { max: MAX_PANES }) : undefined}
			onclick={() => openBeside(null)}
		>
			{t('web.agentScreen.newPane')}
		</Btn>
		<Btn variant="primary" icon="messagePlus" onclick={() => panes[active]?.session.newChat()}>
			{t('web.agent.newChat')}
		</Btn>
	{/snippet}
</PageHeader>

<div class="screen agent-screen" style:--panes={panes.length}>
	<Panel title={t('web.agent.history')} count={listedCount} fill flush>
		<div class="tools">
			<SearchInput bind:value={query} width="100%" placeholder={t('web.agentScreen.search')} />
			<div class="filters" role="tablist">
				{#each FILTERS as key (key)}
					<button role="tab" class="filter" class:on={filter === key} aria-selected={filter === key} onclick={() => (filter = key)}>
						{t(`web.agentScreen.filter_${key}`)}
					</button>
				{/each}
			</div>
		</div>
		<div class="list">
			{#if listedCount === 0}
				<p class="dim empty">{query.trim() ? t('web.agentScreen.noMatch') : t('web.agent.noHistory')}</p>
			{/if}
			{#each listed as section (section.bucket ?? 'search')}
				{#if section.bucket}
					<div class="bucket">{t(`web.agentScreen.bucket_${section.bucket}`)}</div>
				{/if}
				{#each section.rows as row (row.id)}
					{@const shown = panes.findIndex((pane) => pane.session.conversationId === row.id)}
					<button
						class="conv"
						class:shown={shown >= 0}
						class:focused={shown >= 0 && shown === active}
						onclick={() => openHere(row.id)}
						oncontextmenu={(event) => openListMenu(event, row.id)}
					>
						<span class="conv-title">
							{#if row.running}
								<Icon name="paw" size="0.75rem" style="solid" />
							{:else if row.pinned}
								<Icon name="thumbtack" size="0.75rem" style="solid" />
							{/if}
							<span class="conv-name">{row.title || t('web.agent.untitled')}</span>
						</span>
						<span class="conv-when">
							{#if row.role !== 'owner'}
								<Icon name="userGroup" size="0.625rem" />
								{t('web.agentScreen.sharedBy', { owner: row.owner })} ·
							{:else if row.shares?.length}
								<Icon name="userGroup" size="0.625rem" />
							{/if}
							{fmtDateTime(row.updatedAt)}
						</span>
					</button>
				{/each}
			{/each}
		</div>
	</Panel>

	<div class="panes">
		{#each panes as pane, index (pane.key)}
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
			<div class="pane" class:focused={panes.length > 1 && index === active} onclick={() => (active = index)}>
				<Panel title={paneTitle(pane)} fill flush>
					{#snippet actions()}
						<button class="pane-btn" title={t('web.common.actions')} onclick={(event) => openPaneMenu(event, pane, index)}>
							<Icon name="ellipsis" size="1rem" />
						</button>
						{#if panes.length > 1}
							<button class="pane-btn" title={t('web.agentScreen.closePane')} onclick={(event) => {
								event.stopPropagation();
								closePane(index);
							}}>
								<Icon name="close" size="1rem" />
							</button>
						{/if}
					{/snippet}
					<AgentChat session={pane.session} {account} onbranch={openBranch} />
				</Panel>
			</div>
		{/each}
	</div>
</div>

<ContextMenu bind:this={listMenu} items={listItems} minWidth="15rem" />
<ContextMenu bind:this={paneMenu} items={paneMenuItems} minWidth="15rem" />
<AgentDialogs bind:this={dialogHost} branched={openBranch} />

<style lang="scss">
	// the content area's bottom padding is room to scroll past the last row of a
	// list; a screen that fits the viewport has nothing to scroll, so it keeps
	// only a gap the size of the panels' own
	:global(main.content:has(> .agent-screen)) {
		padding-bottom: 1rem;
	}

	.screen {
		display: grid;
		grid-template-columns: 17rem minmax(0, 1fr);
		gap: 0.75rem;

		// fills the viewport below the page chrome like the files screen. Measured
		// 2026-11-03 at 222px: top bar and breadcrumbs 90, the content area's
		// padding 20 + 16 (cut from 40 below), the page header 52 and its gap 16,
		// the status bar 28; 14rem is the next step on the scale. --split-bottom
		// is the terminal drawer's height, so opening it shortens the chats
		// instead of covering them
		height: calc(100vh - 14rem - var(--split-bottom));
		min-height: 30rem;

		@include below($bp-medium) {
			grid-template-columns: 1fr;
			grid-template-rows: 12rem minmax(0, 1fr);
			height: auto;
		}
	}

	.tools {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem;
		border-bottom: 0.1rem solid var(--border-divider);
	}

	.filters {
		display: flex;
		gap: 0.25rem;
	}

	.filter {
		@include bare-button;

		flex: 1;
		padding: 0.25rem 0;
		border-radius: 0.375rem;
		font-size: 0.75rem;
		color: var(--text-secondary);

		&:hover {
			background: var(--bg-hover);
			color: var(--text-heading);
		}

		&.on {
			background: var(--bg-selected);
			color: var(--link);
		}
	}

	.bucket {
		padding: 0.75rem 1rem 0.25rem;
		font-size: 0.6875rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.0625em;
		color: var(--text-disabled);
	}

	.list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.25rem 0;
	}

	.empty {
		padding: 0.75rem 1rem;
		margin: 0;
	}

	.conv {
		@include bare-button;

		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		width: 100%;
		padding: 0.5rem 1rem;
		border-left: 0.25rem solid transparent;
		text-align: left;

		&:hover {
			background: var(--bg-hover);
		}

		&.shown {
			border-left-color: var(--border);
		}

		&.focused {
			border-left-color: var(--link);
			background: var(--bg-hover);
		}
	}

	.conv-name {
		@include ellipsis;

		min-width: 0;
	}

	.conv-title {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--text-heading);
		font-size: 0.875rem;
		font-weight: 700;
	}

	.conv-when {
		@include ellipsis;

		display: flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--text-secondary);
		font-size: 0.75rem;
	}

	.panes {
		display: grid;
		grid-template-columns: repeat(var(--panes), minmax(0, 1fr));
		gap: 0.75rem;
		min-height: 0;

		@include below($bp-medium) {
			grid-template-columns: 1fr;
		}
	}

	.pane {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-radius: 0.5rem;

		// with several chats open, the one the list opens into is outlined
		&.focused {
			outline: 0.125rem solid var(--link);
			outline-offset: 0.125rem;
		}

		:global(.panel) {
			flex: 1;
			min-height: 0;
		}
	}

	.pane-btn {
		@include bare-button;

		display: inline-grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		color: var(--text);

		&:hover {
			color: var(--link);
			background: var(--bg-hover);
		}
	}
</style>
