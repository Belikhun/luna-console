<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { api } from '$lib/api';
	import { Authz } from '$lib/authz.svelte';
	import { Agent } from '$lib/agent.svelte';
	import { Notify } from '$lib/notifications.svelte';
	import { fmtDateTime } from '$lib/format';
	import Modal from './Modal.svelte';
	import Btn from './Btn.svelte';
	import Select from './Select.svelte';
	import Icon from './Icon.svelte';

	/**
	 * Who else may open a Mèo Béo conversation. Setting `target` (a
	 * conversation id) opens it; the owner adds accounts as viewers (read and
	 * follow live) or collaborators (also write), changes a role or takes a
	 * share back. Suggestions come from the account list when the owner may
	 * list accounts; otherwise a name is typed.
	 */
	let { target = $bindable() }: { target: string | null } = $props();

	let open = $state(false);
	let account = $state('');
	let role = $state('viewer');
	let busy = $state(false);
	let known: Array<{ username: string; displayName: string }> = $state([]);

	const row = $derived(Agent.conversations.find((entry) => entry.id === target) ?? null);
	const shares = $derived(row?.shares ?? []);
	const roles = $derived([
		{ value: 'viewer', label: t('web.agentShare.role_viewer') },
		{ value: 'collaborator', label: t('web.agentShare.role_collaborator') }
	]);

	$effect(() => {
		open = target !== null;
	});

	$effect(() => {
		if (!open) {
			target = null;
		}
	});

	// the list is only a convenience; an owner who may not list accounts types a name
	$effect(() => {
		if (!open || known.length || !Authz.can('account:List')) {
			return;
		}

		api<{ accounts: Array<{ username: string; displayName: string; enabled: boolean }> }>('/accounts')
			.then((data) => {
				known = data.accounts
					.filter((entry) => entry.enabled)
					.map((entry) => ({ username: entry.username, displayName: entry.displayName }));
			})
			.catch(() => {});
	});

	const suggestions = $derived(
		known.filter((entry) => entry.username !== Agent.state?.me && !shares.some((share) => share.account === entry.username))
	);

	async function apply(name: string, next: 'viewer' | 'collaborator' | null): Promise<void> {
		if (!target || !name.trim()) {
			return;
		}

		busy = true;

		try {
			await Agent.share(target, name.trim(), next);

			if (next && name === account) {
				account = '';
			}
		} catch (err) {
			Notify.error(t('web.agentShare.failed'), { detail: (err as Error).message });
		} finally {
			busy = false;
		}
	}
</script>

<Modal bind:open title={t('web.agentShare.title')}>
	<p class="lead">{t('web.agentShare.lead', { title: row?.title || t('web.agent.untitled') })}</p>

	<form
		class="add"
		onsubmit={(event) => {
			event.preventDefault();
			void apply(account, role as 'viewer' | 'collaborator');
		}}
	>
		<input
			class="input"
			type="text"
			list="agent-share-accounts"
			maxlength="64"
			placeholder={t('web.agentShare.account')}
			autocomplete="off"
			bind:value={account}
		/>
		<datalist id="agent-share-accounts">
			{#each suggestions as entry (entry.username)}
				<option value={entry.username}>{entry.displayName}</option>
			{/each}
		</datalist>
		<Select bind:value={role} options={roles} width="10rem" />
		<Btn type="submit" variant="primary" icon="userPlus" loading={busy} disabled={!account.trim()}>
			{t('web.agentShare.add')}
		</Btn>
	</form>

	{#if shares.length === 0}
		<p class="dim empty">{t('web.agentShare.none')}</p>
	{:else}
		<ul class="people">
			{#each shares as share (share.account)}
				<li>
					<span class="who">
						<Icon name={share.role === 'collaborator' ? 'pen' : 'eye'} size="0.75rem" />
						<b>{share.account}</b>
						<span class="dim">{t('web.agentShare.since', { when: fmtDateTime(share.at) })}</span>
					</span>
					<Select
						value={share.role}
						options={roles}
						width="10rem"
						disabled={busy}
						onchange={(value) => apply(share.account, value as 'viewer' | 'collaborator')}
					/>
					<Btn variant="icon" icon="trash" title={t('web.agentShare.remove')} disabled={busy} onclick={() => apply(share.account, null)} />
				</li>
			{/each}
		</ul>
	{/if}

	<ul class="notes">
		<li>{t('web.agentShare.noteRoles')}</li>
		<li>{t('web.agentShare.noteAuthority')}</li>
		<li>{t('web.agentShare.noteRedaction')}</li>
	</ul>
</Modal>

<style lang="scss">
	.lead {
		margin: 0 0 1rem;
		color: var(--text);
	}

	.add {
		display: flex;
		gap: 0.5rem;
		align-items: center;

		.input {
			flex: 1;
			min-width: 0;
		}

		@include below($bp-narrow) {
			flex-wrap: wrap;
		}
	}

	.empty {
		margin: 1rem 0;
	}

	.people {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin: 1rem 0;
		padding: 0;
		list-style: none;

		li {
			display: flex;
			align-items: center;
			gap: 0.5rem;
		}

		.who {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			flex: 1;
			min-width: 0;

			b {
				@include ellipsis;

				color: var(--text-heading);
			}

			.dim {
				@include ellipsis;

				font-size: 0.75rem;
			}
		}
	}

	.dim {
		color: var(--text-secondary);
	}

	.notes {
		margin: 1rem 0 0;
		padding-left: 1.25rem;
		font-size: 0.75rem;
		color: var(--text-secondary);

		li + li {
			margin-top: 0.25rem;
		}
	}
</style>
