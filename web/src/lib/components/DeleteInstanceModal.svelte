<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { deleteInstanceJob } from '$lib/instancejobs';
	import Modal from './Modal.svelte';
	import Btn from './Btn.svelte';
	import Checkbox from './Checkbox.svelte';

	/**
	 * Delete confirmation for one instance or several, modelled on the AWS confirm pattern:
	 * lead question, consequence notes, then a divided type-to-confirm section.
	 *
	 * It lives in the component library because both places that can delete an
	 * instance (the instances table and the instance detail page) must offer
	 * the same dialog without either one navigating to the other.
	 */
	let {
		open = $bindable(false),
		name = '',
		names,
		ondeleted
	}: {
		open?: boolean;
		/** the instance to delete; the dialog does nothing without one */
		name?: string;
		/** several instances at once, from a table selection; wins over `name` */
		names?: string[];
		/** fired once per instance whose job is handed to its flash card, for a redirect or a refresh */
		ondeleted?: (name: string) => void;
	} = $props();

	const targets = $derived(names && names.length > 0 ? names : name ? [name] : []);
	const many = $derived(targets.length > 1);

	let confirmText = $state('');
	let purge = $state(false);

	const confirmed = $derived(confirmText.trim().toLowerCase() === 'delete');

	// a reopened dialog never inherits the previous attempt's confirmation
	$effect(() => {
		if (open) {
			confirmText = '';
			purge = false;
		}
	});

	function submit(): void {
		if (targets.length === 0 || !confirmed) {
			return;
		}

		open = false;

		// one flash card per instance follows its own job from here; each row reads
		// "deleting" until it (and a purge's directory walk) finishes
		for (const target of targets) {
			void deleteInstanceJob(target, purge);

			ondeleted?.(target);
		}
	}
</script>

<Modal
	title={many
		? t('web.deleteInstance.titleMany', { count: targets.length })
		: t('web.deleteInstance.title', { name: targets[0] ?? '' })}
	bind:open
>
	{#if many}
		<p class="del-lead">{t('web.deleteInstance.leadMany', { count: targets.length })}</p>
		<ul class="del-list">
			{#each targets as target (target)}
				<li><b>{target}</b></li>
			{/each}
		</ul>
	{:else}
		<p class="del-lead">
			{t('web.deleteInstance.leadBefore')} <b>{targets[0] ?? ''}</b>{t('web.deleteInstance.leadAfter')}
		</p>
	{/if}
	<p class="del-note">{t('web.deleteInstance.noteDeregister')}</p>
	<p class="del-note">{t('web.deleteInstance.noteDirectory')}</p>
	<label class="purgerow">
		<Checkbox
			checked={purge}
			label={t('web.deleteInstance.purgeLabel')}
			onchange={(value) => (purge = value)}
		/>
		{t('web.deleteInstance.purgeText')}
	</label>
	<div class="del-confirm">
		<span class="del-ask">{t('web.deleteInstance.confirmAsk')}</span>
		<input class="input" bind:value={confirmText} placeholder="delete" />
	</div>
	{#snippet footer()}
		<Btn onclick={() => (open = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="danger" disabled={!confirmed} onclick={submit}>{t('web.common.delete')}</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.purgerow {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		margin: 0.75rem 0 1rem;
	}

	.del-lead {
		margin: 0 0 0.75rem;
	}

	.del-list {
		margin: 0 0 0.75rem;
		padding-left: 1.25rem;
		max-height: 12rem;
		overflow-y: auto;
	}

	.del-note {
		margin: 0 0 0.75rem;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.del-confirm {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		border-top: 0.1rem solid var(--border-divider);
		// stretch to the modal body's edges so the divider runs full width
		margin: 1rem -1.25rem 0;
		padding: 1rem 1.25rem 0.25rem;
	}

	.del-ask {
		font-weight: 700;
		color: var(--text-heading);
	}
</style>
