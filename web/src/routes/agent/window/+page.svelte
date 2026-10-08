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
	import Icon from '$lib/components/Icon.svelte';
	import ContextMenu from '$lib/components/ContextMenu.svelte';
	import AgentChat from '$lib/components/AgentChat.svelte';
	import AgentDeleteConfirm from '$lib/components/AgentDeleteConfirm.svelte';
	import type { ContextMenuItem } from '$lib/components/contextmenu';

	/**
	 * A Mèo Béo chat in a window of its own, opened from the panel or the agent
	 * screen. It renders without the console's chrome (the root layout lets this
	 * route through bare, like the sign-in page), since the console is in the
	 * window it came from.
	 *
	 * That is also why its screenshots and navigation are relayed: a screenshot
	 * of this window would show the chat, and navigating it would replace the
	 * chat with a page, so the session asks the console window the operator is
	 * looking at to answer instead (`startConsoleBridge`).
	 */

	/** Mèo Béo's picture, served from the console's own static files */
	const AVATAR = '/agent/meo-beo.webp';

	const account = $derived(page.data.account ?? null);
	const session = new ChatSession({ relay: true });
	const title = $derived(session.row?.title || t('web.agent.newChat'));

	let historyMenu: ContextMenu | undefined = $state();
	let historyButton: HTMLButtonElement | undefined = $state();
	let deleting: { id: string; title: string } | null = $state(null);

	onMount(() => {
		setTimeout(() => {
			routerReady = true;
		});

		const wanted = page.url.searchParams.get('c');

		void Agent.loadAll().catch(() => {});

		if (wanted) {
			void session.select(wanted);
		}

		return () => session.dispose();
	});

	// SvelteKit refuses shallow address updates until its router has started,
	// which is after this page's first effects run
	let routerReady = $state(false);

	// the address names the chat, so a reload of this window reopens it
	$effect(() => {
		const id = session.conversationId;
		const url = new URL(location.href);

		if (id) {
			url.searchParams.set('c', id);
		} else {
			url.searchParams.delete('c');
		}

		if (routerReady && url.href !== location.href) {
			replaceState(url, page.state);
		}
	});

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

	/** Take this chat back into the console: the agent screen, in the window this one came from when it is still there. */
	function backToConsole(): void {
		const id = session.conversationId;
		const path = id
			? `/agent?c=${encodeURIComponent(id)}`
			: '/agent';
		const opener = window.opener as Window | null;

		if (opener && !opener.closed) {
			opener.location.href = path;
			opener.focus();
			window.close();

			return;
		}

		window.open(path, '_blank');
		window.close();
	}
</script>

<svelte:head>
	<title>{title} · Mèo Béo</title>
</svelte:head>

<div class="window">
	<header class="hd">
		<img class="mark" src={AVATAR} alt="" />
		<div class="ttl">
			<b class="name">Mèo Béo</b>
			<span class="sub">{title}</span>
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
				title={session.row ? t('web.agent.deleteChat') : t('web.agent.deleteNothing')}
				disabled={!session.row}
				onclick={() => session.row && (deleting = { id: session.row.id, title: session.row.title })}
			>
				<Icon name="trash" size="1rem" />
			</button>
			<button class="tool" title={t('web.agentScreen.backToConsole')} onclick={backToConsole}>
				<Icon name="expand" size="1rem" />
			</button>
		</div>
	</header>
	<ContextMenu bind:this={historyMenu} items={historyItems} minWidth="18rem" />

	<AgentChat {session} {account} />
</div>

<AgentDeleteConfirm bind:target={deleting} />

<style lang="scss">
	.window {
		display: flex;
		flex-direction: column;
		height: 100vh;
		background: var(--bg-panel);
	}

	.hd {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.5rem 0.75rem;
		border-bottom: 0.1rem solid var(--border-divider);
		flex: none;
	}

	.mark {
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		object-fit: cover;
	}

	.ttl {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;

		.name {
			color: var(--text-heading);
			font-size: 0.875rem;
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

		&:hover:not(:disabled) {
			color: var(--link);
			background: var(--bg-hover);
		}

		&:disabled {
			color: var(--text-disabled);
			cursor: default;
		}
	}
</style>
