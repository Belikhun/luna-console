<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { goto } from '$app/navigation';
	import { Agent } from '$lib/agent.svelte';
	import { fmtDateTime } from '$lib/format';
	import Icon from './Icon.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import AgentChat from './AgentChat.svelte';
	import AgentDeleteConfirm from './AgentDeleteConfirm.svelte';
	import type { AvatarSubject } from './accountavatar';
	import type { ContextMenuItem } from './contextmenu';

	/**
	 * Mèo Béo's docked panel: to the right of the console, below the top bar,
	 * pushing the page aside rather than covering it, the way the AWS console docks
	 * Amazon Q. The chat itself is `AgentChat`; this is the dock around it, with
	 * the conversation's verbs in its header: history, a new chat, deleting this
	 * one, and moving it to a window of its own or to the full-page screen.
	 */
	let { account }: { account: AvatarSubject | null } = $props();

	/** Mèo Béo's picture, served from the console's own static files */
	const AVATAR = '/agent/meo-beo.webp';

	const session = Agent.panel;

	let historyMenu: ContextMenu | undefined = $state();
	let historyButton: HTMLButtonElement | undefined = $state();
	let dragging = $state(false);

	/** The conversation waiting on the delete confirmation */
	let deleting: { id: string; title: string } | null = $state(null);

	const current = $derived(session.row);

	function askDelete(id: string, title: string): void {
		deleting = { id, title };
	}

	const historyItems: ContextMenuItem[] = $derived.by(() => {
		const rows: ContextMenuItem[] = [{ label: t('web.agent.history'), header: true }];

		if (Agent.conversations.length === 0) {
			rows.push({ label: t('web.agent.noHistory'), disabled: true });
		}

		for (const row of Agent.conversations.slice(0, 30)) {
			rows.push({
				id: row.id,
				label: row.title || t('web.agent.untitled'),
				icon: row.id === session.conversationId ? 'check' : row.running ? 'paw' : undefined,
				hint: fmtDateTime(row.updatedAt),
				action: () => session.select(row.id)
			});
		}

		if (current) {
			const shown = current;

			rows.push({ separator: true });
			rows.push({
				label: t('web.agent.deleteChat'),
				icon: 'trash',
				color: 'danger',
				action: () => askDelete(shown.id, shown.title)
			});
		}

		return rows;
	});

	async function openHistory(event: MouseEvent): Promise<void> {
		event.stopPropagation();

		if (historyMenu?.isOpen()) {
			historyMenu.close();

			return;
		}

		await Agent.loadConversations().catch(() => {});

		if (historyButton) {
			await historyMenu?.openAtElement(historyButton, 'bottom');
		}
	}

	/** Move this chat to a window of its own; the dock closes, since the chat now lives there. */
	function popOut(): void {
		Agent.popOut(session.conversationId);
		Agent.setOpen(false);
	}

	/** Open this chat on the full-page screen, where there is room for it. */
	async function expand(): Promise<void> {
		const id = session.conversationId;

		Agent.setOpen(false);
		await goto(id ? `/agent?c=${encodeURIComponent(id)}` : '/agent');
	}

	function startDrag(event: PointerEvent): void {
		event.preventDefault();
		dragging = true;
	}

	function onPointerMove(event: PointerEvent): void {
		if (!dragging) {
			return;
		}

		Agent.setWidth(window.innerWidth - event.clientX);
	}
</script>

<svelte:window onpointermove={onPointerMove} onpointerup={() => (dragging = false)} />

<aside class="agent" class:dragging style:width="{Agent.width}px">
	<div class="grip" role="presentation" onpointerdown={startDrag}></div>

	<header class="hd">
		<img class="mark" src={AVATAR} alt="" />
		<div class="ttl">
			<b class="name">Mèo Béo</b>
			<span class="sub">{current?.title || t('web.agent.newChat')}</span>
		</div>
		<div class="acts">
			<button
				class="tool"
				title={t('web.agent.history')}
				bind:this={historyButton}
				onpointerdown={(event) => event.stopPropagation()}
				onclick={openHistory}
			>
				<Icon name="clockRotateLeft" size="1rem" />
			</button>
			<button class="tool" title={t('web.agent.newChat')} disabled={session.items.length === 0} onclick={() => session.newChat()}>
				<Icon name="messagePlus" size="1rem" />
			</button>
			<button
				class="tool"
				title={current ? t('web.agent.deleteChat') : t('web.agent.deleteNothing')}
				disabled={!current}
				onclick={() => current && askDelete(current.id, current.title)}
			>
				<Icon name="trash" size="1rem" />
			</button>
			<span class="sep"></span>
			<button class="tool" title={t('web.agent.popOut')} onclick={popOut}>
				<Icon name="arrowUpRightFromSquare" size="1rem" />
			</button>
			<button class="tool" title={t('web.agent.fullScreen')} onclick={expand}>
				<Icon name="expand" size="1rem" />
			</button>
			<button class="tool" title={t('web.agent.close')} onclick={() => Agent.setOpen(false)}>
				<Icon name="close" size="1rem" />
			</button>
		</div>
	</header>
	<ContextMenu bind:this={historyMenu} items={historyItems} minWidth="18rem" />

	<AgentChat {session} {account} />
</aside>

<AgentDeleteConfirm bind:target={deleting} />

<style lang="scss">
	.agent {
		position: relative;
		display: flex;
		flex-direction: column;
		flex: none;
		min-height: 0;
		background: var(--bg-panel);
		border-left: 0.1rem solid var(--border-nav);

		&.dragging {
			user-select: none;
		}
	}

	// an invisible strip on the leading edge; the border itself is the affordance
	.grip {
		position: absolute;
		top: 0;
		bottom: 0;
		left: -0.25rem;
		width: 0.5rem;
		z-index: 2;
		cursor: col-resize;

		&:hover {
			background: var(--link);
			opacity: 0.4;
		}
	}

	.hd {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		height: 3rem;
		padding: 0 0.75rem 0 1rem;
		border-bottom: 0.1rem solid var(--border-divider);
		flex: none;
	}

	.mark {
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		object-fit: cover;
		flex: none;
	}

	.ttl {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
		line-height: 1.25;

		.name {
			color: var(--text-heading);
			font-size: 0.9375rem;
		}

		.sub {
			@include ellipsis;

			color: var(--text-secondary);
			font-size: 0.75rem;
		}
	}

	.acts {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex: none;
	}

	.tool {
		@include bare-button;

		display: inline-grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 0.5rem;
		color: var(--text);
		text-decoration: none;

		&:hover:not(:disabled) {
			color: var(--link);
			background: var(--bg-hover);
		}

		&:disabled {
			color: var(--text-disabled);
			cursor: default;
		}
	}


	.sep {
		width: 0.1rem;
		height: 1rem;
		margin: 0 0.25rem;
		background: var(--border-divider);
	}
</style>
