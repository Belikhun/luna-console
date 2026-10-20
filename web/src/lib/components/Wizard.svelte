<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import PageHeader from './PageHeader.svelte';
	import Btn from './Btn.svelte';
	import Icon from './Icon.svelte';
	import type { WizardStep } from './wizardmodal';

	/**
	 * The console's one wizard shell; every create flow (launch instance,
	 * create schedule, create addon group) renders through this: the page
	 * header, a single column of panels, and a sticky summary bar whose dim
	 * recap and primary submit stay reachable while the form scrolls.
	 *
	 * With `steps` it becomes a stepped page, AWS's create-policy shape: a
	 * numbered rail beside the form, one step at a time (the caller branches on
	 * the bound `step`), and Cancel / Previous / Next in the bar, the last
	 * step's Next being the submit. Without it nothing changes.
	 */
	let {
		title,
		description,
		windowTitle = title,
		submitLabel,
		disabled = false,
		loading = false,
		onsubmit,
		summary,
		children,
		steps,
		step = $bindable(0),
		cancelHref
	}: {
		title: string;
		description?: string;
		/** browser-tab title; defaults to `title` */
		windowTitle?: string;
		/** the primary button's label, e.g. "Launch instance" */
		submitLabel: string;
		/** blocks submit; a validation failure, a missing required field */
		disabled?: boolean;
		/** the submit is in flight */
		loading?: boolean;
		onsubmit: () => void;
		/** the dim recap line in the sticky bar */
		summary: Snippet;
		children: Snippet;
		/** the steps, in order; a step's `blocked` holds Next with its reason */
		steps?: WizardStep[];
		/** index into `steps`; the caller renders the matching body */
		step?: number;
		/** where Cancel goes on a stepped page */
		cancelHref?: string;
	} = $props();

	const current = $derived(steps ? steps[Math.min(step, steps.length - 1)] : undefined);
	const last = $derived(!steps || step >= steps.length - 1);
	const blocked = $derived(current?.blocked ?? '');

	function next(): void {
		if (blocked) {
			return;
		}

		if (last) {
			onsubmit();

			return;
		}

		step = Math.min((steps?.length ?? 1) - 1, step + 1);
	}

	function back(): void {
		step = Math.max(0, step - 1);
	}

	/** Only a step already seen is reachable from the rail; skipping ahead would skip its checks. */
	function jump(index: number): void {
		if (index <= step && !loading) {
			step = index;
		}
	}
</script>

<svelte:head><title>{windowTitle} | Luna Console</title></svelte:head>

<PageHeader {title} {description} />

{#if steps}
	<div class="stepped">
		<ol class="rail">
			{#each steps as entry, index (entry.id)}
				<li>
					<button
						class="rstep"
						class:done={index < step}
						class:active={index === step}
						disabled={index > step || loading}
						onclick={() => jump(index)}
					>
						<span class="stepno">{t('web.wizard.stepNumber', { number: index + 1 })}</span>
						<span class="steplabel">
							{#if index < step}
								<Icon name="circleCheck" size="0.875rem" style="solid" />
							{/if}
							{entry.label}
						</span>
					</button>
				</li>
			{/each}
		</ol>

		<div class="wizard">
			{#if current}
				<div class="stephead">
					<h2>{current.label}</h2>
					{#if current.description}
						<p class="dim">{current.description}</p>
					{/if}
				</div>
			{/if}

			{@render children()}

			<div class="bar">
				<span class="recap dim">
					{#if blocked}
						{blocked}
					{:else}
						{@render summary()}
					{/if}
				</span>
				<span class="buttons">
					{#if cancelHref}
						<Btn variant="link" href={cancelHref}>{t('web.common.cancel')}</Btn>
					{/if}
					{#if step > 0}
						<Btn disabled={loading} onclick={back}>{t('web.wizard.previous')}</Btn>
					{/if}
					<Btn variant="primary" disabled={!!blocked || (last && disabled)} loading={last && loading} onclick={next}>
						{last ? submitLabel : t('web.common.next')}
					</Btn>
				</span>
			</div>
		</div>
	</div>
{:else}
	<div class="wizard">
		{@render children()}

		<div class="bar">
			<span class="recap dim">{@render summary()}</span>
			<Btn variant="primary" {disabled} {loading} onclick={onsubmit}>
				{submitLabel}
			</Btn>
		</div>
	</div>
{/if}

<style lang="scss">
	.wizard {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		max-width: 52rem;
	}

	// the summary bar stays reachable while the form scrolls; the translucent
	// ground + blur keeps the content scrolling under it legible
	.bar {
		position: sticky;
		bottom: 0;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;

		padding: 0.75rem 1.25rem;
		background: color-mix(in srgb, var(--bg-panel) 60%, transparent);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);

		backdrop-filter: blur(1rem) brightness(0.9);
		z-index: 10;
	}

	.recap {
		min-width: 0;
	}

	// ---- stepped page ----
	.stepped {
		display: grid;
		grid-template-columns: 13rem minmax(0, 1fr);
		gap: 1.5rem;
		align-items: start;

		.wizard {
			max-width: 64rem;
		}

		@include below($bp-medium) {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	.rail {
		position: sticky;
		top: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin: 0;
		padding: 0;
		list-style: none;

		@include below($bp-medium) {
			position: static;
			flex-direction: row;
			overflow-x: auto;
		}
	}

	.rstep {
		@include bare-button;

		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		width: 100%;
		padding: 0.5rem 0.75rem;
		border-left: 0.125rem solid transparent;
		color: var(--text-secondary);
		text-align: left;
		cursor: pointer;

		&:disabled {
			cursor: default;
		}

		&:hover:not(:disabled) {
			background: var(--bg-hover);
		}

		&.done {
			color: var(--text);
		}

		&.active {
			border-left-color: var(--link);
			color: var(--text);
			font-weight: 700;
		}
	}

	.stepno {
		font-size: 0.75rem;
		font-weight: 400;
		color: var(--text-secondary);
	}

	.steplabel {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		color: inherit;

		.done & {
			color: var(--success);
		}
	}

	.stephead {
		h2 {
			margin: 0;
			font-size: 1.25rem;
		}

		p {
			margin: 0.25rem 0 0;
			font-size: 0.875rem;
		}
	}

	.buttons {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		flex: none;
	}
</style>
