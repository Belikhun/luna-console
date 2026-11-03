<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { Agent, type ConversationRow } from '$lib/agent.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import Modal from './Modal.svelte';
	import Btn from './Btn.svelte';
	import AgentShareDialog from './AgentShareDialog.svelte';
	import AgentDeleteConfirm from './AgentDeleteConfirm.svelte';
	import type { ConversationDialogs } from './agentmenu';

	/**
	 * The dialogs a conversation's verbs open (rename, share, delete or leave),
	 * hosted once per screen. The screen hands `dialogs` to `conversationVerbs`;
	 * `branched` is the screen's own, since where a new branch opens differs.
	 */
	let { branched }: { branched: (id: string) => void | Promise<void> } = $props();

	let renaming: ConversationRow | null = $state(null);
	let renameOpen = $state(false);
	let title = $state('');
	let saving = $state(false);
	let sharing: string | null = $state(null);
	let deleting: { id: string; title: string; leave?: boolean } | null = $state(null);

	$effect(() => {
		if (!renameOpen) {
			renaming = null;
		}
	});

	export const dialogs: ConversationDialogs = {
		rename: (row) => {
			renaming = row;
			title = row.title;
			renameOpen = true;
		},
		share: (row) => {
			sharing = row.id;
		},
		remove: (row) => {
			deleting = { id: row.id, title: row.title, leave: row.role !== 'owner' };
		},
		branched: (id) => branched(id)
	};

	async function rename(): Promise<void> {
		if (!renaming) {
			return;
		}

		saving = true;

		try {
			await Agent.rename(renaming.id, title);
			renameOpen = false;
		} catch (err) {
			Notify.error(t('web.agentMenu.renameFailed'), { detail: (err as Error).message });
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:open={renameOpen} title={t('web.agentMenu.renameTitle')}>
	<form
		class="rename"
		onsubmit={(event) => {
			event.preventDefault();
			void rename();
		}}
	>
		<!-- svelte-ignore a11y_autofocus -->
		<input class="input" type="text" maxlength="120" autofocus bind:value={title} placeholder={t('web.agent.untitled')} />
	</form>
	{#snippet footer()}
		<Btn onclick={() => (renameOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" loading={saving} onclick={rename}>{t('web.agentMenu.rename')}</Btn>
	{/snippet}
</Modal>

<AgentShareDialog bind:target={sharing} />
<AgentDeleteConfirm bind:target={deleting} />

<style lang="scss">
	.rename .input {
		width: 100%;
	}
</style>
