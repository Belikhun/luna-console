<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { api, patch } from '$lib/api';
	import Wizard from '$lib/components/Wizard.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import { Notify } from '$lib/notifications.svelte';
	// $shared, never $core: the bridge reaches the daemon over a unix socket and
	// has no business in a browser bundle
	import { USERNAME_PATTERN } from '$shared/accountrules';

	/**
	 * Edit one console account's details.
	 *
	 * A wizard rather than a dialog, to match creating an account: these are the
	 * same fields, and a rename is not a small change; it is the name the audit
	 * trail and every sign-in will carry from here on, so it deserves the room to
	 * show what it will do before it does it.
	 *
	 * Credentials are deliberately absent. A password and an access key are their
	 * own objects with their own verbs on the detail screen, and folding them into
	 * a details form is what makes people change two things when they meant one.
	 */

	interface AccountFields {
		id: string;
		username: string;
		displayName: string;
		email: string;
		description: string;
		mustChangePassword: boolean;
		hasPassword: boolean;
	}

	const id = $derived(page.params.id!);

	let loading = $state(true);
	let saving = $state(false);
	let missing = $state('');

	let account = $state<AccountFields | null>(null);

	// the form
	let username = $state('');
	let displayName = $state('');
	let email = $state('');
	let description = $state('');
	let mustChange = $state(false);

	// What was loaded, for the diff the summary bar reports. These are $state
	// because the recap and the rename notice read them: a plain `let` assigned
	// inside load() would leave both showing the values from before the fetch.
	let initialUsername = $state('');
	let initialDisplayName = $state('');
	let initialEmail = $state('');
	let initialDescription = $state('');
	let initialMustChange = $state(false);

	async function load(): Promise<void> {
		loading = true;

		try {
			const data = await api(`/accounts/${encodeURIComponent(id)}`);

			account = data.account;
			username = data.account.username;
			displayName = data.account.displayName;
			email = data.account.email;
			description = data.account.description;
			mustChange = data.account.mustChangePassword;

			initialUsername = username;
			initialDisplayName = displayName;
			initialEmail = email;
			initialDescription = description;
			initialMustChange = mustChange;
		} catch (err) {
			missing = (err as Error).message;
		}

		loading = false;
	}

	onMount(() => {
		void load();
	});

	const nameError = $derived(
		username && !USERNAME_PATTERN.test(username) ? t('web.accountNew.nameRule') : ''
	);

	/** What the save will actually do, named field by field for the recap line. */
	const changes = $derived.by(() => {
		const out: string[] = [];

		if (username !== initialUsername) {
			out.push(t('web.accountEdit.changeUsername', { from: initialUsername, to: username }));
		}

		if (displayName !== initialDisplayName) {
			out.push(t('web.accountEdit.changeDisplayName'));
		}

		if (email !== initialEmail) {
			out.push(t('web.accountEdit.changeEmail'));
		}

		if (description !== initialDescription) {
			out.push(t('web.accountEdit.changePurpose'));
		}

		if (mustChange !== initialMustChange) {
			out.push(
				mustChange ? t('web.accountEdit.changeMustChangeOn') : t('web.accountEdit.changeMustChangeOff')
			);
		}

		return out;
	});

	const ready = $derived(!loading && !!username && !nameError && changes.length > 0);

	async function save(): Promise<void> {
		saving = true;

		try {
			await patch(`/accounts/${account!.id}`, {
				username,
				displayName,
				email,
				description,
				mustChangePassword: mustChange
			});

			Notify.success(t('web.accountDetail.saved', { name: username }));

			await goto(`/console/accounts/${account!.id}`);
		} catch (err) {
			Notify.error(t('web.accountDetail.saveFailed'), { detail: (err as Error).message });
			saving = false;
		}
	}
</script>

{#if missing}
	<Wizard
		title={t('web.accountEdit.title')}
		submitLabel={t('web.accountEdit.submit')}
		disabled
		onsubmit={() => {}}
	>
		{#snippet summary()}
			{t('web.accountEdit.notFoundRecap')}
		{/snippet}

		<Panel title={t('web.accountEdit.notFoundPanel')}>
			<p class="dim">
				{missing}
				<a href="/console/accounts">{t('web.accountDetail.backToAccounts')}</a>
			</p>
		</Panel>
	</Wizard>
{:else}
	<Wizard
		title={loading ? t('web.accountEdit.title') : t('web.accountEdit.titleNamed', { name: initialUsername })}
		windowTitle={t('web.accountEdit.title')}
		description={t('web.accountEdit.description')}
		submitLabel={t('web.accountEdit.submit')}
		disabled={!ready}
		loading={saving}
		onsubmit={save}
	>
		{#snippet summary()}
			{#if loading}
				{t('web.common.loading')}
			{:else if changes.length === 0}
				{t('web.accountEdit.noChanges')}
			{:else}
				{changes.join(' · ')}
			{/if}
		{/snippet}

		<Panel
			title={t('web.accountEdit.identityPanel')}
			description={t('web.accountEdit.identityHint')}
		>
			<FormGrid>
				<label class="field">
					<span class="lbl">{t('web.accountNew.username')}</span>
					<span class="hint">{t('web.accountEdit.usernameHint')}</span>
					<input
						class="input"
						type="text"
						spellcheck="false"
						autocapitalize="none"
						disabled={loading}
						bind:value={username}
					/>
					{#if nameError}<span class="err">{nameError}</span>{/if}
				</label>

				<label class="field">
					<span class="lbl">{t('web.accountNew.displayName')}</span>
					<span class="hint">{t('web.accountNew.displayNameHint')}</span>
					<input class="input" type="text" disabled={loading} bind:value={displayName} />
				</label>

				<label class="field">
					<span class="lbl">{t('web.accountNew.email')}</span>
					<span class="hint">{t('web.accountNew.emailHint')}</span>
					<input
						class="input"
						type="email"
						spellcheck="false"
						disabled={loading}
						bind:value={email}
					/>
				</label>

				<label class="field">
					<span class="lbl">{t('web.accountNew.purpose')}</span>
					<span class="hint">{t('web.accountNew.purposeHint')}</span>
					<input class="input" type="text" disabled={loading} bind:value={description} />
				</label>
			</FormGrid>

			{#if username !== initialUsername && initialUsername}
				<Flash kind="warning">
					{t('web.accountEdit.renameNotice', { from: initialUsername, to: username })}
				</Flash>
			{/if}
		</Panel>

		<div class="gap"></div>

		<Panel title={t('web.accountEdit.accessPanel')} description={t('web.accountEdit.accessHint')}>
			<label class="check">
				<Checkbox
					checked={mustChange}
					onchange={(value) => (mustChange = value)}
					label={t('web.accountDetail.askForNewPassword')}
				/>
				<span>{t('web.accountDetail.askForNewPassword')}</span>
			</label>

			{#if mustChange && account && !account.hasPassword}
				<Flash kind="warning">{t('web.accountEdit.noPasswordNotice')}</Flash>
			{/if}

			<p class="dim note">
				{t('web.accountEdit.credentialsElsewhere')}
				<a href="/console/accounts/{id}">{t('web.accountEdit.backToAccount')}</a>
			</p>
		</Panel>
	</Wizard>
{/if}

<style lang="scss">
	.gap {
		height: 1rem;
	}

	.check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.875rem;
		font-size: 0.875rem;
		cursor: pointer;
	}

	.note {
		margin: 0;
		font-size: 0.875rem;
	}
</style>
