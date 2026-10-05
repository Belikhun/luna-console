<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	/**
	 * A question Mèo Béo asked the operator (the SDK's `AskUserQuestion`): one to
	 * four questions, each with two to four options and an "Other" line for a
	 * typed answer.
	 *
	 * It is drawn twice. `docked` is the one the operator answers, sitting above
	 * the composer and stepping through the questions one at a time, radios for a
	 * one-answer question and checkboxes for a multi-select one. The copy in the
	 * chat stream is the record: while it waits it only points at the dock, and
	 * once answered it lists each question with what was picked.
	 *
	 * Answers are keyed by question text and multi-select picks are joined with
	 * ", ", which is the shape the SDK's tool reads them in.
	 */
	import Btn from './Btn.svelte';
	import Checkbox from './Checkbox.svelte';
	import Icon from './Icon.svelte';
	import { t } from '$lib/i18n.svelte';
	import type { AgentQuestion, AgentQuestionState } from './agentquestion';

	let {
		questions,
		answers,
		phase,
		docked = false,
		busy = false,
		onanswer,
		ondismiss
	}: {
		questions: AgentQuestion[];
		/** The picks, once answered */
		answers?: Record<string, string>;
		phase: AgentQuestionState;
		/** The interactive copy above the composer, rather than the record in the stream */
		docked?: boolean;
		busy?: boolean;
		onanswer?: (answers: Record<string, string>) => void;
		ondismiss?: () => void;
	} = $props();

	/** The question on screen in the dock */
	let step = $state(0);

	/** Picked option labels per question index */
	let picked = $state<Record<number, string[]>>({});

	/** Whether "Other" is ticked, and its text, per question index */
	let otherOn = $state<Record<number, boolean>>({});
	let otherText = $state<Record<number, string>>({});

	const current = $derived(questions[step]);
	const last = $derived(step >= questions.length - 1);

	function toggle(index: number, label: string, multi: boolean): void {
		const now = picked[index] ?? [];

		if (!multi) {
			picked[index] = [label];
			otherOn[index] = false;

			return;
		}

		picked[index] = now.includes(label)
			? now.filter((entry: string) => entry !== label)
			: [...now, label];
	}

	function toggleOther(index: number, multi: boolean): void {
		const on = !otherOn[index];

		otherOn[index] = on;

		if (on && !multi) {
			picked[index] = [];
		}
	}

	function answerOf(index: number): string {
		const parts = [...(picked[index] ?? [])];
		const typed = otherText[index]?.trim();

		if (otherOn[index] && typed) {
			parts.push(typed);
		}

		return parts.join(', ');
	}

	const stepDone = $derived(answerOf(step) !== '');

	function advance(): void {
		if (!stepDone) {
			return;
		}

		if (!last) {
			step += 1;

			return;
		}

		const result: Record<string, string> = {};

		questions.forEach((question, index) => {
			result[question.question] = answerOf(index);
		});

		onanswer?.(result);
	}

	function phaseTitle(): string {
		switch (phase) {
			case 'waiting':
				return t('web.agent.question.asking');

			case 'answered':
				return t('web.agent.question.answered');

			case 'timeout':
				return t('web.agent.question.timedOut');

			default:
				return t('web.agent.question.dismissed');
		}
	}
</script>

