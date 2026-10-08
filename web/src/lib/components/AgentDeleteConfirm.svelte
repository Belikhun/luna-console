<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { Agent } from '$lib/agent.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import ConfirmModal from './ConfirmModal.svelte';

	/**
	 * The question before a Mèo Béo conversation is deleted, shared by every
	 * place that offers it (the panel's header and history, the full-page screen,
	 * a popped-out window). Setting `target` opens it; it clears itself once the
	 * operator answers either way.
	 */
	let { target = $bindable() }: { target: { id: string; title: string } | null } = $props();

	let open = $state(false);

	$effect(() => {
		open = target !== null;
	});

	$effect(() => {
		if (!open) {
			target = null;
		}
	});

	async function confirm(): Promise<void> {
		const doomed = target;

		open = false;

		if (!doomed) {
			return;
		}

		try {
			await Agent.remove(doomed.id);
		} catch (err) {
			Notify.error(t('web.agent.deleteFailed'), { detail: (err as Error).message });
		}
	}
</script>

<ConfirmModal
	bind:open
	title={t('web.agent.deleteTitle')}
	lead={t('web.agent.deleteLead', { title: target?.title || t('web.agent.untitled') })}
	notes={[t('web.agent.deleteNote')]}
	confirmLabel={t('web.agent.deleteConfirm')}
	onconfirm={confirm}
/>
