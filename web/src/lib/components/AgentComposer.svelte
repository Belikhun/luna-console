<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { tick } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { Agent, type ChatSession } from '$lib/agent.svelte';
	import { AGENT_MODES, type AgentMode } from '$shared/agent';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import ConfirmModal from './ConfirmModal.svelte';
	import type { ContextMenuItem } from './contextmenu';

	/**
	 * Mèo Béo's message box: the text on top, the controls in a bar beneath it.
	 * Left to right: the add menu, skills, the model and effort for this browser,
	 * the page going along as context, then the approval mode and send.
	 *
	 * Shift+Tab cycles the mode from the text box. Bypass asks once per page load
	 * before it is picked, since from then on calls run without a prompt.
	 *
	 * Nothing here waits for the agent to finish: a message typed mid-answer
	 * joins the run, and a new mode, model or effort applies to it from its next
	 * step, the way Claude Code takes them.
	 */
	let { session, onsent }: { session: ChatSession; onsent?: () => void } = $props();

	let draft = $state('');
	let textbox: HTMLTextAreaElement | undefined = $state();
	let addMenu: ContextMenu | undefined = $state();
	let addButton: HTMLButtonElement | undefined = $state();
	let skillMenu: ContextMenu | undefined = $state();
	let skillButton: HTMLButtonElement | undefined = $state();
	let popover: 'model' | 'mode' | null = $state(null);
	let filePicker: HTMLInputElement | undefined = $state();
	let dragging = $state(false);
	let confirmBypass = $state(false);

	/** bypass is confirmed once per page load, not on every switch */
	let bypassConfirmed = false;

	/** px; the box grows with its text up to this, then scrolls */
	const COMPOSER_MAX = 200;

	const MODE_ICONS: Record<AgentMode, string> = {
		manual: 'hand',
		auto: 'bolt',
		plan: 'listCheck',
		bypass: 'forwardFast'
	};

	const ready = $derived(Agent.state?.ready ?? false);
	const settings = $derived(Agent.state?.settings);
	// the agent's own screens are not a page worth describing to it; a popped-out
	// window in particular is only the chat, wherever the console itself is
	const pagePath = $derived(page.url.pathname.startsWith('/agent') ? '' : page.url.pathname);

	const modelValue = $derived(session.model || settings?.model || '');
	const effortValue = $derived(session.effort || settings?.effort || 'medium');
	const efforts = $derived(Agent.state?.efforts ?? []);

	const modelLabel = $derived.by(() => {
		const choice = Agent.state?.models.find((model) => model.value === modelValue);

		return choice?.label ?? modelValue;
	});

	const addItems: ContextMenuItem[] = $derived([
		{
			label: t('web.agentComposer.attach'),
			icon: 'paperclip',
			disabled: !ready,
			action: () => filePicker?.click()
		},
		{
			label: t('web.agentComposer.sharePage'),
			icon: session.sharePage ? 'check' : 'fileLines',
			action: () => session.setSharePage(!session.sharePage)
		},
		{ separator: true },
		{
			label: t('web.agent.newChat'),
			icon: 'messagePlus',
			disabled: session.items.length === 0,
			action: () => session.newChat()
		},
		{ label: t('web.agent.settings'), icon: 'gear', action: () => goto('/console/agent') }
	]);

	const skillItems: ContextMenuItem[] = $derived.by(() => {
		const skills = Agent.state?.skills ?? [];
		const rows: ContextMenuItem[] = [{ label: t('web.agentComposer.skills'), header: true }];

		if (skills.length === 0) {
			rows.push({ label: t('web.agentComposer.noSkills'), disabled: true });
		}

		for (const skill of skills) {
			rows.push({
				id: skill.name,
				label: `/${skill.name}`,
				hint: skill.description,
				action: () => insertSkill(skill.name)
			});
		}

		rows.push({ separator: true });
		rows.push({
			label: t('web.agentComposer.manageSkills'),
			icon: 'arrowUpRightFromSquare',
			action: () => goto('/console/knowledge?kind=skill')
		});

		return rows;
	});

	function grow(): void {
		if (!textbox) {
			return;
		}

		textbox.style.height = 'auto';
		textbox.style.height = `${Math.min(textbox.scrollHeight, COMPOSER_MAX)}px`;
	}

	async function insertSkill(name: string): Promise<void> {
		draft = `${t('web.agentComposer.useSkill', { name })} ${draft}`.trimEnd() + ' ';
		await tick();
		grow();
		textbox?.focus();
	}

	const uploading = $derived(session.attachments.some((file) => !file.id && !file.error));
	const attached = $derived(session.attachments.some((file) => file.id && !file.error));
	const canSend = $derived(ready && !session.sending && !uploading && (!!draft.trim() || attached));
	const sharingPage = $derived(session.sharePage && !!pagePath);

	function fmtSize(bytes: number): string {
		return bytes >= 1024 * 1024
			? `${(bytes / 1024 / 1024).toFixed(1)} MB`
			: `${Math.max(1, Math.round(bytes / 1024))} KB`;
	}

	function attachFiles(files: FileList | null | undefined): void {
		for (const file of files ?? []) {
			void session.attach(file);
		}
	}

	function onDrop(event: DragEvent): void {
		event.preventDefault();
		dragging = false;

		if (ready) {
			attachFiles(event.dataTransfer?.files);
		}
	}

	/** Send what is typed, or a suggestion handed in from the panel. */
	export async function send(text: string = draft): Promise<void> {
		const hasFiles = session.attachments.some((file) => file.id && !file.error);

		if ((!text.trim() && !hasFiles) || session.sending || !ready || uploading) {
			return;
		}

		if (text === draft) {
			draft = '';
		}

		await tick();
		grow();
		onsent?.();
		await session.send(text, pagePath || undefined);
		textbox?.focus();
	}

	function pickMode(mode: AgentMode): void {
		popover = null;

		if (mode === 'bypass' && !bypassConfirmed) {
			confirmBypass = true;

			return;
		}

		session.setMode(mode);
	}

	function onKey(event: KeyboardEvent): void {
		if (event.key === 'Tab' && event.shiftKey) {
			event.preventDefault();
			pickMode(session.nextMode());

			return;
		}

		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			void send();
		}
	}

	async function openMenu(menu: ContextMenu | undefined, anchor: HTMLElement | undefined, event: MouseEvent): Promise<void> {
		event.stopPropagation();
		popover = null;

		if (menu?.isOpen()) {
			menu.close();

			return;
		}

		if (anchor) {
			await menu?.openAtElement(anchor, 'top');
		}
	}

	function togglePopover(which: 'model' | 'mode', event: MouseEvent): void {
		event.stopPropagation();
		popover = popover === which
			? null
			: which;
	}

	function closePopover(event: PointerEvent): void {
		if (popover && !(event.target as HTMLElement).closest('.pop, .chip')) {
			popover = null;
		}
	}

	function shortPath(path: string): string {
		return path.length > 28
			? `…${path.slice(-27)}`
			: path;
	}
