<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { tooltip } from '$lib/tooltip.svelte';
	import { t } from '$lib/i18n.svelte';
	import { renderMarkdown } from '$lib/markdown';
	import { fmtBytes, fmtDuration } from '$lib/format';
	import { AGENT_SUBAGENT_TOOL, AGENT_TODO_TOOL, readTodos } from '$shared/agent';
	import type { ChatItem, ChatSession } from '$lib/agent.svelte';
	import Icon from './Icon.svelte';
	import Btn from './Btn.svelte';
	import Spinner from './Spinner.svelte';
	import AgentToolCard from './AgentToolCard.svelte';
	import ImageViewer from './ImageViewer.svelte';

	type ToolItem = Extract<ChatItem, { kind: 'tool' }>;

	/**
	 * One tool call in a Mèo Béo conversation: a row that spins, then settles
	 * into a check, a ban or a warning, and opens to show what went in and came
	 * out. A call waiting for approval holds its verbs (allow once, allow for
	 * the rest of the chat, deny with a reason) for the account whose run made
	 * it; everyone else following the conversation sees who it waits for.
	 *
	 * Two calls read differently: a helper (`Agent`) is a card of its own with
	 * its progress, the calls it made nested inside and its report as Markdown,
	 * and a checklist update (`TodoWrite`) is one quiet line, since the list
	 * itself sits above the composer.
	 */
	let {
		item,
		session,
		items,
		nested = false
	}: {
		item: ToolItem;
		session: ChatSession;
		/** The whole conversation, where a helper's own calls are found by their parent */
		items: ChatItem[];
		nested?: boolean;
	} = $props();

	let expanded = $state(false);
	let deciding = $state(false);
	let reason = $state('');

	const helper = $derived(item.name === AGENT_SUBAGENT_TOOL);
	const todos = $derived(item.name === AGENT_TODO_TOOL ? readTodos(item.input) : null);
	const mine = $derived(session.decides(item));

	/** A picture the browser can draw, by its name */
	const PICTURE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

	/** The files the call handed over, each with where it downloads from and where it shows in place */
	const shared = $derived(
		(item.files ?? []).map((file) => {
			const href = file.instance
				? `/api/instances/${encodeURIComponent(file.instance)}/files/download?path=${encodeURIComponent(file.path ?? '')}`
				: `/api/agent/conversations/${session.conversationId}/files/${file.id}`;

			return { ...file, href, inline: `${href}${href.includes('?') ? '&' : '?'}inline=1` };
		})
	);

	/** Shared files that are not pictures: download cards */
	const downloads = $derived(shared.filter((file) => !PICTURE.test(file.name)));

	/**
	 * The pictures the call returned or shared, as the image message under it
	 * shows them: a shared picture is an image bubble like one the agent was
	 * shown, and the viewer's download keeps its name
	 */
	const shots = $derived([
		...(item.images?.length && session.conversationId
			? item.images.map((image) => ({
				src: `/api/agent/conversations/${session.conversationId}/images/${encodeURIComponent(image)}`,
				alt: t('web.agent.toolImage', { tool: item.name }),
				name: image
			}))
			: []),
		...shared
			.filter((file) => PICTURE.test(file.name))
			.map((file) => ({ src: file.inline, alt: file.name, name: file.name }))
	]);

	const FILE_ICONS: Array<[RegExp, string]> = [
		[/\.(json|ya?ml|toml|properties|conf|cfg|ini|xml|sql|js|ts|sh|py|mcfunction)$/i, 'fileCode'],
		[/\.(txt|log|md)$/i, 'fileLines'],
		[/\.(csv|tsv)$/i, 'fileChart'],
		[/\.pdf$/i, 'filePdf'],
		[/\.(zip|jar|gz|tgz|tar|mrpack|7z)$/i, 'fileBinary']
	];

	function fileIcon(name: string): string {
		return FILE_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? 'file';
	}

	/** Which picture the full-screen viewer shows; null while it is closed */
	let viewing: number | null = $state(null);
	const redacted = $derived(item.output === '#redacted');

	const children = $derived(
		helper
			? items.filter((entry): entry is ToolItem => entry.kind === 'tool' && entry.parent === item.id)
			: []
	);

	/** What the helper was asked, out of its launch input. */
	const brief = $derived.by(() => {
		const input = (item.input ?? {}) as { subagent_type?: string; description?: string };

		return {
			type: input.subagent_type || 'general-purpose',
			description: input.description ?? ''
		};
	});

	function title(): string {
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

	function statusIcon(): string {
		switch (item.status) {
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

	async function decide(allow: boolean, always = false): Promise<void> {
		deciding = true;

		try {
			await session.decide(item.id, allow, item.name, {
				...(always ? { always: true } : {}),
				...(!allow && reason.trim() ? { reason: reason.trim() } : {})
			});
		} finally {
			deciding = false;
		}
	}
</script>

{#if todos}
	<div class="todo-line">
		<Icon name="listCheck" size="0.75rem" />
		<span>
			{t('web.agent.todoUpdated', {
				done: todos.filter((todo) => todo.status === 'completed').length,
				total: todos.length
			})}
		</span>
	</div>
{:else}
	<div class="call" class:nested class:helper data-status={item.status} class:processing={item.status === 'running'}>
		<button
			class="row"
			use:tooltip={{ content: t('web.agent.details') }} aria-label={t('web.agent.details')}
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		>
			<span class="icon" use:tooltip={{ content: title() }} aria-label={title()}>
				{#if item.status === 'running'}
					<Spinner size="0.75rem" color="#fff" />
				{:else if helper && item.status === 'ok'}
					<Icon name="wandMagicSparkles" style="solid" size="0.625rem" />
				{:else}
					<Icon name={statusIcon()} style="solid" size="0.625rem" />
				{/if}
			</span>
			{#if helper}
				<span class="name">{brief.type}</span>
				<span class="args">{brief.description}</span>
			{:else}
				<code class="name">{item.name}</code>
				<span class="args">{item.input === undefined && redacted ? t('web.agent.redactedShort') : argsPreview(item.input)}</span>
			{/if}
			<span class="caret">
				<Icon name={expanded ? 'arrowUp' : 'arrowDown'} size="0.625rem" />
			</span>
		</button>

		{#if helper && (item.status === 'running' || children.length)}
			<div class="helper-meta">
				{#if item.progress}
					<span>
						{t('web.agent.helperProgress', {
							tools: item.progress.tools,
							time: fmtDuration(item.progress.ms)
						})}
					</span>
					{#if item.progress.last && item.status === 'running'}
						<code>{item.progress.last}</code>
					{/if}
				{:else if item.status === 'running'}
					<span>{t('web.agent.helperStarting')}</span>
				{:else}
					<span>{t('web.agent.helperCalls', { count: children.length })}</span>
				{/if}
			</div>
		{/if}

		{#if helper && children.length && (expanded || item.status === 'running' || children.some((child) => child.status === 'awaiting'))}
			<div class="children">
				{#each children as child (child.id)}
					<AgentToolCard item={child} {session} {items} nested />
				{/each}
			</div>
		{/if}

		{#if item.status === 'awaiting'}
			<div class="ask">
				{#if mine}
					<p>{t('web.agent.approveLead')}</p>
					{#if item.input !== undefined && pretty(item.input) !== '{}'}
						<pre>{pretty(item.input)}</pre>
					{/if}
					<input
						class="input reason"
						type="text"
						maxlength="500"
						placeholder={t('web.agent.denyReason')}
						bind:value={reason}
						onkeydown={(event) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								void decide(false);
							}
						}}
					/>
					<div class="btns">
						<Btn variant="primary" icon="check" loading={deciding} onclick={() => decide(true)}>
							{t('web.agent.approve')}
						</Btn>
						<Btn icon="checkDouble" disabled={deciding} title={t('web.agent.approveAlwaysHint')} onclick={() => decide(true, true)}>
							{t('web.agent.approveAlways')}
						</Btn>
						<Btn icon="ban" disabled={deciding} onclick={() => decide(false)}>
							{t('web.agent.deny')}
						</Btn>
					</div>
				{:else}
					<p class="dim">{t('web.agent.waitingFor', { name: item.actor ?? session.actor ?? '' })}</p>
				{/if}
			</div>
		{:else if expanded}
			<div class="detail">
				{#if item.input !== undefined && !helper}
					<span class="lbl">{t('web.agent.input')}</span>
					<pre>{pretty(item.input)}</pre>
				{/if}
				{#if helper && (item.input as { prompt?: string } | undefined)?.prompt}
					<span class="lbl">{t('web.agent.helperBrief')}</span>
					<pre>{(item.input as { prompt: string }).prompt}</pre>
				{/if}
				{#if redacted}
					<p class="dim">{t('web.agent.redacted')}</p>
				{:else if item.output && helper}
					<span class="lbl">{t('web.agent.helperReport')}</span>
					<div class="report md">{@html renderMarkdown(item.output, { copyLabel: t('web.agent.copyCode') })}</div>
				{:else if item.output}
					<span class="lbl">{t('web.agent.output')}</span>
					<pre>{item.output}</pre>
				{/if}
				{#if item.decidedBy && !['timeout', 'stopped', 'plan'].includes(item.decidedBy)}
					<span class="lbl">{t('web.agent.decidedBy', { name: item.decidedBy })}</span>
				{/if}
			</div>
		{/if}
	</div>

	{#if shots.length}
		<div class="shots" class:nested>
			{#each shots as shot, index (shot.src)}
				<button class="shot" type="button" use:tooltip={{ content: t('web.agent.openImage') }} aria-label={t('web.agent.openImage')} onclick={() => (viewing = index)}>
					<img src={shot.src} alt={shot.alt} loading="lazy" />
				</button>
			{/each}
		</div>
		<ImageViewer images={shots} bind:index={viewing} />
	{/if}

	{#if downloads.length}
		<div class="files" class:nested>
			{#each downloads as file (file.id)}
				<a class="filecard" href={file.href} download={file.name} use:tooltip={{ content: t('web.agent.downloadFile', { name: file.name }) }}>
					<span class="ficon"><Icon name={fileIcon(file.name)} size="1.25rem" /></span>
					<span class="fmeta">
						<span class="fname">{file.name}</span>
						<span class="fsize">
							{fmtBytes(file.size)}
							{#if file.instance}
								· {t('web.agent.fileOnInstance', { instance: file.instance })}
							{/if}
						</span>
					</span>
					<span class="fget"><Icon name="arrowDownToLine" size="0.875rem" style="solid" /></span>
				</a>
			{/each}
		</div>
	{/if}
{/if}

<style lang="scss">
	// a file the agent handed over: a card of its own in the chat, shaped like a
	// bubble, the whole card being the download
	.files {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.25rem;
		margin-top: 0.25rem;

		&.nested {
			padding: 0 0.75rem 0.5rem;
		}
	}

	.filecard {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-width: 15rem;
		max-width: min(100%, 24rem);
		padding: 0.5rem 0.75rem 0.5rem 0.5rem;
		border: 0.1rem solid color-mix(in srgb, var(--luna-primary) 45%, var(--bg-panel));
		border-radius: 0.25rem 0.75rem 0.75rem 0.25rem;
		background: color-mix(in srgb, var(--luna-primary) 18%, var(--bg-panel));
		color: var(--text-heading);
		text-decoration: none;

		:global(.msg.bot) > .files:not(:has(~ :not(:global(.foot), :global(.thinking)))) &:last-child {
			border-bottom-left-radius: 0.75rem;
		}

		&:hover {
			border-color: var(--link);

			.fget {
				background: var(--link);
				color: var(--bg-panel);
			}
		}

		&:focus-visible {
			@include focus-ring;
		}
	}

	.ficon {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--luna-primary) 35%, var(--bg-panel));
		color: #fff;
	}

	.fmeta {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}

	.fname {
		@include ellipsis;

		font-weight: 700;
		font-size: 0.875rem;
	}

	.fsize {
		@include ellipsis;

		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.fget {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 50%;
		background: var(--bg-hover);
		color: var(--link);
		transition: background 0.12s, color 0.12s;
	}

	// what the model was shown, as an image message of its own: thumbnails in the
	// chat, the picture itself in the full-screen viewer
	.shots {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		margin-top: 0.25rem;

		&.nested {
			padding: 0 0.75rem 0.5rem;
		}
	}

	.shot {
		@include bare-button;

		display: block;
		width: 7.5rem;
		height: 7.5rem;
		border: 0.1rem solid var(--border-input);

		// a bubble's shape: the tight corners on the agent's side, rounded out at
		// the bottom when the pictures end the message, as AgentChat's .bubble does
		border-radius: 0.25rem 0.75rem 0.75rem 0.25rem;
		overflow: hidden;

		:global(.msg.bot) > .shots:not(:has(~ :not(:global(.foot), :global(.thinking)))) & {
			border-bottom-left-radius: 0.75rem;
		}
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

	.todo-line {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.125rem 0.25rem;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.call {
		position: relative;
		display: flex;
		flex-direction: column;
		width: 90%;
		// one border all round, shaped like the chat bubbles: tight corners on the
		// agent's side between items, rounded out at the bottom when the call ends
		// the turn. The status icon carries the state; a call that needs someone
		// (awaiting) or went wrong tints the whole border.
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.25rem 0.75rem 0.75rem 0.25rem;
		background: var(--bg-panel-raised);
		overflow: hidden;

		:global(.msg.bot) > &:not(.nested):not(:has(~ :not(:global(.foot), :global(.thinking)))) {
			border-bottom-left-radius: 0.75rem;
		}

		// a helper's own calls sit inside its card, flatter and full width,
		// parted by a rule
		&.nested {
			width: 100%;
			border-width: 0.1rem 0 0;
			border-radius: 0;
			background: none;
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

		&.helper .args {
			font-family: inherit;
		}

		.caret {
			display: grid;
			place-items: center;
			flex: none;
			width: 1rem;
		}

		.helper-meta {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			padding: 0 0.5rem 0.25rem 2.25rem;
			font-size: 0.75rem;
			color: var(--text-secondary);

			code {
				@include ellipsis;

				font-family: var(--font-mono);
				color: var(--text-label);
			}
		}

		.children {
			display: flex;
			flex-direction: column;
			gap: 0.125rem;
			margin: 0 0.5rem 0.375rem 1.5rem;
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

			&.dim {
				margin: 0;
				color: var(--text-secondary);
			}
		}

		.reason {
			width: 100%;
			margin-bottom: 0.5rem;
		}

		.detail {
			.lbl {
				display: block;
				margin-bottom: 0.25rem;
				color: var(--text-label);
				font-size: 0.75rem;
			}

			.dim {
				margin: 0 0 0.5rem;
				color: var(--text-secondary);
			}
		}

		.report {
			margin-bottom: 0.5rem;
			padding: 0.5rem 0.75rem;
			border: 0.1rem solid var(--border-divider);
			border-radius: 0.375rem;
			background: var(--bg-panel);
			font-size: 0.8125rem;
			line-height: 1.5;
			max-height: 24rem;
			overflow: auto;

			:global(p),
			:global(ul),
			:global(ol) {
				margin: 0 0 0.5rem;
			}

			:global(ul),
			:global(ol) {
				padding-left: 1.25rem;
			}

			:global(code) {
				font-family: var(--font-mono);
				font-size: 0.75rem;
			}

			:global(pre) {
				white-space: pre-wrap;
			}
		}

		.btns {
			display: flex;
			flex-wrap: wrap;
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
			.icon {
				background: var(--success);
			}
		}

		&.helper[data-status='ok'] {
			.icon {
				background: var(--src-luna);
			}
		}

		&[data-status='awaiting']:not(.nested) {
			border-color: var(--warning);
		}

		&[data-status='awaiting'] {
			.icon {
				background: var(--warning);
				color: var(--primary-text);
			}
		}

		&[data-status='denied']:not(.nested),
		&[data-status='error']:not(.nested) {
			border-color: color-mix(in srgb, var(--error) 70%, var(--border-divider));
		}

		&[data-status='denied'],
		&[data-status='error'] {
			.icon {
				background: var(--error);
				color: var(--primary-text);
			}
		}
	}

	@keyframes sweep {
		from {
			transform: translateX(0);
		}

		to {
			transform: translateX(48rem);
		}
	}
</style>
