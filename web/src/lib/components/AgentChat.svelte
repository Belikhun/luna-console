<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { tooltip } from '$lib/tooltip.svelte';
	import AgentQuestion from './AgentQuestion.svelte';
	import { readAnswers, readQuestions } from './agentquestion';
	import type { AgentQuestionState } from './agentquestion';
	import { AGENT_ASK_TOOL, AGENT_SUBAGENT_TOOL, AGENT_TODO_TOOL } from '$shared/agent';
	import { currentLanguage, t } from '$lib/i18n.svelte';
	import { Authz } from '$lib/authz.svelte';
	import { tick } from 'svelte';
	import { page } from '$app/state';
	import { Agent, type ChatItem, type ChatSession } from '$lib/agent.svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { copyText } from '$lib/clipboard';
	import { fmtDuration, fmtTime, fmtTokens } from '$lib/format';
	import { Notify } from '$lib/notifications.svelte';
	import Icon from './Icon.svelte';
	import Btn from './Btn.svelte';
	import AgentComposer from './AgentComposer.svelte';
	import AgentToolCard from './AgentToolCard.svelte';
	import AgentTodos from './AgentTodos.svelte';
	import AccountAvatar from './AccountAvatar.svelte';
	import DateTime from './DateTime.svelte';
	import ImageViewer from './ImageViewer.svelte';
	import ConfirmModal from './ConfirmModal.svelte';
	import type { AvatarSubject } from './accountavatar';

	/**
	 * One Mèo Béo conversation as it reads on screen: the messages, the question
	 * waiting for an answer, and the composer, all bound to one `ChatSession`.
	 * The docked panel, each pane of the full-page screen and a popped-out window
	 * all render this, so a chat looks and behaves the same wherever it is open.
	 *
	 * The chat follows the shape of Belikhun's smart-home assistant: an author row
	 * per turn, the agent's words in its own colour, and each tool call as a card
	 * that spins, then settles. Settled calls in a row fold into one "used N
	 * tools" line, as VS Code folds them; a helper's calls nest inside its card.
	 * Hovering a message offers its verbs: copy, edit and resend, retry, branch.
	 *
	 * A shared conversation shows who has it open, and a viewer reads it with
	 * the composer replaced by a note saying so.
	 */
	let {
		session,
		account,
		onbranch
	}: {
		session: ChatSession;
		account: AvatarSubject | null;
		/** Open a branch this chat just made; without it the chat switches to it itself */
		onbranch?: (id: string) => void;
	} = $props();

	/** the signed-in account's name */
	const me = $derived(Agent.state?.me ?? account?.username ?? 'root');

	type ToolItem = Extract<ChatItem, { kind: 'tool' }>;
	type UserItem = Extract<ChatItem, { kind: 'user' }>;
	type StatsItem = Extract<ChatItem, { kind: 'stats' }>;
	type BotItem = Exclude<ChatItem, { kind: 'user' } | { kind: 'event' } | { kind: 'compact' } | { kind: 'stats' }>;

	/** What a bot turn shows, in order: its items, with runs of settled calls folded into one */
	type Segment = BotItem | { kind: 'calls'; key: string; items: ToolItem[] };

	type Group =
		| { kind: 'user'; item: UserItem }
		| { kind: 'event'; item: Extract<ChatItem, { kind: 'event' }> }
		| { kind: 'compact'; item: Extract<ChatItem, { kind: 'compact' }> }
		| {
			kind: 'bot';
			items: BotItem[];
			segments: Segment[];
			stats: StatsItem | null;
			/** The message after this turn, which a branch from here keeps everything before */
			before?: string;
		};

	/** Mèo Béo's picture, served from the console's own static files */
	const AVATAR = '/agent/meo-beo.webp';

	/** How many settled calls in a row fold into one line */
	const FOLD_AT = 2;

	let composer: AgentComposer | undefined = $state();
	let scroller: HTMLDivElement | undefined = $state();
	let expanded: Record<string, boolean> = $state({});
	let deciding: Record<string, boolean> = $state({});

	/** whether the reader is at the bottom; new text only scrolls a reader who is */
	let pinned = $state(true);

	/** px from the bottom that still counts as "at the bottom" */
	const PIN_SLACK = 48;

	// a new chat's welcome reads from the top, however short the pane
	$effect(() => {
		// read so the welcome is put back at the top once its cards and setup state arrive
		void Agent.state;
		void drawn;

		if (session.items.length === 0 && scroller) {
			const target = scroller;

			void tick().then(() => {
				target.scrollTop = 0;
			});
		}
	});

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

	/** A call folds into a "used N tools" line once it settled fine and has nothing of its own to show. */
	function foldable(item: BotItem): item is ToolItem {
		return item.kind === 'tool'
			&& item.status === 'ok'
			&& !item.images?.length
			&& !item.files?.length
			&& item.name !== AGENT_ASK_TOOL
			&& item.name !== AGENT_SUBAGENT_TOOL
			&& item.name !== AGENT_TODO_TOOL;
	}

	function segmentsOf(items: BotItem[]): Segment[] {
		const out: Segment[] = [];
		let run: ToolItem[] = [];

		const flush = (): void => {
			if (run.length >= FOLD_AT) {
				out.push({ kind: 'calls', key: run[0]!.id, items: run });
			} else {
				out.push(...run);
			}

			run = [];
		};

		for (const item of items) {
			if (foldable(item)) {
				run.push(item);

				continue;
			}

			flush();
			out.push(item);
		}

		flush();

		return out;
	}

	/** Messages held for the end of the answer, pinned under it in the order sent */
	const held = $derived(session.items.filter((item): item is UserItem => item.kind === 'user' && !!item.queued));

	const groups = $derived.by(() => {
		const out: Group[] = [];

		for (const item of session.items) {
			// a helper's own calls are drawn inside its card
			if (item.kind === 'tool' && item.parent) {
				continue;
			}

			// held messages wait under the live answer until they go out
			if (item.kind === 'user' && item.queued) {
				continue;
			}

			if (item.kind === 'user' || item.kind === 'event' || item.kind === 'compact') {
				const previous = out[out.length - 1];

				if (previous?.kind === 'bot' && item.kind !== 'compact') {
					previous.before = item.uuid;
				}

				out.push({ kind: item.kind, item } as Group);

				continue;
			}

			const last = out[out.length - 1];
			const bot = last?.kind === 'bot'
				? last
				: null;

			if (item.kind === 'stats') {
				if (bot) {
					bot.stats = item;
				}

				continue;
			}

			if (bot) {
				bot.items.push(item);
			} else {
				out.push({ kind: 'bot', items: [item], segments: [], stats: null });
			}
		}

		for (const group of out) {
			if (group.kind === 'bot') {
				group.segments = segmentsOf(group.items);
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

		if ((last.kind === 'assistant' || last.kind === 'thinking') && last.streaming) {
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

	/** The page this window shows, which goes along with a resent message like with a typed one */
	const pagePath = $derived(page.url.pathname.startsWith('/agent') ? undefined : page.url.pathname);

	/** Whether the conversation is anybody's but this account's alone: shared, or shared with it */
	const shared = $derived(session.role !== 'owner' || (session.row?.shares?.length ?? 0) > 0);
	const others = $derived(session.viewers.filter((name) => name !== me));

	/** The last turn, the one retry asks again */
	const lastBot = $derived.by(() => {
		for (let index = groups.length - 1; index >= 0; index--) {
			if (groups[index]!.kind === 'bot') {
				return index;
			}

			if (groups[index]!.kind === 'user') {
				return -1;
			}
		}

		return -1;
	});

	// follow the conversation as it grows, unless the reader has scrolled up
	$effect(() => {
		const last = session.items[session.items.length - 1];
		const signature = `${session.items.length}:${last && 'text' in last ? last.text.length : 0}:${thinking}`;

		void signature;

		// an empty chat is its welcome, read from the top; nothing to follow yet
		if (session.items.length === 0) {
			return;
		}

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

	// a chat that was hidden (a panel or tab with no height) opens on its latest
	// message when it comes into view, not on the top of the transcript
	$effect(() => {
		const box = scroller;

		if (!box || typeof ResizeObserver === 'undefined') {
			return;
		}

		let hidden = box.clientHeight === 0;
		const watch = new ResizeObserver(() => {
			const now = box.clientHeight === 0;

			if (hidden && !now) {
				pinned = true;
				box.scrollTop = box.scrollHeight;
			}

			hidden = now;
		});

		watch.observe(box);

		return () => watch.disconnect();
	});

	function toBottom(): void {
		pinned = true;
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
	}

	async function answer(item: ToolItem, allow: boolean, answers?: Record<string, string>): Promise<void> {
		deciding[item.id] = true;

		try {
			await session.decide(item.id, allow, item.name, answers ? { answers } : {});
		} finally {
			deciding[item.id] = false;
		}
	}

	/** The question waiting for an answer, answered in the dock above the composer */
	const asking = $derived(
		session.items.find(
			(item): item is ToolItem => item.kind === 'tool' && item.name === AGENT_ASK_TOOL && item.status === 'awaiting'
		)
	);

	/** Calls waiting on this account, which the dock offers to settle in one go */
	const waitingMine = $derived(
		session.items.filter(
			(item): item is ToolItem =>
				item.kind === 'tool' && item.status === 'awaiting' && item.name !== AGENT_ASK_TOOL && session.decides(item)
		)
	);

	const todos = $derived(session.todos);
	const showTodos = $derived(!!todos && (session.running || todos.some((todo) => todo.status !== 'completed')));

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

	/** An answer's wall time: tenths under ten seconds, where whole seconds would read "0s" */
	function answerTime(ms: number): string {
		return ms < 10_000
			? `${(ms / 1000).toFixed(1)}s`
			: fmtDuration(ms);
	}

	/** The pictures attached to a message, as the chat's image bubbles show them */
	function attachedPictures(item: UserItem): Array<{ src: string; alt: string; name: string }> {
		if (!session.conversationId) {
			return [];
		}

		return (item.attachments ?? [])
			.filter((file): file is { name: string; size: number; image: string } => !!file.image)
			.map((file) => ({
				src: `/api/agent/conversations/${session.conversationId}/images/${encodeURIComponent(file.image)}`,
				alt: file.name,
				name: file.name
			}));
	}

	/** The set the full-screen viewer steps through, and which of it is shown; null while closed */
	let viewerPictures: Array<{ src: string; alt: string; name: string }> = $state([]);
	let viewerIndex: number | null = $state(null);

	function openPictures(pictures: Array<{ src: string; alt: string; name: string }>, index: number): void {
		viewerPictures = pictures;
		viewerIndex = index;
	}

	/** A message's time as the chat shows it: the clock today, the day as well before that */
	function clock(at: number): string {
		const when = new Date(at);
		const locale = currentLanguage() === 'vi'
			? 'vi-VN'
			: 'en-GB';
		const today = when.toDateString() === new Date().toDateString();

		return today
			? when.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
			: when.toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
	}

	/** A model's name as the picker words it, or its id when the list does not know it */
	function modelName(value: string): string {
		return Agent.state?.models?.find((model) => model.value === value)?.label ?? value;
	}

	/** When a turn of the agent's began: its first item that knows */
	function turnStart(items: BotItem[]): number | null {
		for (const item of items) {
			if ('at' in item && item.at) {
				return item.at;
			}
		}

		return null;
	}

	function initial(name: string): string {
		return (name || '?').slice(0, 1).toUpperCase();
	}

	/** The names of the calls a folded line covers, each once, for its summary */
	function callNames(items: ToolItem[]): string {
		return [...new Set(items.map((item) => item.name))].join(', ');
	}

	// -- message verbs -------------------------------------------------------

	let copied: string | null = $state(null);

	async function copy(key: string, text: string): Promise<void> {
		if (await copyText(text)) {
			copied = key;
			setTimeout(() => {
				if (copied === key) {
					copied = null;
				}
			}, 1500);
		}
	}

	function botText(group: Extract<Group, { kind: 'bot' }>): string {
		return group.items
			.filter((item): item is Extract<ChatItem, { kind: 'assistant' }> => item.kind === 'assistant')
			.map((item) => item.text)
			.join('\n\n');
	}

	/** The message being edited in place, by uuid, and its new words */
	let editing: string | null = $state(null);
	let editText = $state('');

	/** Rewinding is confirmed once per page load, like bypass: after that it is a known verb */
	let rewindConfirmed = false;
	let confirmRewind = $state(false);
	let pendingRewind: (() => Promise<void>) | null = null;

	const canRewind = $derived(session.writable && !session.running && !session.sending && !!session.conversationId);

	function guarded(action: () => Promise<void>): void {
		if (rewindConfirmed) {
			void action();

			return;
		}

		pendingRewind = action;
		confirmRewind = true;
	}

	function startEdit(item: UserItem): void {
		editing = item.uuid ?? null;
		editText = item.text;
	}

	function submitEdit(): void {
		const target = editing;
		const text = editText;

		if (!target || !text.trim()) {
			return;
		}

		guarded(async () => {
			editing = null;
			pinned = true;
			await session.rewind(target, text, pagePath);
		});
	}

	function retry(): void {
		guarded(async () => {
			pinned = true;
			await session.retry(pagePath);
		});
	}

	async function branch(before?: string): Promise<void> {
		try {
			const id = await session.fork(before);

			if (!id) {
				return;
			}

			if (onbranch) {
				onbranch(id);
			} else {
				await session.select(id);
			}
		} catch (err) {
			Notify.error(t('web.agent.branchFailed'), { detail: (err as Error).message });
		}
	}
</script>

{#snippet userMessage(item: UserItem, key: string)}
	{@const author = item.author || me}
	{@const person = author === me && account ? account : session.people[author]}
	{@const pictures = attachedPictures(item)}
	<div class="msg user" class:queued={item.queued}>
		<div class="author">
			{#if person}
				<AccountAvatar account={person} size="1.75rem" />
			{:else}
				<span class="avatar">{initial(author)}</span>
			{/if}
			<span class="who">{author}</span>
			{#if item.mode && item.mode !== 'auto'}
				<span class="modetag {item.mode}">{t(`web.agentComposer.mode_${item.mode}`)}</span>
			{/if}
			{#if item.queued}
				<span class="modetag queued">{t('web.agent.queued')}</span>
				{#if author === me && item.uuid}
					{@const uuid = item.uuid}
					<button class="act revoke" use:tooltip={{ content: t('web.agent.revokeQueued') }} aria-label={t('web.agent.revokeQueued')} onclick={() => session.revoke(uuid)}>
						<Icon name="close" size="0.75rem" />
					</button>
				{/if}
			{/if}
		</div>
		{#if editing && editing === item.uuid}
			<div class="editor">
				<!-- svelte-ignore a11y_autofocus -->
				<textarea
					class="input"
					rows="3"
					autofocus
					bind:value={editText}
					onkeydown={(event) => {
						if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
							event.preventDefault();
							submitEdit();
						}

						if (event.key === 'Escape') {
							editing = null;
						}
					}}
				></textarea>
				<div class="btns">
					<Btn onclick={() => (editing = null)}>{t('web.common.cancel')}</Btn>
					<Btn variant="primary" icon="paperPlaneTop" disabled={!editText.trim()} onclick={submitEdit}>
						{t('web.agent.resend')}
					</Btn>
				</div>
			</div>
		{:else if item.text}
			<div class="bubble text">{item.text}</div>
		{/if}
		{#if pictures.length}
			<div class="pics">
				{#each pictures as picture, pi (picture.src)}
					<button class="pic" type="button" use:tooltip={{ content: t('web.agent.openImage') }} aria-label={t('web.agent.openImage')} onclick={() => openPictures(pictures, pi)}>
						<img src={picture.src} alt={picture.alt} loading="lazy" />
					</button>
				{/each}
			</div>
		{/if}
		{#each (item.attachments ?? []).filter((file) => !file.image || !session.conversationId) as file}
			<div class="bubble file">
				<Icon name="paperclip" size="0.75rem" />
				<span class="fname">{file.name}</span>
			</div>
		{/each}
		<!-- under the bubble: the verbs on hover, then when it was sent and what answered it -->
		<div class="foot">
			{#if editing !== item.uuid}
				<div class="acts">
					<button class="act" use:tooltip={{ content: t('web.agent.copyMessage') }} aria-label={t('web.agent.copyMessage')} onclick={() => copy(key, item.text)}>
						<Icon name={copied === key ? 'check' : 'copy'} size="0.75rem" />
					</button>
					{#if item.uuid && session.writable && !item.queued}
						<button
							class="act"
							use:tooltip={{ content: (canRewind ? t('web.agent.editMessage') : t('web.agent.editBusy')) ?? '' }} aria-label={canRewind ? t('web.agent.editMessage') : t('web.agent.editBusy')}
							disabled={!canRewind}
							onclick={() => startEdit(item)}
						>
							<Icon name="pen" size="0.75rem" />
						</button>
					{/if}
				</div>
			{/if}
			<time class="at" datetime={new Date(item.at).toISOString()}><DateTime at={item.at} text={clock(item.at)} /></time>
			{#if item.model}
				<span class="sent" use:tooltip={{ content: t('web.agent.sentWith') }}>
					{modelName(item.model)}{#if item.effort}<span class="dim">{` · ${t(`web.agentSettings.effort_${item.effort}`)}`}</span>{/if}
				</span>
			{/if}
		</div>
	</div>
{/snippet}

<ImageViewer images={viewerPictures} bind:index={viewerIndex} />

<div class="chat">
	{#if shared && session.conversationId}
		<div class="presence" role="status">
			<Icon name="userGroup" size="0.75rem" style="solid" />
			<span class="what">
				{session.role === 'owner'
					? t('web.agent.sharedByYou', { count: session.row?.shares?.length ?? 0 })
					: t('web.agent.sharedWithYou', { owner: session.row?.owner ?? '', role: t(`web.agentShare.role_${session.role}`) })}
			</span>
			{#if others.length}
				<span class="faces" use:tooltip={{ content: t('web.agent.viewingNow', { names: others.join(', ') }) }}>
					{#each others.slice(0, 4) as name (name)}
						{@const person = session.people[name]}
						{#if person}
							<span class="face pic"><AccountAvatar account={person} size="1.25rem" /></span>
						{:else}
							<span class="face">{initial(name)}</span>
						{/if}
					{/each}
					{#if others.length > 4}
						<span class="face more">+{others.length - 4}</span>
					{/if}
				</span>
			{/if}
		</div>
	{/if}

	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="msgs" bind:this={scroller} onscroll={onScroll} onclick={onMessagesClick}>
		<div class="col">
			{#if Agent.state && !ready}
				<div class="setup">
					<img class="big" src={AVATAR} alt="" />
					<div class="title">{t('web.agent.setupTitle')}</div>
					<p>{Agent.state.reason}</p>
					<Btn
						variant="primary"
						href="/console/agent"
						disabled={!Authz.can('agent:Configure')}
						title={Authz.can('agent:Configure') ? undefined : t('web.common.notAllowed', { action: 'agent:Configure' })}
					>
						{t('web.agent.setupAction')}
					</Btn>
				</div>
			{:else if session.items.length === 0 && !session.loading}
				<div class="welcome">
					<img class="big" src={AVATAR} alt="" />
					<div class="title">{@html t('web.agent.welcomeTitle')}</div>
					<p>{session.row?.forkedFrom ? t('web.agent.branchWelcome', { title: session.row.forkedFrom.title || t('web.agent.untitled') }) : t('web.agent.welcomeBody')}</p>
					<div class="caps">
						{#each capabilities as capability (capability.id)}
							<button class="cap" disabled={!ready || !session.writable} onclick={() => composer?.send(capability.prompt)}>
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
				{#if group.kind === 'compact'}
					<div class="compacted" role="note">
						<Icon name="compress" style="solid" size="0.75rem" />
						<span>
							{group.item.postTokens !== undefined
								? t('web.agent.compacted', { before: fmtTokens(group.item.preTokens), after: fmtTokens(group.item.postTokens) })
								: t('web.agent.compactedFrom', { before: fmtTokens(group.item.preTokens) })}
						</span>
						<span class="who">
							{group.item.by
								? t('web.agent.compactedBy', { name: group.item.by })
								: t('web.agent.compactedAuto')}
						</span>
						<span class="at"><DateTime at={group.item.at} text={fmtTime(group.item.at)} /></span>
					</div>
				{:else if group.kind === 'event'}
					<div class="event" data-source={group.item.source}>
						<button
							class="row"
							use:tooltip={{ content: t('web.agent.details') }} aria-label={t('web.agent.details')}
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
					{@render userMessage(group.item, `u${gi}`)}
				{:else}
					{@const started = turnStart(group.items)}
					<div class="msg bot">
						<div class="author">
							<img class="avatar cat" src={AVATAR} alt="" />
							<span class="who">Mèo Béo</span>
							{#if started}
								<time class="at" datetime={new Date(started).toISOString()}><DateTime at={started} text={clock(started)} /></time>
							{/if}
						</div>

						{#each group.segments as segment, si (segment.kind === 'tool' ? segment.id : segment.kind === 'calls' ? `c${segment.key}` : `${gi}:${si}`)}
							{#if segment.kind === 'assistant'}
								<div class="bubble text md" class:streaming={segment.streaming}>{@html renderMarkdown(segment.text, { copyLabel: t('web.agent.copyCode') })}</div>
							{:else if segment.kind === 'thinking'}
								{@const key = `th${gi}:${si}`}
								<div class="thought" class:streaming={segment.streaming}>
									<button class="row" aria-expanded={!!expanded[key]} onclick={() => (expanded[key] = !expanded[key])}>
										<Icon name="lightbulb" size="0.75rem" style={segment.streaming ? 'solid' : 'regular'} />
										<span class="lbl" data-text={t('web.agent.thinkingNow')}>
											{segment.streaming ? t('web.agent.thinkingNow') : t('web.agent.thought')}
										</span>
										<Icon name={expanded[key] ? 'arrowUp' : 'arrowDown'} size="0.625rem" />
									</button>
									{#if expanded[key]}
										<div class="body">{segment.text}</div>
									{/if}
								</div>
							{:else if segment.kind === 'calls'}
								<div class="calls">
									<button
										class="row"
										aria-expanded={!!expanded[`c${segment.key}`]}
										onclick={() => (expanded[`c${segment.key}`] = !expanded[`c${segment.key}`])}
									>
										<span class="icon"><Icon name="check" style="solid" size="0.625rem" /></span>
										<span class="sum">{t('web.agent.usedTools', { count: segment.items.length })}</span>
										<span class="names">{callNames(segment.items)}</span>
										<Icon name={expanded[`c${segment.key}`] ? 'arrowUp' : 'arrowDown'} size="0.625rem" />
									</button>
									{#if expanded[`c${segment.key}`]}
										<div class="list">
											{#each segment.items as call (call.id)}
												<AgentToolCard item={call} {session} items={session.items} nested />
											{/each}
										</div>
									{/if}
								</div>
							{:else if segment.kind === 'tool' && segment.name === AGENT_ASK_TOOL}
								<AgentQuestion
									questions={readQuestions(segment.input)}
									answers={readAnswers(segment.input)}
									phase={questionState(segment)}
								/>
							{:else if segment.kind === 'tool'}
								<AgentToolCard item={segment} {session} items={session.items} />
							{:else if segment.kind === 'error'}
								<div class="bubble err">
									<Icon name="triangleExclamation" size="0.875rem" />
									<span>{errorText(segment)}</span>
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

						{#if !(session.running && gi === groups.length - 1)}
							<div class="foot">
								{#if group.stats}
									<span class="stats" use:tooltip={{ content: t('web.agent.statsTitle') }}>
										{t(group.stats.reviewUsd ? 'web.agent.statsReview' : 'web.agent.stats', {
											time: answerTime(group.stats.ms),
											tools: group.stats.tools,
											cost: group.stats.costUsd.toFixed(3),
											review: (group.stats.reviewUsd ?? 0).toFixed(4)
										})}
									</span>
								{/if}
								<span class="acts">
									{#if botText(group)}
										<button class="act" use:tooltip={{ content: t('web.agent.copyMessage') }} aria-label={t('web.agent.copyMessage')} onclick={() => copy(`b${gi}`, botText(group))}>
											<Icon name={copied === `b${gi}` ? 'check' : 'copy'} size="0.75rem" />
										</button>
									{/if}
									{#if gi === lastBot && session.writable}
										<button
											class="act"
											use:tooltip={{ content: (canRewind ? t('web.agent.retry') : t('web.agent.editBusy')) ?? '' }} aria-label={canRewind ? t('web.agent.retry') : t('web.agent.editBusy')}
											disabled={!canRewind}
											onclick={retry}
										>
											<Icon name="arrowRotateRight" size="0.75rem" />
										</button>
									{/if}
									{#if session.role === 'owner' && session.conversationId}
										<button class="act" use:tooltip={{ content: t('web.agent.branchHere') }} aria-label={t('web.agent.branchHere')} disabled={session.running} onclick={() => branch(group.before)}>
											<Icon name="codeBranch" size="0.75rem" />
										</button>
									{/if}
								</span>
							</div>
						{/if}
					</div>
				{/if}
			{/each}

			{#if thinking && groups[groups.length - 1]?.kind !== 'bot'}
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

			{#each held as item, hi (item.uuid ?? item.nonce ?? hi)}
				{@render userMessage(item, `h${hi}`)}
			{/each}
		</div>
	</div>

	{#if !pinned}
		<button class="jump" use:tooltip={{ content: t('web.agent.jumpLatest') }} aria-label={t('web.agent.jumpLatest')} onclick={toBottom}>
			<Icon name="arrowDownToLine" size="0.875rem" />
		</button>
	{/if}

	<div class="dock">
		{#if asking}
			<div class="asking">
				{#if session.decides(asking)}
					{#key asking.id}
						<AgentQuestion
							docked
							questions={readQuestions(asking.input)}
							phase="waiting"
							busy={deciding[asking.id]}
							onanswer={(answers) => asking && answer(asking, true, answers)}
							ondismiss={() => asking && answer(asking, false)}
						/>
					{/key}
				{:else}
					<p class="note">{t('web.agent.questionFor', { name: asking.actor ?? session.actor ?? '' })}</p>
				{/if}
			</div>
		{/if}

		{#if waitingMine.length > 1}
			<div class="bulk">
				<Icon name="shieldCheck" size="0.875rem" />
				<span>{t('web.agent.waitingCount', { count: waitingMine.length })}</span>
				<Btn icon="check" variant="primary" onclick={() => session.decideAll(true)}>{t('web.agent.approveAll')}</Btn>
				<Btn icon="ban" onclick={() => session.decideAll(false)}>{t('web.agent.denyAll')}</Btn>
			</div>
		{/if}

		{#if session.suggestion && !session.running && session.writable}
			<div class="suggest">
				<button class="chip" use:tooltip={{ content: t('web.agent.suggestionHint') }} onclick={() => composer?.send(session.suggestion ?? '')}>
					<Icon name="sparkles" size="0.75rem" />
					<span>{session.suggestion}</span>
				</button>
			</div>
		{/if}

		{#if session.writable}
			{#if showTodos && todos}
				<AgentTodos {todos} running={session.running} />
			{/if}
			<AgentComposer bind:this={composer} {session} onsent={() => (pinned = true)} />
		{:else}
			<div class="readonly">
				<Icon name="eye" size="0.875rem" />
				<span>{t('web.agent.readOnly', { owner: session.row?.owner ?? '' })}</span>
			</div>
		{/if}
	</div>
</div>

<ConfirmModal
	bind:open={confirmRewind}
	title={t('web.agent.rewindTitle')}
	lead={t('web.agent.rewindLead')}
	notes={[t('web.agent.rewindNote')]}
	confirmLabel={t('web.agent.rewindConfirm')}
	danger={false}
	onconfirm={() => {
		rewindConfirmed = true;
		confirmRewind = false;

		const action = pendingRewind;

		pendingRewind = null;
		void action?.();
	}}
/>

<style lang="scss">
	.chat {
		position: relative;
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
	// a rule across the transcript: everything above it reaches the model only as a summary
	.compacted {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 1rem 1rem 0;
		font-size: 0.75rem;
		color: var(--text-secondary);

		&::before,
		&::after {
			content: '';
			flex: 1;
			min-width: 1rem;
			border-top: 0.1rem dashed var(--border-input);
		}

		.who,
		.at {
			color: var(--text-disabled);
		}

		.at {
			font-variant-numeric: tabular-nums;
		}
	}

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
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
		margin: 1rem 1rem 0;

		&.user {
			align-items: flex-end;

			.author {
				flex-direction: row-reverse;
			}

			.text {
				background: var(--bg-hover);
				color: var(--text-heading);
				white-space: pre-wrap;
				overflow-wrap: anywhere;
			}

			// held for the end of the answer: a ghost of the message until it goes out
			&.queued {
				.bubble {
					opacity: 0.55;
					border: 0.1rem dashed var(--border-input);
				}

				.author :global(.avatar) {
					opacity: 0.55;
				}
			}
		}

		// the verbs of a message appear under it on hover, as in VS Code's chat
		&:hover .acts,
		&:focus-within .acts {
			opacity: 1;
		}
	}

	// pictures an operator attached: image bubbles of their own, shaped like the
	// message's bubbles, opening the full-screen viewer
	.pics {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.375rem;
		max-width: 90%;
	}

	.pic {
		@include bare-button;

		display: block;
		width: 7.5rem;
		height: 7.5rem;
		border: 0.1rem solid var(--border-input);
		border-radius: 0.75rem 0.25rem 0.75rem 0.75rem;
		overflow: hidden;
		background: var(--bg-track);
		cursor: zoom-in;

		&:hover {
			border-color: var(--link);
		}

		&:focus-visible {
			@include focus-ring;
		}

		img {
			display: block;
			width: 100%;
			height: 100%;
			object-fit: cover;
		}
	}

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

	// when a message was sent, and what it was sent to: quiet beside the name
	.at,
	.sent {
		font-size: 0.6875rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	// the time reads like the stats line under the agent's bubbles
	.at {
		color: var(--text-disabled);
	}

	.sent {
		padding: 0 0.375rem;
		border-radius: 0.25rem;
		background: var(--bg-hover);
		color: var(--text);

		.dim {
			color: var(--text-secondary);
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

		&.queued {
			color: var(--text-secondary);
			border-style: dashed;
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

		// the bubble that ends the agent's turn rounds out its corner; only the
		// stats row (or the live "thinking" line) may come after it
		.msg.bot > &:not(:has(~ :not(.foot, .thinking))) {
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

	@keyframes blink {
		50% {
			opacity: 0;
		}
	}

	// who else is in a shared conversation, above its messages
	.presence {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
		padding: 0.375rem 1rem;
		border-bottom: 0.1rem solid var(--border-divider);
		font-size: 0.75rem;
		color: var(--text-secondary);

		.what {
			@include ellipsis;

			flex: 1;
			min-width: 0;
		}
	}

	.faces {
		display: inline-flex;
		flex: none;
	}

	.face {
		display: inline-grid;
		place-items: center;
		width: 1.25rem;
		height: 1.25rem;
		margin-left: -0.25rem;
		border: 0.1rem solid var(--bg-panel);
		border-radius: 50%;
		background: var(--bg-selected);
		color: var(--text-heading);
		font-size: 0.625rem;
		font-weight: 700;

		// the picture draws its own disc; the ring stays, so overlapping faces stay apart
		&.pic {
			overflow: hidden;
			background: none;
		}

		&.more {
			background: var(--bg-hover);
		}
	}

	// a message's verbs: quiet until the message is hovered or focused
	.acts {
		display: inline-flex;
		gap: 0.125rem;
		opacity: 0;
		transition: opacity 0.12s ease;
	}

	.act {
		@include bare-button;

		display: inline-grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 0.375rem;
		color: var(--text-secondary);

		&:hover:not(:disabled) {
			background: var(--bg-hover);
			color: var(--link);
		}

		&:disabled {
			opacity: 0.4;
			cursor: default;
		}
	}

	// under a turn: what it took, then its verbs
	.foot {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 1.5rem;

		.stats {
			font-size: 0.6875rem;
			color: var(--text-disabled);
			font-variant-numeric: tabular-nums;
		}
	}

	.editor {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 90%;

		textarea {
			width: 100%;
			resize: vertical;
			font-family: inherit;
		}

		.btns {
			display: flex;
			justify-content: flex-end;
			gap: 0.5rem;
		}
	}

	// what the model thought: one quiet line that opens to the summary
	.thought {
		max-width: 90%;

		.row {
			@include bare-button;

			display: inline-flex;
			align-items: center;
			gap: 0.5rem;
			padding: 0.125rem 0.25rem;
			font-size: 0.75rem;
			color: var(--text-secondary);

			&:hover {
				color: var(--text-heading);
			}
		}

		.lbl {
			position: relative;
		}

		&.streaming .lbl::after {
			content: attr(data-text);
			position: absolute;
			inset: 0;
			color: var(--text-heading);
			clip-path: inset(0 100% 0 0);
			animation: shimmer 2s ease-in-out infinite;
		}

		.body {
			margin: 0.25rem 0 0.25rem 0.375rem;
			padding: 0.25rem 0 0.25rem 0.75rem;
			border-left: 0.125rem solid var(--border-input);
			max-height: 16rem;
			overflow-y: auto;
			font-size: 0.8125rem;
			line-height: 1.5;
			color: var(--text-secondary);
			white-space: pre-wrap;
			overflow-wrap: anywhere;
		}
	}

	// settled calls in a row, folded into one line
	.calls {
		display: flex;
		flex-direction: column;
		width: 90%;
		border: 0.1rem solid var(--border-divider);
		// shaped like the bubbles around it: tight on the agent's side, rounded
		// out at the bottom when the folded calls end the turn
		border-radius: 0.25rem 0.75rem 0.75rem 0.25rem;
		background: var(--bg-panel-raised);

		.msg.bot > &:not(:has(~ :not(.foot, .thinking))) {
			border-bottom-left-radius: 0.75rem;
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
			flex: none;
			width: 1.25rem;
			height: 1.25rem;
			border-radius: 0.25rem;
			background: var(--success);
			color: #fff;
		}

		.sum {
			flex: none;
			font-size: 0.75rem;
			font-weight: 600;
			color: var(--text-heading);
		}

		.names {
			@include ellipsis;

			flex: 1;
			min-width: 0;
			font-family: var(--font-mono);
			font-size: 0.75rem;
			color: var(--text-label);
		}

		.list {
			display: flex;
			flex-direction: column;
			gap: 0.125rem;
			padding: 0 0.5rem 0.375rem;
		}
	}

	.jump {
		@include bare-button;

		position: absolute;
		right: 1.5rem;
		bottom: 9rem;
		z-index: 2;
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border: 0.1rem solid var(--border-input);
		border-radius: 50%;
		background: var(--bg-dropdown);
		box-shadow: var(--shadow-dropdown);
		color: var(--text-heading);

		&:hover {
			color: var(--link);
		}
	}

	.bulk,
	.readonly {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0 1rem 0.5rem;
		padding: 0.5rem 0.75rem;
		border: 0.1rem solid var(--warning);
		border-radius: 0.75rem;
		background: var(--bg-panel-raised);
		font-size: 0.8125rem;

		span {
			flex: 1;
			min-width: 0;
		}
	}

	.readonly {
		margin: 0.75rem 1rem 1rem;
		border-color: var(--border-input);
		color: var(--text-secondary);
	}

	.asking .note {
		margin: 0;
		padding: 0.5rem 0.25rem;
		font-size: 0.8125rem;
		color: var(--text-secondary);
	}

	.suggest {
		display: flex;
		padding: 0 1rem 0.5rem;

		.chip {
			@include bare-button;

			display: inline-flex;
			align-items: center;
			gap: 0.5rem;
			max-width: 100%;
			padding: 0.375rem 0.75rem;
			border: 0.1rem dashed var(--border-input);
			border-radius: 1rem;
			font-size: 0.8125rem;
			color: var(--text);
			text-align: left;

			span {
				@include ellipsis;
			}

			&:hover {
				border-color: var(--link);
				color: var(--link);
			}
		}
	}
</style>