</script>

<svelte:window onpointerdown={closePopover} />

<form
	class="composer"
	class:bypass={session.mode === 'bypass'}
	class:plan={session.mode === 'plan'}
	class:dragging
	ondragover={(event) => {
		event.preventDefault();
		dragging = ready;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={onDrop}
	onsubmit={(event) => {
		event.preventDefault();
		void send();
	}}
>
	{#if popover === 'mode'}
		<div class="pop">
			<div class="pophead">
				<span>{t('web.agentComposer.modes')}</span>
				<span class="dim">{t('web.agentComposer.switchHint')}</span>
			</div>
			{#each AGENT_MODES as mode}
				{@const off = mode === 'bypass' && !settings?.bypassAllowed}
				<button
					type="button"
					class="opt {mode}"
					class:on={session.mode === mode}
					disabled={off}
					title={off ? t('web.agentComposer.bypassOff') : undefined}
					onclick={() => pickMode(mode)}
				>
					<span class="oi"><Icon name={MODE_ICONS[mode]} size="0.875rem" /></span>
					<span class="ot">
						<b>{t(`web.agentComposer.mode_${mode}`)}</b>
						<span>{off ? t('web.agentComposer.bypassOff') : t(`web.agentComposer.modeHint_${mode}`)}</span>
					</span>
					{#if session.mode === mode}<Icon name="check" size="0.75rem" />{/if}
				</button>
			{/each}
		</div>
	{:else if popover === 'model'}
		<div class="pop">
			<div class="pophead"><span>{t('web.agentComposer.model')}</span></div>
			<div class="models">
				{#each Agent.state?.models ?? [] as choice}
					<button
						type="button"
						class="opt"
						class:on={modelValue === choice.value}
						onclick={() => session.setModel(choice.value === settings?.model ? '' : choice.value)}
					>
						<span class="ot">
							<b>{choice.label}</b>
							{#if choice.description}<span>{choice.description}</span>{/if}
						</span>
						{#if modelValue === choice.value}<Icon name="check" size="0.75rem" />{/if}
					</button>
				{/each}
			</div>
			<div class="effort">
				<span class="el"><Icon name="brain" size="0.875rem" /> {t('web.agentComposer.effort')}
					<span class="dim">({t(`web.agentSettings.effort_${effortValue}`)})</span></span>
				<span class="dots" role="radiogroup" aria-label={t('web.agentComposer.effort')}>
					{#each efforts as level, index}
						<button
							type="button"
							role="radio"
							aria-checked={effortValue === level}
							aria-label={t(`web.agentSettings.effort_${level}`)}
							class="dot"
							class:filled={efforts.indexOf(effortValue) >= index}
							onclick={() => session.setEffort(level === settings?.effort ? '' : level)}
						></button>
					{/each}
				</span>
			</div>
		</div>
	{/if}

	{#if session.attachments.length}
		<div class="files">
			{#each session.attachments as file}
				<span class="filechip" class:bad={!!file.error} title={file.error ?? file.name}>
					{#if !file.id && !file.error}
						<Spinner size="0.75rem" />
					{:else}
						<Icon name={file.error ? 'triangleExclamation' : 'paperclip'} size="0.75rem" />
					{/if}
					<span class="lbl">{file.name}</span>
					<span class="dim">{file.error ? t('web.agentComposer.uploadFailed') : fmtSize(file.size)}</span>
					<button type="button" class="x" title={t('web.agentComposer.detach')} onclick={() => session.detach(file)}>
						<Icon name="close" size="0.625rem" />
					</button>
				</span>
			{/each}
		</div>
	{/if}

	<input
		class="picker"
		type="file"
		multiple
		bind:this={filePicker}
		onchange={(event) => {
			attachFiles(event.currentTarget.files);
			event.currentTarget.value = '';
		}}
	/>

	<textarea
		class="textbox"
		rows="1"
		placeholder={!ready
			? t('web.agent.placeholderOff')
			: session.running
				? t('web.agentComposer.placeholderBusy')
				: t('web.agent.placeholder')}
		disabled={!ready}
		bind:this={textbox}
		bind:value={draft}
		oninput={grow}
		onkeydown={onKey}
	></textarea>

	<div class="bar">
		<button
			type="button"
			class="ico"
			title={t('web.agentComposer.add')}
			bind:this={addButton}
			onpointerdown={(event) => event.stopPropagation()}
			onclick={(event) => openMenu(addMenu, addButton, event)}
		>
			<Icon name="plus" size="0.875rem" />
		</button>
		<button
			type="button"
			class="ico slash"
			title={t('web.agentComposer.skills')}
			bind:this={skillButton}
			onpointerdown={(event) => event.stopPropagation()}
			onclick={(event) => openMenu(skillMenu, skillButton, event)}
		>/</button>

		<button type="button" class="chip" class:active={popover === 'model'} onclick={(event) => togglePopover('model', event)}>
			<span class="lbl">{modelLabel}</span>
			<span class="dim">{t(`web.agentSettings.effort_${effortValue}`)}</span>
		</button>

		{#if sharingPage}
			<span class="chip file" title={t('web.agentComposer.sharedPage', { page: pagePath })}>
				<Icon name="fileLines" size="0.75rem" />
				<span class="lbl">{shortPath(pagePath)}</span>
				<button type="button" class="x" title={t('web.agentComposer.unsharePage')} onclick={() => session.setSharePage(false)}>
					<Icon name="close" size="0.625rem" />
				</button>
			</span>
		{/if}

		<span class="spacer"></span>

		<button
			type="button"
			class="chip mode {session.mode}"
			class:active={popover === 'mode'}
			title={t('web.agentComposer.modeTitle')}
			onclick={(event) => togglePopover('mode', event)}
		>
			<Icon name={MODE_ICONS[session.mode]} size="0.75rem" />
			<span class="lbl">{t(`web.agentComposer.mode_${session.mode}`)}</span>
		</button>

		{#if session.running}
			<button class="send stop" type="button" title={t('web.agent.stop')} onclick={() => session.stop()}>
				<Icon name="stop" size="0.75rem" />
			</button>
		{/if}
		{#if !session.running || canSend || session.sending}
			<button
				class="send"
				type="submit"
				title={session.running ? t('web.agentComposer.sendMidRun') : t('web.agent.send')}
				disabled={!canSend}
			>
				{#if session.sending}
					<Spinner size="0.75rem" />
				{:else}
					<Icon name="paperPlaneTop" size="0.75rem" />
				{/if}
			</button>
		{/if}
	</div>
</form>

<ContextMenu bind:this={addMenu} items={addItems} minWidth="15rem" />
<ContextMenu bind:this={skillMenu} items={skillItems} minWidth="15rem" />

<ConfirmModal
	bind:open={confirmBypass}
	title={t('web.agentComposer.bypassTitle')}
	lead={t('web.agentComposer.bypassLead')}
	notes={[t('web.agentComposer.bypassNote')]}
	confirmLabel={t('web.agentComposer.bypassConfirm')}
	onconfirm={() => {
		bypassConfirmed = true;
		confirmBypass = false;
		session.setMode('bypass');
	}}
/>

<style lang="scss">
	.composer {
		position: relative;
		margin: 0.75rem 1rem 1rem;
		border: 0.1rem solid var(--border-input);
		border-radius: 0.75rem;
		background: var(--bg-input);
		flex: none;

		&:focus-within {
			border-color: var(--link);
		}

		// the box itself says calls run unasked, so nobody types into bypass by accident
		&.bypass,
		&.bypass:focus-within {
			border-color: var(--error);
		}

		&.plan:focus-within {
			border-color: var(--warning);
		}

		&.dragging {
			border-style: dashed;
			border-color: var(--link);
		}
	}

	.picker {
		display: none;
	}

	.files {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		padding: 0.625rem 0.75rem 0;
	}

	.filechip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		max-width: 100%;
		height: 1.75rem;
		padding: 0 0.25rem 0 0.5rem;
		border: 0.1rem solid var(--border-input);
		border-radius: 0.375rem;
		background: var(--bg-panel-raised);
		font-size: 0.75rem;
		color: var(--text-heading);

		.lbl {
			@include ellipsis;
		}

		.dim {
			color: var(--text-secondary);
			flex: none;
		}

		&.bad {
			border-color: var(--error);
			color: var(--error);
		}
	}

	.textbox {
		display: block;
		width: 100%;
		min-height: 2.75rem;
		padding: 0.75rem 0.875rem 0.25rem;
		border: none;
		background: transparent;
		color: var(--text-heading);
		font-family: inherit;
		font-size: 0.875rem;
		line-height: 1.5rem;
		resize: none;
		outline: none;

		&:disabled {
			opacity: 0.6;
		}
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem 0.5rem;
		min-width: 0;
	}

	.spacer {
		flex: 1;
	}

	.ico {
		@include bare-button;

		display: inline-grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		color: var(--text);
		flex: none;

		&:hover {
			background: var(--bg-hover);
			color: var(--link);
		}

		&.slash {
			width: 1.375rem;
			height: 1.375rem;
			border: 0.1rem solid currentColor;
			border-radius: 0.25rem;
			font-size: 0.75rem;
			font-weight: 700;
			line-height: 1;
		}
	}

	.chip {
		@include bare-button;

		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		height: 1.625rem;
		padding: 0 0.625rem;
		border-radius: 0.375rem;
		background: var(--bg-hover);
		color: var(--text-heading);
		font-size: 0.75rem;
		min-width: 0;

		.lbl {
			@include ellipsis;
		}

		.dim {
			color: var(--text-secondary);
		}

		&:hover,
		&.active {
			background: var(--bg-selected);
			color: var(--link);
		}

		&.file {
			background: none;
			color: var(--text);
			padding: 0 0.25rem;
			flex-shrink: 1;
		}

		&.mode {
			background: none;
			flex: none;

			&.auto {
				color: var(--link);
			}

			&.plan {
				color: var(--warning);
			}

			&.bypass {
				color: var(--error);
			}

			&:hover,
			&.active {
				background: var(--bg-hover);
			}
		}
	}

	.x {
		@include bare-button;

		display: inline-grid;
		place-items: center;
		width: 1rem;
		height: 1rem;
		border-radius: 0.25rem;
		color: var(--text-secondary);

		&:hover {
			color: var(--error);
		}
	}

	.send {
		@include bare-button;

		display: grid;
		place-items: center;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		background: var(--luna-primary);
		color: #fff;
		flex: none;

		&:hover:not(:disabled) {
			filter: brightness(1.15);
		}

		&:disabled {
			background: var(--bg-hover);
			color: var(--text-disabled);
			cursor: default;
		}

		&.stop {
			background: var(--error);
			color: var(--primary-text);
		}
	}

	// the mode and model pickers open upward from the bar, over the conversation
	.pop {
		position: absolute;
		left: 0;
		right: 0;
		bottom: calc(100% + 0.5rem);
		z-index: 5;
		display: flex;
		flex-direction: column;
		padding: 0.375rem;
		border: 0.1rem solid var(--border-input);
		border-radius: 0.75rem;
		background: var(--bg-dropdown);
		box-shadow: var(--shadow-dropdown);
	}

	.pophead {
		display: flex;
		justify-content: space-between;
		padding: 0.375rem 0.5rem;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.models {
		max-height: 16rem;
		overflow-y: auto;
	}

	.opt {
		@include bare-button;

		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.5rem;
		border-radius: 0.5rem;
		color: var(--text-heading);
		text-align: left;

		&:hover:not(:disabled) {
			background: var(--bg-hover);
		}

		&.on {
			background: var(--bg-selected);
		}

		&:disabled {
			opacity: 0.5;
			cursor: default;
		}

		&.bypass .oi {
			color: var(--error);
		}

		&.plan .oi {
			color: var(--warning);
		}

		&.auto .oi {
			color: var(--link);
		}
	}

	.oi {
		display: inline-grid;
		place-items: center;
		width: 1.25rem;
		flex: none;
		color: var(--text);
	}

	.ot {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		font-size: 0.8125rem;

		span {
			color: var(--text-secondary);
			font-size: 0.75rem;
		}
	}

	.effort {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-top: 0.25rem;
		padding: 0.625rem 0.5rem 0.375rem;
		border-top: 0.1rem solid var(--border-divider);
		font-size: 0.8125rem;

		.el {
			display: inline-flex;
			align-items: center;
			gap: 0.5rem;
		}
	}

	.dots {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.25rem 0.375rem;
		border-radius: 1rem;
		background: var(--bg-input);
	}

	.dot {
		@include bare-button;

		width: 0.75rem;
		height: 0.75rem;
		border-radius: 50%;
		background: var(--bg-hover);

		&.filled {
			background: var(--link);
		}

		&:hover {
			outline: 0.1rem solid var(--link);
		}
	}
</style>
