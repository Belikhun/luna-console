<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { t } from '$lib/i18n.svelte';
	import Modal from './Modal.svelte';
	import Btn from './Btn.svelte';

	/**
	 * The confirmation step for a destructive verb: lead question, consequence
	 * notes, then an explicit cancel/confirm footer, following the same shape as
	 * DeleteInstanceModal without the type-to-confirm section. Every "are you
	 * sure" in the console goes through this dialog; never `window.confirm`,
	 * which blocks the tab and ignores the design language.
	 */
	let {
		open = $bindable(false),
		title,
		lead,
		notes = [],
		confirmLabel,
		danger = true,
		onconfirm,
		children
	}: {
		open?: boolean;
		title: string;
		/** the question itself, naming exactly what is about to happen */
		lead: string;
		/** consequences worth reading before the click, one paragraph each */
		notes?: string[];
		/** the verb on the confirming button, e.g. "Delete" */
		confirmLabel: string;
		/** false renders the confirming button as primary, for non-destructive asks */
		danger?: boolean;
		onconfirm: () => void;
		/** extra content between the notes and the footer */
		children?: Snippet;
	} = $props();

	function submit(): void {
		open = false;
		onconfirm();
	}
</script>

<Modal {title} bind:open>
	<p class="lead">{lead}</p>
	{#each notes as note}
		<p class="note">{note}</p>
	{/each}
	{#if children}
		{@render children()}
	{/if}
	{#snippet footer()}
		<Btn onclick={() => (open = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant={danger ? 'danger' : 'primary'} onclick={submit}>{confirmLabel}</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.lead {
		margin: 0 0 0.75rem;
	}

	.note {
		margin: 0 0 0.75rem;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}
</style>