{#if docked}
	{#if current}
		<div class="question docked">
			<div class="head">
				<span class="icon"><Icon name="circleQuestion" style="solid" size="0.75rem" /></span>
				<span class="title">{t('web.agent.question.asking')}</span>
				{#if questions.length > 1}
					<span class="step">{t('web.agent.question.step', { n: step + 1, total: questions.length })}</span>
				{/if}
			</div>

			{#if questions.length > 1}
				<div class="progress" aria-hidden="true">
					{#each questions as _, index (index)}
						<span class="seg" class:done={index < step} class:now={index === step}></span>
					{/each}
				</div>
			{/if}

			<div class="prompt">
				{#if questions.length > 1}
					<span class="num">{step + 1}</span>
				{/if}
				{#if current.header}
					<span class="chip">{current.header}</span>
				{/if}
				<span class="text">{current.question}</span>
			</div>

			<div class="options" role={current.multiSelect ? 'group' : 'radiogroup'}>
				{#each current.options as option (option.label)}
					<label class="option" class:on={(picked[step] ?? []).includes(option.label)}>
						<Checkbox
							shape={current.multiSelect ? 'check' : 'radio'}
							checked={(picked[step] ?? []).includes(option.label)}
							disabled={busy}
							onchange={() => toggle(step, option.label, current.multiSelect)}
						/>
						<span class="body">
							<span class="label">{option.label}</span>
							{#if option.description}
								<span class="desc">{option.description}</span>
							{/if}
						</span>
					</label>
				{/each}

				<label class="option" class:on={otherOn[step]}>
					<Checkbox
						shape={current.multiSelect ? 'check' : 'radio'}
						checked={!!otherOn[step]}
						disabled={busy}
						onchange={() => toggleOther(step, current.multiSelect)}
					/>
					<span class="body">
						<span class="label">{t('web.agent.question.other')}</span>
					</span>
				</label>

				{#if otherOn[step]}
					<input
						class="input"
						placeholder={t('web.agent.question.otherPlaceholder')}
						disabled={busy}
						bind:value={otherText[step]}
						onkeydown={(event) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								advance();
							}
						}}
					/>
				{/if}
			</div>

			<div class="btns">
				<Btn variant="primary" icon={last ? 'paperPlane' : undefined} loading={busy} disabled={!stepDone} onclick={advance}>
					{last
						? t('web.agent.question.submit')
						: t('web.agent.question.next')}
				</Btn>
				{#if step > 0}
					<Btn disabled={busy} onclick={() => (step -= 1)}>{t('web.agent.question.back')}</Btn>
				{/if}
				<span class="spacer"></span>
				<Btn variant="link" disabled={busy} onclick={() => ondismiss?.()}>{t('web.agent.question.dismiss')}</Btn>
			</div>
		</div>
	{/if}
{:else}
	<div class="question record" data-phase={phase}>
		<div class="head">
			<span class="icon"><Icon name="circleQuestion" style="solid" size="0.625rem" /></span>
			<span class="title">{phaseTitle()}</span>
		</div>

		{#each questions as question, index (index)}
			<div class="pair">
				{#if questions.length > 1}
					<span class="num">{index + 1}</span>
				{/if}
				<span class="text">{question.question}</span>
				{#if answers?.[question.question]}
					<span class="answer">
						<Icon name="check" style="solid" size="0.625rem" />
						{answers[question.question]}
					</span>
				{/if}
			</div>
		{/each}

		{#if phase === 'waiting'}
			<span class="hint">{t('web.agent.question.waitingInline')}</span>
		{/if}
	</div>
{/if}

<style lang="scss">
	.question {
		display: flex;
		flex-direction: column;
		border: 0.1rem solid var(--border-divider);
		border-left: 0.25rem solid var(--warning);
		background: var(--bg-panel-raised);

		.icon {
			display: grid;
			place-items: center;
			flex: none;
			border-radius: 0.25rem;
			background: var(--warning);
			color: var(--primary-text);
		}
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;

		.title {
			font-size: 0.75rem;
			font-weight: 600;
			color: var(--text-label);
		}

		.step {
			margin-left: auto;
			font-size: 0.75rem;
			color: var(--text-secondary);
		}
	}

	.docked {
		gap: 0.5rem;
		padding: 0.5rem 0.625rem 0.625rem;
		border-radius: 0.5rem;

		.icon {
			width: 1.25rem;
			height: 1.25rem;
		}
	}

	.record {
		gap: 0.25rem;
		width: 90%;
		padding: 0.25rem 0.5rem 0.375rem;
		border-radius: 0.25rem 0.75rem 0.75rem 0.25rem;
		font-size: 0.8125rem;

		.icon {
			width: 1rem;
			height: 1rem;
		}

		&[data-phase='answered'] {
			border-left-color: var(--success);

			.icon {
				background: var(--success);
			}
		}

		&[data-phase='dismissed'],
		&[data-phase='timeout'] {
			border-left-color: var(--border-input);

			.icon {
				background: var(--text-label);
			}
		}

		.pair {
			display: grid;
			grid-template-columns: auto 1fr;
			column-gap: 0.375rem;
			padding-left: 1.5rem;

			// without a number the text and the answer take the whole row
			> :not(.num) {
				grid-column: 2;
			}

			.num {
				grid-row: span 2;
				margin-top: 0.125rem;
			}
		}

		.pair:not(:has(.num)) {
			grid-template-columns: 1fr;

			> * {
				grid-column: 1;
			}
		}

		.text {
			color: var(--text);
		}

		.answer {
			display: flex;
			align-items: baseline;
			gap: 0.375rem;
			color: var(--text-heading);
			font-weight: 600;

			:global(icon) {
				color: var(--success);
			}
		}

		.hint {
			padding-left: 1.5rem;
			color: var(--text-secondary);
			font-size: 0.75rem;
		}
	}

	.num {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 50%;
		background: var(--luna-primary);
		color: #fff;
		font-size: 0.75rem;
		font-weight: 700;
		line-height: 1;
	}

	.progress {
		display: flex;
		gap: 0.25rem;

		.seg {
			flex: 1;
			height: 0.25rem;
			border-radius: 0.125rem;
			background: var(--border-divider);

			&.done {
				background: var(--success);
			}

			&.now {
				background: var(--luna-primary);
			}
		}
	}

	.prompt {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.375rem;

		.chip {
			padding: 0 0.375rem;
			border-radius: 0.25rem;
			background: var(--bg-hover);
			color: var(--text-secondary);
			font-size: 0.75rem;
			font-weight: 600;
		}

		.text {
			color: var(--text-heading);
			font-size: 0.875rem;
		}
	}

	.options {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		max-height: 40vh;
		overflow-y: auto;
	}

	.option {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.375rem 0.5rem;
		border: 0.1rem solid var(--border-divider);
		border-radius: 0.375rem;
		cursor: pointer;

		&:hover {
			background: var(--bg-hover);
		}

		&.on {
			border-color: var(--link);
		}

		// the box sits on the label's first line, not the middle of a two-line option
		:global(> :first-child) {
			margin-top: 0.125rem;
		}

		.body {
			display: flex;
			flex-direction: column;
			min-width: 0;
		}

		.label {
			color: var(--text);
			font-size: 0.875rem;
		}

		.desc {
			color: var(--text-secondary);
			font-size: 0.75rem;
		}
	}

	.btns {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;

		.spacer {
			flex: 1;
		}
	}
</style>
