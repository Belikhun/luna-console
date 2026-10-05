<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { tick } from 'svelte';
	import { Agent, type ChatItem } from '$lib/agent.svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { copyText } from '$lib/clipboard';
	import { fmtDateTime } from '$lib/format';
	import Icon from './Icon.svelte';
	import Btn from './Btn.svelte';
	import Spinner from './Spinner.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import AgentComposer from './AgentComposer.svelte';
	import type { ContextMenuItem } from './contextmenu';

	/**
	 * Mèo Béo's chat panel: docked to the right of the console, below the top bar,
	 * pushing the page aside rather than covering it, the way the AWS console docks
	 * Amazon Q. The chat follows the shape of Belikhun's smart-home assistant:
	 * an author row per turn, the agent's words in its own colour, and each tool
	 * call as a card that spins, then settles into a check, a ban or a warning.
	 * A call that changes something stops in its card until the operator approves
	 * or denies it.
	 */
	let { user }: { user: string } = $props();

	type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

	/** Mèo Béo's picture, served from the console's own static files */
	const AVATAR = '/agent/meo-beo.webp';

	type Group =
		| { kind: 'user'; item: Extract<ChatItem, { kind: 'user' }> }
		| { kind: 'bot'; items: Exclude<ChatItem, { kind: 'user' }>[] };

	let composer: AgentComposer | undefined = $state();
	let scroller: HTMLDivElement | undefined = $state();
	let historyMenu: ContextMenu | undefined = $state();
	let historyButton: HTMLButtonElement | undefined = $state();
	let expanded: Record<string, boolean> = $state({});
	let deciding: Record<string, boolean> = $state({});
	let dragging = $state(false);

	/** whether the reader is at the bottom; new text only scrolls a reader who is */
	let pinned = true;

	/** px from the bottom that still counts as "at the bottom" */
	const PIN_SLACK = 48;

	const groups = $derived.by(() => {
		const out: Group[] = [];

		for (const item of Agent.items) {
			if (item.kind === 'user') {
				out.push({ kind: 'user', item });

				continue;
			}

			const last = out[out.length - 1];

			if (last && last.kind === 'bot') {
				last.items.push(item);
			} else {
				out.push({ kind: 'bot', items: [item] });
			}
		}

		return out;
	});

	/** The model is working and nothing on screen shows it: no text streaming, no call pending. */
	const thinking = $derived.by(() => {
		if (!Agent.running) {
			return false;
		}

		const last = Agent.items[Agent.items.length - 1];

		if (!last) {
			return true;
		}

		if (last.kind === 'assistant' && last.streaming) {
			return false;
		}

		if (last.kind === 'tool' && (last.status === 'awaiting' || last.status === 'running')) {
			return false;
		}

		return true;
	});

	const current = $derived(Agent.conversations.find((row) => row.id === Agent.conversationId) ?? null);
	const ready = $derived(Agent.state?.ready ?? false);

	const suggestions = $derived([
		t('web.agent.suggestStatus'),
		t('web.agent.suggestPlayers'),
		t('web.agent.suggestLogs')
	]);

	const historyItems: ContextMenuItem[] = $derived.by(() => {
		const rows: ContextMenuItem[] = [{ label: t('web.agent.history'), header: true }];

		if (Agent.conversations.length === 0) {
			rows.push({ label: t('web.agent.noHistory'), disabled: true });
		}

		for (const row of Agent.conversations.slice(0, 30)) {
			rows.push({
				id: row.id,
				label: row.title || t('web.agent.untitled'),
				icon: row.id === Agent.conversationId ? 'check' : row.running ? 'paw' : undefined,
				hint: fmtDateTime(row.updatedAt),
				action: () => Agent.select(row.id)
			});
		}

		if (current) {
			rows.push({ separator: true });
			rows.push({
				label: t('web.agent.deleteChat'),
				icon: 'trash',
				color: 'danger',
				action: () => Agent.remove(current.id)
			});
		}

		return rows;
	});

	// follow the conversation as it grows, unless the reader has scrolled up
	$effect(() => {
		const last = Agent.items[Agent.items.length - 1];
		const signature = `${Agent.items.length}:${last && 'text' in last ? last.text.length : 0}:${thinking}`;

		void signature;

		if (pinned) {
			void tick().then(() => {
				scroller?.scrollTo({ top: scroller.scrollHeight });
			});
		}
	});

	/** The copy buttons are markup from `renderMarkdown`, so their clicks are caught here. */
	async function onMessagesClick(event: MouseEvent): Promise<void> {
		const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.code-copy');

		if (!button) {
			return;
		}

		const code = button.closest('.codeblock')?.querySelector('code')?.textContent ?? '';

		if (await copyText(code)) {
			button.textContent = t('web.common.copied');
			setTimeout(() => {
				button.textContent = t('web.agent.copyCode');
			}, 1500);
		}
	}

	function onScroll(): void {
		if (!scroller) {
			return;
		}

		pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < PIN_SLACK;
	}

	async function decide(item: ToolItem, allow: boolean): Promise<void> {
		deciding[item.id] = true;

		try {
			await Agent.decide(item.id, allow, item.name);
		} finally {
			deciding[item.id] = false;
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

	function toolTitle(item: ToolItem): string {
		switch (item.status) {
			case 'awaiting':
				return t('web.agent.toolAwaiting');

			case 'running':
				return t('web.agent.toolRunning');

			case 'ok':
				return t('web.agent.toolOk');

			case 'denied':
				return item.decidedBy === 'timeout'
					? t('web.agent.toolTimedOut')
					: item.decidedBy === 'plan'
						? t('web.agent.toolPlan')
						: t('web.agent.toolDenied');

			default:
				return t('web.agent.toolFailed');
		}
	}

	function toolIcon(status: ToolItem['status']): string {
		switch (status) {
			case 'ok':
				return 'check';

			case 'denied':
				return 'ban';

			case 'awaiting':
				return 'shieldCheck';

			default:
				return 'triangleExclamation';
		}
	}

	function pretty(value: unknown): string {
		if (value === undefined) {
			return '';
		}

		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}

	function errorText(item: Extract<ChatItem, { kind: 'error' }>): string {
		if (item.code) {
			const key = `web.agent.err.${item.code}`;
			const text = t(key);

			if (text !== key) {
				return text;
			}
		}

		return item.text;
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
			<button class="tool" title={t('web.agent.newChat')} disabled={Agent.items.length === 0} onclick={() => Agent.newChat()}>
				<Icon name="penToSquare" size="1rem" />
			</button>
			<a class="tool" href="/console/agent" title={t('web.agent.settings')}>
				<Icon name="gear" size="1rem" />
			</a>
			<button class="tool" title={t('web.agent.close')} onclick={() => Agent.setOpen(false)}>
				<Icon name="close" size="1rem" />
			</button>
		</div>
	</header>
	<ContextMenu bind:this={historyMenu} items={historyItems} minWidth="18rem" />

	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="msgs" bind:this={scroller} onscroll={onScroll} onclick={onMessagesClick}>
		{#if Agent.state && !ready}
			<div class="setup">
				<img class="big" src={AVATAR} alt="" />
				<div class="title">{t('web.agent.setupTitle')}</div>
				<p>{Agent.state.reason}</p>
				<Btn variant="primary" href="/console/agent">{t('web.agent.setupAction')}</Btn>
			</div>
		{:else if Agent.items.length === 0}
			<div class="welcome">
				<img class="big" src={AVATAR} alt="" />
				<div class="title">{@html t('web.agent.welcomeTitle')}</div>
				<p>{t('web.agent.welcomeBody')}</p>
				<div class="chips">
					{#each suggestions as suggestion}
						<button class="chip" disabled={!ready} onclick={() => composer?.send(suggestion)}>{suggestion}</button>
					{/each}
				</div>
			</div>
		{/if}

		{#each groups as group, gi (gi)}
			{#if group.kind === 'user'}
				<div class="msg user">
					<div class="author">
						<span class="avatar">{(group.item.author || user).slice(0, 1).toUpperCase()}</span>
						<span class="who">{group.item.author || user}</span>
						{#if group.item.mode && group.item.mode !== 'auto'}
							<span class="modetag {group.item.mode}">{t(`web.agentComposer.mode_${group.item.mode}`)}</span>
						{/if}
					</div>
					{#if group.item.text}
						<div class="bubble text">{group.item.text}</div>
					{/if}
					{#each group.item.attachments ?? [] as file}
						<div class="bubble file">
							<Icon name="paperclip" size="0.75rem" />
							<span class="fname">{file.name}</span>
						</div>
					{/each}
				</div>
			{:else}
				<div class="msg bot">
					<div class="author">
						<img class="avatar cat" src={AVATAR} alt="" />
						<span class="who">Mèo Béo</span>
					</div>

					{#each group.items as item, ii (item.kind === 'tool' ? item.id : `${gi}:${ii}`)}
						{#if item.kind === 'assistant'}
							<div class="bubble text md" class:streaming={item.streaming}>{@html renderMarkdown(item.text, { copyLabel: t('web.agent.copyCode') })}</div>
						{:else if item.kind === 'tool'}
							<div class="bubble call" data-status={item.status} class:processing={item.status === 'running'}>
								<div class="row">
									<span class="icon">
										{#if item.status === 'running'}
											<Spinner size="1rem" color="#fff" />
										{:else}
											<Icon name={toolIcon(item.status)} size="1rem" />
										{/if}
									</span>
									<span class="info">
										<span class="title">{toolTitle(item)}</span>
										<code>{item.name}()</code>
									</span>
									<button
										class="more"
										title={t('web.agent.details')}
										onclick={() => (expanded[item.id] = !expanded[item.id])}
									>
										<Icon name={expanded[item.id] ? 'arrowUp' : 'arrowDown'} size="0.75rem" />
									</button>
								</div>

								{#if item.status === 'awaiting'}
									<div class="ask">
										<p>{t('web.agent.approveLead')}</p>
										{#if item.input !== undefined && pretty(item.input) !== '{}'}
											<pre>{pretty(item.input)}</pre>
										{/if}
										<div class="btns">
											<Btn variant="primary" icon="check" loading={deciding[item.id]} onclick={() => decide(item, true)}>
												{t('web.agent.approve')}
											</Btn>
											<Btn icon="ban" disabled={deciding[item.id]} onclick={() => decide(item, false)}>
												{t('web.agent.deny')}
											</Btn>
										</div>
									</div>
								{:else if expanded[item.id]}
									<div class="detail">
										{#if item.input !== undefined}
											<span class="lbl">{t('web.agent.input')}</span>
											<pre>{pretty(item.input)}</pre>
										{/if}
										{#if item.output}
											<span class="lbl">{t('web.agent.output')}</span>
											<pre>{item.output}</pre>
										{/if}
										{#if item.decidedBy && !['timeout', 'stopped', 'plan'].includes(item.decidedBy)}
											<span class="lbl">{t('web.agent.decidedBy', { name: item.decidedBy })}</span>
										{/if}
									</div>
								{/if}
							</div>
						{:else}
							<div class="bubble err">
								<Icon name="triangleExclamation" size="0.875rem" />
								<span>{errorText(item)}</span>
							</div>
						{/if}
					{/each}

					{#if thinking && gi === groups.length - 1}
						<div class="bubble text thinking">{t('web.agent.thinking')}</div>
					{/if}
				</div>
			{/if}
		{/each}

		{#if thinking && groups[groups.length - 1]?.kind === 'user'}
			<div class="msg bot">
				<div class="author">
					<img class="avatar cat" src={AVATAR} alt="" />
					<span class="who">Mèo Béo</span>
				</div>
				<div class="bubble text thinking">{t('web.agent.thinking')}</div>
			</div>
		{/if}
	</div>

	<AgentComposer bind:this={composer} onsent={() => (pinned = true)} />
</aside>

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

	.msgs {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.5rem 0 1.5rem;
	}

	.welcome,
	.setup {
		padding: 2.5rem 1.5rem 1rem;
		text-align: center;

		.big {
			display: inline-block;
			width: 5rem;
			height: 5rem;
			border-radius: 50%;
			object-fit: cover;
			margin-bottom: 1rem;
		}

		.title {
			font-size: 1.25rem;
			font-weight: 600;
			color: var(--text-heading);

			// the name in Luna's own violet, the lifted tint the console uses
			// wherever the brand has to carry text
			:global(strong) {
				color: var(--src-luna);
			}
		}

		p {
			margin: 0.5rem 0 1.25rem;
			font-size: 0.875rem;
			color: var(--text-secondary);
		}
	}

	.chips {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
	}

	.chip {
		@include bare-button;

		padding: 0.375rem 0.875rem;
		border: 0.1rem solid var(--border-input);
		border-radius: 1rem;
		color: var(--text);
		font-size: 0.8125rem;

		&:hover:not(:disabled) {
			border-color: var(--link);
			color: var(--link);
		}

		&:disabled {
			color: var(--text-disabled);
			cursor: default;
		}
	}

	.msg {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
		margin: 1rem 1rem 0;

		&.user {
			align-items: flex-end;

			.file {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		max-width: 90%;
		padding: 0.375rem 0.75rem;
		border: 0.1rem solid var(--border-input);
		background: var(--bg-panel-raised);
		font-size: 0.8125rem;
		color: var(--text-heading);

		.fname {
			@include ellipsis;
		}
	}

	.modetag {
		padding: 0 0.375rem;
		border-radius: 0.25rem;
		border: 0.1rem solid currentColor;
		font-size: 0.6875rem;

		&.plan {
			color: var(--warning);
		}

		&.bypass {
			color: var(--error);
		}

		&.manual {
			color: var(--text);
		}
	}

	.author {
				flex-direction: row-reverse;
			}

			.text {
				background: var(--bg-hover);
				color: var(--text-heading);
				white-space: pre-wrap;
				overflow-wrap: anywhere;
			}
		}
	}

	.author {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.avatar {
		display: inline-grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 50%;
		background: var(--bg-selected);
		border: 0.1rem solid var(--border-input);
		color: var(--text-heading);
		font-size: 0.75rem;
		font-weight: 700;

		&.cat {
			border: none;
			object-fit: cover;
		}
	}

	.text {
		max-width: 90%;
		padding: 0.5rem 0.875rem;
		font-size: 0.875rem;
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	// a run of bubbles from one author reads as one block: the corners on the
	// author's side stay tight between bubbles, and only the run's outer corners
	// (bottom of the last one) round off
	.bubble {
		border-radius: 0.25rem 0.75rem 0.75rem 0.25rem;

		.msg.bot > &:last-child {
			border-bottom-left-radius: 0.75rem;
		}

		.msg.user > & {
			border-radius: 0.75rem 0.25rem 0.75rem 0.75rem;
		}
	}

	.bot .text {
		background: var(--luna-primary);
		color: #fff;
	}

	// a bubble holding code takes the full bubble width instead of shrinking to
	// its prose, so the code has room before it has to wrap
	.md:has(:global(.codeblock)) {
		width: 90%;
	}

	// the agent's markdown: compact, inside its bubble
	.md {
		:global(p),
		:global(ul),
		:global(ol),
		:global(table),
		:global(blockquote) {
			margin: 0 0 0.5rem;
		}

		:global(> :last-child) {
			margin-bottom: 0;
		}

		:global(ul),
		:global(ol) {
			padding-left: 1.25rem;
		}

		:global(h3),
		:global(h4),
		:global(h5),
		:global(h6) {
			margin: 0.5rem 0 0.25rem;
			font-size: 0.9375rem;
			color: #fff;
		}

		:global(code) {
			font-family: var(--font-mono);
			font-size: 0.8125rem;
			overflow-wrap: anywhere;
			background: rgba(255, 255, 255, 0.16);
			border-radius: 0.25rem;
			padding: 0 0.25rem;
		}

		// a code block is a dark plate inside the bubble, the console's terminal
		// colour, so highlighted code reads the way it does in the config editor;
		// it wraps rather than scrolling sideways, since a bubble is narrow and a
		// horizontal scrollbar inside one is easy to miss
		:global(.codeblock) {
			margin: 0 0 0.5rem;
			border: 0.1rem solid rgba(255, 255, 255, 0.12);
			border-radius: 0.5rem;
			background: var(--bg-terminal);
			overflow: hidden;
		}

		:global(.code-head) {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 0.5rem;
			padding: 0.25rem 0.375rem 0.25rem 0.75rem;
			border-bottom: 0.1rem solid var(--border-divider);
			font-size: 0.6875rem;
			color: var(--text-secondary);
		}

		:global(.code-lang) {
			font-family: var(--font-mono);
			text-transform: lowercase;
		}

		:global(.code-copy) {
			@include bare-button;

			padding: 0.125rem 0.5rem;
			border-radius: 0.25rem;
			color: var(--text-secondary);
			font-size: 0.6875rem;

			&:hover {
				background: var(--bg-hover);
				color: var(--link);
			}
		}

		:global(pre) {
			margin: 0;
			padding: 0.5rem 0.75rem;
			color: var(--text);
			font-size: 0.75rem;
			line-height: 1.5;
			white-space: pre-wrap;
			overflow-wrap: anywhere;

			:global(code) {
				background: none;
				padding: 0;
				font-size: inherit;
			}
		}

		// the console's Monaco palette: keys blue, numbers orange, keywords and
		// literals yellow, comments dim, strings left in the text colour
		:global(.t-k) {
			color: var(--link);
		}

		:global(.t-n) {
			color: var(--primary);
		}

		:global(.t-w) {
			color: var(--warning);
		}

		:global(.t-c) {
			color: var(--text-disabled);
			font-style: italic;
		}

		:global(.t-s) {
			color: var(--text-heading);
		}

		:global(.t-p) {
			color: var(--text-secondary);
		}

		:global(.t-v) {
			color: var(--src-luna);
		}

		:global(.t-e),
		:global(.t-del) {
			color: var(--error);
		}

		:global(.t-add) {
			color: var(--success);
		}

		:global(a) {
			color: #ffd27a;
		}

		:global(blockquote) {
			padding-left: 0.75rem;
			border-left: 0.1875rem solid rgba(255, 255, 255, 0.35);
		}

		:global(table) {
			display: block;
			overflow-x: auto;
			border-collapse: collapse;
			font-size: 0.8125rem;
		}

		:global(th),
		:global(td) {
			padding: 0.25rem 0.5rem;
			border: 0.1rem solid rgba(255, 255, 255, 0.2);
			text-align: left;
		}

		&.streaming :global(> :last-child)::after {
			content: '▍';
			margin-left: 0.125rem;
			animation: blink 1s steps(1) infinite;
		}
	}

	.thinking {
		position: relative;
		overflow: hidden;
		opacity: 0.85;

		&::before {
			content: '';
			position: absolute;
			top: 0;
			left: -10rem;
			width: 0;
			height: 100%;
			box-shadow: 0 0 4rem 2rem rgba(255, 255, 255, 0.18);
			animation: sweep 1.5s linear infinite;
		}
	}

	.call {
		position: relative;
		display: flex;
		flex-direction: column;
		width: 90%;
		border: 0.1rem solid var(--luna-primary);
		background: var(--bg-panel-raised);
		overflow: hidden;

		.row {
			display: flex;
			align-items: center;
			gap: 0.75rem;
			padding: 0.5rem 0.5rem 0.5rem 0.625rem;
		}

		.icon {
			display: grid;
			place-items: center;
			width: 2.25rem;
			height: 2.25rem;
			border-radius: 0.5rem;
			background: var(--luna-primary);
			color: #fff;
			flex: none;
		}

		.info {
			display: flex;
			flex-direction: column;
			min-width: 0;
			flex: 1;

			.title {
				font-size: 0.8125rem;
				font-weight: 600;
				color: var(--text-heading);
			}

			code {
				@include ellipsis;

				font-family: var(--font-mono);
				font-size: 0.8125rem;
				color: var(--text-secondary);
			}
		}

		.more {
			@include bare-button;

			display: grid;
			place-items: center;
			width: 1.75rem;
			height: 1.75rem;
			border-radius: 0.375rem;
			color: var(--text-secondary);

			&:hover {
				background: var(--bg-hover);
				color: var(--link);
			}
		}

		.ask,
		.detail {
			padding: 0 0.75rem 0.75rem;
			font-size: 0.8125rem;

			pre {
				margin: 0 0 0.5rem;
				padding: 0.5rem 0.625rem;
				max-height: 14rem;
				overflow: auto;
				background: var(--bg-terminal);
				border: 0.1rem solid var(--border-divider);
				border-radius: 0.375rem;
				font-family: var(--font-mono);
				font-size: 0.75rem;
				white-space: pre-wrap;
				overflow-wrap: anywhere;
			}

		}

		.ask p {
			margin: 0 0 0.5rem;
			color: var(--text);
		}

		.detail .lbl {
			display: block;
			margin-bottom: 0.25rem;
			color: var(--text-label);
			font-size: 0.75rem;
		}

		.btns {
			display: flex;
			gap: 0.5rem;
		}

		&.processing::before {
			content: '';
			position: absolute;
			top: 0;
			left: -10rem;
			width: 0;
			height: 100%;
			box-shadow: 0 0 6rem 3rem rgba(105, 44, 230, 0.25);
			animation: sweep 1.5s linear infinite;
			pointer-events: none;
		}

		&[data-status='ok'] {
			border-color: var(--success);

			.icon {
				background: var(--success);
			}
		}

		&[data-status='awaiting'] {
			border-color: var(--warning);

			.icon {
				background: var(--warning);
				color: var(--primary-text);
			}
		}

		&[data-status='denied'],
		&[data-status='error'] {
			border-color: var(--error);

			.icon {
				background: var(--error);
				color: var(--primary-text);
			}
		}
	}

	.err {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		max-width: 90%;
		padding: 0.5rem 0.75rem;
		border: 0.1rem solid var(--error);
		color: var(--error);
		font-size: 0.8125rem;
	}

	@keyframes sweep {
		from {
			transform: translateX(0);
		}

		to {
			transform: translateX(48rem);
		}
	}

	@keyframes blink {
		50% {
			opacity: 0;
		}
	}
</style>
