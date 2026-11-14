<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { tooltip } from '$lib/tooltip.svelte';
	import { t } from '$lib/i18n.svelte';
	import { goto } from '$app/navigation';
	import { Agent } from '$lib/agent.svelte';
	import Icon from './Icon.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import AgentChat from './AgentChat.svelte';
	import AgentDialogs from './AgentDialogs.svelte';
	import { conversationVerbs, historyItems } from './agentmenu';
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

	const current = $derived(session.row);

	const history: ContextMenuItem[] = $derived(
		historyItems(session.conversationId, (id) => session.select(id), () => expand())
	);

	let chatMenu: ContextMenu | undefined = $state();
	let chatButton: HTMLButtonElement | undefined = $state();
	let dialogHost: AgentDialogs | undefined = $state();

	const chatItems: ContextMenuItem[] = $derived(current && dialogHost ? conversationVerbs(current, dialogHost.dialogs) : []);

	async function openChatMenu(event: MouseEvent): Promise<void> {
		event.stopPropagation();

		if (chatMenu?.isOpen()) {
			chatMenu.close();

			return;
		}

		if (chatButton) {
			await chatMenu?.openAtElement(chatButton, 'bottom');
		}
	}

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
				use:tooltip={{ content: t('web.agent.history') }}
				aria-label={t('web.agent.history')}
				aria-haspopup="menu"
				bind:this={historyButton}
				onpointerdown={(event) => event.stopPropagation()}
				onclick={openHistory}
			>
				<Icon name="clockRotateLeft" size="1rem" />
			</button>
			<button class="tool" use:tooltip={{ content: t('web.agent.newChat') }} aria-label={t('web.agent.newChat')} disabled={session.items.length === 0} onclick={() => session.newChat()}>
				<Icon name="messagePlus" size="1rem" />
			</button>
			<button
				class="tool"
				use:tooltip={{ content: (current ? t('web.agentMenu.chatActions') : t('web.agent.deleteNothing')) ?? '' }}
				aria-label={current ? t('web.agentMenu.chatActions') : t('web.agent.deleteNothing')}
				aria-haspopup="menu"
				disabled={!current}
				bind:this={chatButton}
				onpointerdown={(event) => event.stopPropagation()}
				onclick={openChatMenu}
			>
				<Icon name="ellipsis" size="1rem" />
			</button>
			<span class="sep"></span>
			<button class="tool" use:tooltip={{ content: t('web.agent.popOut') }} aria-label={t('web.agent.popOut')} onclick={popOut}>
				<Icon name="arrowUpRightFromSquare" size="1rem" />
			</button>
			<button class="tool" use:tooltip={{ content: t('web.agent.fullScreen') }} aria-label={t('web.agent.fullScreen')} onclick={expand}>
				<Icon name="expand" size="1rem" />
			</button>
			<button class="tool" use:tooltip={{ content: t('web.agent.close') }} aria-label={t('web.agent.close')} onclick={() => Agent.setOpen(false)}>
				<Icon name="close" size="1rem" />
			</button>
		</div>
	</header>
	<ContextMenu bind:this={historyMenu} items={history} minWidth="18rem" />
	<ContextMenu bind:this={chatMenu} items={chatItems} minWidth="15rem" />

	<AgentChat {session} {account} />
</aside>

<AgentDialogs bind:this={dialogHost} branched={(id) => session.select(id)} />

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
