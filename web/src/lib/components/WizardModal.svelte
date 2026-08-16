<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import Btn from './Btn.svelte';
	import Icon from './Icon.svelte';
	import Modal from './Modal.svelte';
	import type { WizardStep } from './wizardmodal';

	/**
	 * A stepped dialog: a numbered rail, one step's body at a time, and a
	 * Back/Next/Confirm footer.
	 *
	 * Distinct from `Wizard.svelte`, which is a whole-page shell - it renders a
	 * document title, a `PageHeader` and a sticky bar positioned against the page
	 * scroll, and it has no steps at all. A popup that walks somebody through
	 * checking something before they commit to it is a different object, and it
	 * lives here so the next one does not get hand-rolled inside a page.
	 */
	let {
		open = $bindable(false),
		step = $bindable(0),
		title,
		steps,
		confirmLabel,
		busy = false,
		dismissable = true,
		onconfirm,
		oncancel,
		children,
		aside
	}: {
		open?: boolean;
		/** Index into `steps`; bindable so a caller can jump back on an error */
		step?: number;
		title: string;
		steps: WizardStep[];
		/** The final button's label; the verb, not "Finish" */
		confirmLabel: string;
		/** Work is in flight: the footer locks and the dialog stops dismissing */
		busy?: boolean;
		dismissable?: boolean;
		onconfirm: () => void | Promise<void>;
		oncancel?: () => void;
		/** The active step's body */
		children: Snippet<[WizardStep]>;
		/** A recap that stays put while the steps change under it */
		aside?: Snippet;
	} = $props();

	const current = $derived(steps[Math.min(step, steps.length - 1)]);
	const last = $derived(step >= steps.length - 1);
	const blocked = $derived(current?.blocked ?? '');

	function back(): void {
		step = Math.max(0, step - 1);
	}

	function next(): void {
		if (blocked) {
			return;
		}

		if (!last) {
			step = Math.min(steps.length - 1, step + 1);

			return;
		}

		void onconfirm();
	}

	/**
	 * A step is reachable by clicking the rail only if it has already been seen.
	 * Jumping forward would skip the checks the intervening steps exist to make.
	 */
	function jump(index: number): void {
		if (index <= step && !busy) {
			step = index;
		}
	}

	function cancel(): void {
		open = false;
		oncancel?.();
	}
</script>

<Modal {title} bind:open wide dismissable={dismissable && !busy}>
	<div class="wiz">
		<ol class="rail">
			{#each steps as entry, index (entry.id)}
				<li>
					<button
						class="rstep"
						class:done={index < step}
						class:active={index === step}
						disabled={index > step || busy}
						onclick={() => jump(index)}
					>
						<span class="num">
							{#if index < step}
								<Icon name="check" size="0.75rem" style="solid" />
							{:else}
								{index + 1}
							{/if}
						</span>
						<span class="lbl">{entry.label}</span>
					</button>
				</li>
			{/each}
		</ol>

		<div class="pane">
			{#if current}
				<h3>{current.label}</h3>
				{#if current.description}
					<p class="dim desc">{current.description}</p>
				{/if}
				<div class="body">{@render children(current)}</div>
			{/if}
		</div>

		{#if aside}
			<div class="aside">{@render aside()}</div>
		{/if}
	</div>

	{#snippet footer()}
		<span class="reason dim">{blocked}</span>
		<Btn onclick={cancel} disabled={busy}>{t('web.common.cancel')}</Btn>
		<Btn onclick={back} disabled={step === 0 || busy}>{t('web.wizardModal.back')}</Btn>
		<Btn variant="primary" onclick={next} disabled={!!blocked || busy} loading={busy}>
			{last ? confirmLabel : t('web.wizardModal.next')}
		</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.wiz {
		display: grid;
		grid-template-columns: 12rem 1fr;
		gap: 1.25rem;

		// the rail is a luxury the narrow viewport does not have; the step
		// headings alone carry the sequence there
		@include below($bp-narrow) {
			grid-template-columns: 1fr;
		}
	}

	.rail {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin: 0;
		padding: 0;
		list-style: none;

		@include below($bp-narrow) {
			flex-direction: row;
			overflow-x: auto;
		}
	}

	.rstep {
		@include bare-button;

		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.5rem 0.625rem;
		border-radius: var(--radius-input);
		color: var(--text-dim);
		text-align: left;
		cursor: pointer;

		&:disabled {
			cursor: default;
		}

		&:hover:not(:disabled) {
			background: var(--bg-hover);
		}

		&.active {
			background: var(--bg-hover);
			color: var(--text);
			font-weight: 700;
		}

		&.done {
			color: var(--text);
		}
	}

	.num {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		flex: none;
		border-radius: 50%;
		background: var(--bg-input);
		font-size: 0.75rem;

		.done & {
			background: var(--success);
			color: var(--bg-panel);
		}

		.active & {
			background: var(--primary);
			color: var(--bg-panel);
		}
	}

	.lbl {
		@include ellipsis;
	}

	.pane {
		min-width: 0;

		h3 {
			margin: 0;
			font-size: 1rem;
		}
	}

	.desc {
		margin: 0.25rem 0 0;
	}

	.body {
		margin-top: 1rem;
	}

	.aside {
		grid-column: 1 / -1;
	}

	// the reason a blocked Next is blocked sits beside it, not in a tooltip: it
	// is the one thing the user needs in order to get unstuck
	.reason {
		flex: 1;
		min-width: 0;
		font-size: 0.8125rem;
	}
</style>
