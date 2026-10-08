<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import AgentQuestion from './AgentQuestion.svelte';
	import { readAnswers, readQuestions } from './agentquestion';
	import type { AgentQuestionState } from './agentquestion';
	import { AGENT_ASK_TOOL } from '$shared/agent';
	import { t } from '$lib/i18n.svelte';
	import { tick } from 'svelte';
	import { Agent, type ChatItem, type ChatSession } from '$lib/agent.svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { copyText } from '$lib/clipboard';
	import { fmtTime } from '$lib/format';
	import Icon from './Icon.svelte';
	import Btn from './Btn.svelte';
	import Spinner from './Spinner.svelte';
	import AgentComposer from './AgentComposer.svelte';
	import AccountAvatar from './AccountAvatar.svelte';
	import type { AvatarSubject } from './accountavatar';

	/**
	 * One Mèo Béo conversation as it reads on screen: the messages, the question
	 * waiting for an answer, and the composer, all bound to one `ChatSession`.
	 * The docked panel, each pane of the full-page screen and a popped-out window
	 * all render this, so a chat looks and behaves the same wherever it is open.
	 *
	 * The chat follows the shape of Belikhun's smart-home assistant: an author row
	 * per turn, the agent's words in its own colour, and each tool call as a card
	 * that spins, then settles into a check, a ban or a warning. A call that
	 * changes something stops in its card until the operator approves or denies it.
	 */
	let { session, account }: { session: ChatSession; account: AvatarSubject | null } = $props();

	/** the signed-in account's name; every conversation here is theirs */
	const user = $derived(account?.username ?? 'root');

	type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

	/** Mèo Béo's picture, served from the console's own static files */
	const AVATAR = '/agent/meo-beo.webp';

	type Group =
		| { kind: 'user'; item: Extract<ChatItem, { kind: 'user' }> }
		| { kind: 'event'; item: Extract<ChatItem, { kind: 'event' }> }
		| { kind: 'bot'; items: Exclude<ChatItem, { kind: 'user' } | { kind: 'event' }>[] };

	let composer: AgentComposer | undefined = $state();
	let scroller: HTMLDivElement | undefined = $state();
	let expanded: Record<string, boolean> = $state({});
	let deciding: Record<string, boolean> = $state({});

	/** whether the reader is at the bottom; new text only scrolls a reader who is */
	let pinned = true;

	/** px from the bottom that still counts as "at the bottom" */
	const PIN_SLACK = 48;

	/** How many capability cards a new chat offers, drawn from the full set */
	const CAPABILITY_COUNT = 4;

	/**
	 * What Mèo Béo can be asked to do, one card per kind of work. The heading is
	 * what the card is for; the text is the prompt it sends, written the way an
	 * operator would ask, so the welcome doubles as a list of what is possible.
	 */
	const CAPABILITIES: Array<{ id: string; icon: string }> = [
		{ id: 'health', icon: 'chartLine' },
		{ id: 'logs', icon: 'scroll' },
		{ id: 'players', icon: 'users' },
		{ id: 'addons', icon: 'plug' },
		{ id: 'launch', icon: 'rocket' },
		{ id: 'tune', icon: 'sliders' },
		{ id: 'domain', icon: 'globe' },
		{ id: 'screen', icon: 'eye' },
		{ id: 'moderate', icon: 'gavel' },
		{ id: 'backup', icon: 'floppyDisk' }
	];

	/** A fresh draw for each new chat, so the welcome shows a different side of the agent each time. */
	let drawn: string[] = $state([]);

	$effect(() => {
		if (session.items.length > 0 || session.conversationId) {
			return;
		}

		const pool = [...CAPABILITIES];

		for (let index = pool.length - 1; index > 0; index--) {
			const swap = Math.floor(Math.random() * (index + 1));
			const held = pool[index]!;

			pool[index] = pool[swap]!;
			pool[swap] = held;
		}

		drawn = pool.slice(0, CAPABILITY_COUNT).map((capability) => capability.id);
	});

	const capabilities = $derived(
		drawn
			.map((id) => CAPABILITIES.find((capability) => capability.id === id))
			.filter((capability): capability is { id: string; icon: string } => !!capability)
			.map((capability) => ({
				...capability,
				title: t(`web.agent.cap.${capability.id}.title`),
				prompt: t(`web.agent.cap.${capability.id}.prompt`)
			}))
	);

	const groups = $derived.by(() => {
		const out: Group[] = [];

		for (const item of session.items) {
			if (item.kind === 'user') {
				out.push({ kind: 'user', item });

				continue;
			}

			if (item.kind === 'event') {
				out.push({ kind: 'event', item });

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
		if (!session.running) {
			return false;
		}

		const last = session.items[session.items.length - 1];

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

	// Claude Code's waiting line: a playful verb picked once per answer and a
	// running count of seconds, so a long tool call still looks alive
	const verbs = $derived(t('web.agent.thinkingVerbs').split('|'));
	let verb = $state('');
	let startedAt = 0;
	let elapsed = $state(0);

	$effect(() => {
		if (!session.running) {
			return;
		}

		verb = verbs[Math.floor(Math.random() * verbs.length)] ?? t('web.agent.thinking');
		startedAt = Date.now();
		elapsed = 0;

		const timer = setInterval(() => {
			elapsed = Math.floor((Date.now() - startedAt) / 1000);
		}, 1000);

		return () => clearInterval(timer);
	});

	const ready = $derived(Agent.state?.ready ?? false);

	// follow the conversation as it grows, unless the reader has scrolled up
	$effect(() => {
		const last = session.items[session.items.length - 1];
		const signature = `${session.items.length}:${last && 'text' in last ? last.text.length : 0}:${thinking}`;

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

	async function decide(item: ToolItem, allow: boolean, answers?: Record<string, string>): Promise<void> {
		deciding[item.id] = true;

		try {
			await session.decide(item.id, allow, item.name, answers);
		} finally {
			deciding[item.id] = false;
		}
	}

	/** The question waiting for the operator, answered in the dock above the composer */
	const asking = $derived(
		session.items.find(
			(item): item is ToolItem => item.kind === 'tool' && item.name === AGENT_ASK_TOOL && item.status === 'awaiting'
		)
	);

	function questionState(item: ToolItem): AgentQuestionState {
		if (item.status === 'awaiting') {
			return 'waiting';
		}

		if (item.status === 'denied') {
			return item.decidedBy === 'timeout'
				? 'timeout'
				: 'dismissed';
		}

		return 'answered';
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

	/** The call's arguments on one line, `key: value`, for the collapsed row. */
	function argsPreview(input: unknown): string {
		if (!input || typeof input !== 'object') {
			return '';
		}

		return Object.entries(input as Record<string, unknown>)
			.map(([key, value]) => {
				const text = typeof value === 'string'
					? value
					: JSON.stringify(value);

				return `${key}: ${text}`;
			})
			.join(' · ');
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

<div class="chat">
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="msgs" bind:this={scroller} onscroll={onScroll} onclick={onMessagesClick}>
		<div class="col">
			{#if Agent.state && !ready}
				<div class="setup">
					<img class="big" src={AVATAR} alt="" />
					<div class="title">{t('web.agent.setupTitle')}</div>
					<p>{Agent.state.reason}</p>
					<Btn variant="primary" href="/console/agent">{t('web.agent.setupAction')}</Btn>
				</div>
			{:else if session.items.length === 0}
				<div class="welcome">
					<img class="big" src={AVATAR} alt="" />
					<div class="title">{@html t('web.agent.welcomeTitle')}</div>
					<p>{t('web.agent.welcomeBody')}</p>
					<div class="caps">
						{#each capabilities as capability (capability.id)}
							<button class="cap" disabled={!ready} onclick={() => composer?.send(capability.prompt)}>
								<span class="cap-head">
									<Icon name={capability.icon} size="0.875rem" />
									{capability.title}
								</span>
								<span class="cap-text">{capability.prompt}</span>
							</button>
						{/each}
					</div>
				</div>
			{/if}

			{#each groups as group, gi (gi)}
				{#if group.kind === 'event'}
					<div class="event" data-source={group.item.source}>
						<button
							class="row"
							title={t('web.agent.details')}
							aria-expanded={!!expanded[`ev${gi}`]}
							onclick={() => (expanded[`ev${gi}`] = !expanded[`ev${gi}`])}
						>
							<Icon name={group.item.source === 'task' ? 'listCheck' : 'bell'} style="solid" size="0.75rem" />
							<span class="what">{t(`web.agent.event.${group.item.source}`)}</span>
							<span class="label">{group.item.label}</span>
							<span class="at">{fmtTime(group.item.at)}</span>
							<Icon name={expanded[`ev${gi}`] ? 'arrowUp' : 'arrowDown'} size="0.625rem" />
						</button>
						{#if expanded[`ev${gi}`]}
							<pre>{group.item.text}</pre>
						{/if}
					</div>
				{:else if group.kind === 'user'}
					<div class="msg user">
						<div class="author">
							{#if account}
								<AccountAvatar {account} size="1.75rem" />
							{:else}
								<span class="avatar">{(group.item.author || user).slice(0, 1).toUpperCase()}</span>
							{/if}
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
							{:else if item.kind === 'tool' && item.name === AGENT_ASK_TOOL}
								<AgentQuestion
									questions={readQuestions(item.input)}
									answers={readAnswers(item.input)}
									phase={questionState(item)}
								/>
							{:else if item.kind === 'tool'}
								<div class="bubble call" data-status={item.status} class:processing={item.status === 'running'}>
									<button
										class="row"
										title={t('web.agent.details')}
										aria-expanded={!!expanded[item.id]}
										onclick={() => (expanded[item.id] = !expanded[item.id])}
									>
										<span class="icon" title={toolTitle(item)} aria-label={toolTitle(item)}>
											{#if item.status === 'running'}
												<Spinner size="0.75rem" color="#fff" />
											{:else}
												<Icon name={toolIcon(item.status)} style="solid" size="0.625rem" />
											{/if}
										</span>
										<code class="name">{item.name}</code>
										<span class="args">{argsPreview(item.input)}</span>
										<span class="caret">
											<Icon name={expanded[item.id] ? 'arrowUp' : 'arrowDown'} size="0.625rem" />
										</span>
									</button>

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
							<div class="thinking" role="status" aria-label={t('web.agent.thinking')}>
								<span class="star"><Icon name="asterisk" size="0.875rem" /></span>
								<span class="verb" data-text="{verb}…">{verb}…</span>
								<span class="elapsed">({elapsed}s)</span>
							</div>
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
					<div class="thinking" role="status" aria-label={t('web.agent.thinking')}>
						<span class="star"><Icon name="asterisk" size="0.875rem" /></span>
						<span class="verb" data-text="{verb}…">{verb}…</span>
						<span class="elapsed">({elapsed}s)</span>
					</div>
				</div>
			{/if}
		</div>
	</div>

	<div class="dock">
		{#if asking}
			<div class="asking">
				{#key asking.id}
					<AgentQuestion
						docked
						questions={readQuestions(asking.input)}
						phase="waiting"
						busy={deciding[asking.id]}
						onanswer={(answers) => asking && decide(asking, true, answers)}
						ondismiss={() => asking && decide(asking, false)}
					/>
				{/key}
			</div>
		{/if}

		<AgentComposer bind:this={composer} {session} onsent={() => (pinned = true)} />
	</div>
</div>

<style lang="scss">
	.chat {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}

	.msgs {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 0.5rem 0 1.5rem;
	}

	// a wide window does not stretch the lines of the conversation across it: the
	// chat keeps a reading width and centres it, as Claude does; the docked panel
	// is narrower than this anyway
	.col {
		width: 100%;
		max-width: 48rem;
		margin: 0 auto;
	}

	.dock {
		flex: none;
		width: 100%;
		max-width: 48rem;
		margin: 0 auto;
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

	// What Mèo Béo can do, as starting points: a heading that names the kind of
	// work and the prompt it would send, so the welcome teaches the range of the
	// agent rather than three questions anybody would think of anyway
	.caps {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.5rem;
		margin-top: 1.25rem;
		text-align: left;
	}

	.cap {
		@include bare-button;

		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.625rem 0.75rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.5rem;
		background: var(--bg-panel-raised);
		color: var(--text);
		text-align: left;

		.cap-head {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			color: var(--text-heading);
			font-size: 0.875rem;
			font-weight: 700;
		}

		.cap-text {
			color: var(--text-secondary);
			font-size: 0.75rem;
			line-height: 1.375;
		}

		&:hover:not(:disabled) {
			border-color: var(--link);

			.cap-head {
				color: var(--link);
			}
		}

		&:disabled {
			opacity: 0.5;
			cursor: default;
		}
	}

	// a background task or a trigger reporting back: a quiet line between the messages
	.event {
		display: flex;
		flex-direction: column;
		margin: 1rem 1rem 0;
		border: 0.1rem dashed var(--border-input);
		border-radius: var(--radius-input);
		background: var(--bg-panel-raised);

		.row {
			@include bare-button;

			display: flex;
			align-items: center;
			gap: 0.5rem;
			width: 100%;
			padding: 0.375rem 0.75rem;
			font-size: 0.75rem;
			color: var(--text-secondary);
			text-align: left;
			cursor: pointer;
		}

		.what {
			font-weight: 600;
			color: var(--text-heading);
		}

		.label {
			@include ellipsis;

			flex: 1;
			min-width: 0;
		}

		.at {
			font-variant-numeric: tabular-nums;
		}

		pre {
			margin: 0;
			padding: 0.5rem 0.75rem 0.75rem;
			max-height: 16rem;
			overflow: auto;
			white-space: pre-wrap;
			overflow-wrap: anywhere;
			font-size: 0.75rem;
			color: var(--text-primary);
		}

		&[data-source='trigger'] .row :global(icon) {
			color: var(--warning);
		}

		&[data-source='task'] .row :global(icon) {
			color: var(--info);
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

	// the agent's words sit on a deep violet: the brand hue, mixed far enough
	// toward the panel that white text reads at ease, with a lighter edge so the
	// bubble still separates from the panel behind it
	.bot .text {
		background: color-mix(in srgb, var(--luna-primary) 30%, var(--bg-panel));
		border: 0.1rem solid color-mix(in srgb, var(--luna-primary) 45%, var(--bg-panel));
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

	// not a bubble, since nothing has been said yet: Claude Code's waiting line,
	// a spinning star, a verb with a light sweeping across it, and the seconds
	.thinking {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.125rem 0;
		font-size: 0.8125rem;

		.star {
			display: inline-grid;
			place-items: center;
			color: var(--src-luna);
			animation: twinkle 2.4s ease-in-out infinite;
		}

		// the verb is drawn twice: dim text underneath, and a copy clipped to a
		// moving band of light on top, which is the shimmer
		.verb {
			position: relative;
			color: var(--text-secondary);

			&::after {
				content: attr(data-text);
				position: absolute;
				inset: 0;
				color: var(--text-heading);
				clip-path: inset(0 100% 0 0);
				animation: shimmer 2s ease-in-out infinite;
			}
		}

		.elapsed {
			color: var(--text-disabled);
			font-size: 0.75rem;
		}
	}

	@keyframes twinkle {
		0% {
			transform: rotate(0deg) scale(0.85);
		}

		50% {
			transform: rotate(180deg) scale(1.15);
		}

		100% {
			transform: rotate(360deg) scale(0.85);
		}
	}

	@keyframes shimmer {
		0% {
			clip-path: inset(0 100% 0 0);
		}

		50% {
			clip-path: inset(0 0 0 0);
		}

		100% {
			clip-path: inset(0 0 0 100%);
		}
	}

	.asking {
		padding: 0 0.75rem 0.5rem;
	}

	.call {
		position: relative;
		display: flex;
		flex-direction: column;
		width: 90%;
		border: 0.1rem solid var(--border-divider);
		border-left: 0.25rem solid var(--luna-primary);
		background: var(--bg-panel-raised);
		overflow: hidden;

		// consecutive calls stack as one list rather than separate cards
		& + & {
			margin-top: -0.125rem;
		}

		.row {
			@include bare-button;

			display: flex;
			align-items: center;
			gap: 0.5rem;
			width: 100%;
			padding: 0.25rem 0.5rem;
			text-align: left;
			color: var(--text-secondary);

			&:hover {
				background: var(--bg-hover);
			}
		}

		.icon {
			display: grid;
			place-items: center;
			width: 1.25rem;
			height: 1.25rem;
			border-radius: 0.25rem;
			background: var(--luna-primary);
			color: #fff;
			flex: none;
		}

		.name {
			flex: none;
			font-family: var(--font-mono);
			font-size: 0.75rem;
			font-weight: 600;
			color: var(--text-heading);
		}

		.args {
			@include ellipsis;

			flex: 1;
			min-width: 0;
			font-family: var(--font-mono);
			font-size: 0.75rem;
			color: var(--text-label);
		}

		.caret {
			display: grid;
			place-items: center;
			flex: none;
			width: 1rem;
		}

		.ask,
		.detail {
			padding: 0.25rem 0.5rem 0.5rem;
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
			border-left-color: var(--success);

			.icon {
				background: var(--success);
			}
		}

		&[data-status='awaiting'] {
			border-left-color: var(--warning);

			.icon {
				background: var(--warning);
				color: var(--primary-text);
			}
		}

		&[data-status='denied'],
		&[data-status='error'] {
			border-left-color: var(--error);

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
