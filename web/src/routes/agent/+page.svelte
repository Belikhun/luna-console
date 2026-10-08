<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
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
	import AgentDeleteConfirm from '$lib/components/AgentDeleteConfirm.svelte';
	import type { ContextMenuItem } from '$lib/components/contextmenu';

	/**
	 * Mèo Béo on a screen of its own: the conversations down the left, and up to
	 * three chats side by side, each a full `AgentChat` with its own run. The
	 * open chats live in the address (`?c=<id>,<id>`), so a reload or a shared
	 * link brings the same ones back. A chat opened here follows its run like the
	 * docked panel does; nothing stops the same conversation from being open in
	 * the panel or a window too, since every view replays the same stream.
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
	let deleting: { id: string; title: string } | null = $state(null);

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
			{
				label: t('web.agent.deleteChat'),
				icon: 'trash',
				color: 'danger',
				action: () => {
					deleting = { id: row.id, title: row.title };
				}
			}
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
			{ separator: true },
			{
				label: t('web.agent.deleteChat'),
				icon: 'trash',
				color: 'danger',
				disabled: !row,
				hint: row ? undefined : t('web.agent.deleteNothing'),
				action: () => {
					if (row) {
						deleting = { id: row.id, title: row.title };
					}
				}
			},
			{
				label: t('web.agentScreen.closePane'),
				icon: 'close',
				disabled: panes.length === 1,
				action: () => closePane(index)
			}
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
		<Btn icon="gear" href="/console/agent">{t('web.agent.settings')}</Btn>
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

<div class="screen" style:--panes={panes.length}>
	<Panel title={t('web.agent.history')} count={Agent.conversations.length} fill flush>
		<div class="list">
			{#if Agent.conversations.length === 0}
				<p class="dim empty">{t('web.agent.noHistory')}</p>
			{/if}
			{#each Agent.conversations as row (row.id)}
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
						{/if}
						{row.title || t('web.agent.untitled')}
					</span>
					<span class="conv-when">{fmtDateTime(row.updatedAt)}</span>
				</button>
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
					<AgentChat session={pane.session} {account} />
				</Panel>
			</div>
		{/each}
	</div>
</div>

<ContextMenu bind:this={listMenu} items={listItems} minWidth="15rem" />
<ContextMenu bind:this={paneMenu} items={paneMenuItems} minWidth="15rem" />
<AgentDeleteConfirm bind:target={deleting} />

<style lang="scss">
	.screen {
		display: grid;
		grid-template-columns: 17rem minmax(0, 1fr);
		gap: 0.75rem;

		// fills the viewport below the page chrome (top nav, breadcrumbs, page
		// header) like the files screen; --split-bottom is the terminal drawer's
		// height, so opening it shortens the chats instead of covering them
		height: calc(100vh - 13.75rem - var(--split-bottom));
		min-height: 30rem;

		@include below($bp-medium) {
			grid-template-columns: 1fr;
			grid-template-rows: 12rem minmax(0, 1fr);
			height: auto;
		}
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

	.conv-title {
		@include ellipsis;

		display: flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--text-heading);
		font-size: 0.875rem;
		font-weight: 700;
	}

	.conv-when {
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
