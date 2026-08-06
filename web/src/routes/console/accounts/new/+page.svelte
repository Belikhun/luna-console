<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { goto } from '$app/navigation';
	import { post } from '$lib/api';
	import Wizard from '$lib/components/Wizard.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import FormGrid from '$lib/components/FormGrid.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import { Notify } from '$lib/notifications.svelte';
	// $shared, never $core: the bridge reaches the daemon over a unix socket and
	// has no business in a browser bundle
	import { MIN_PASSWORD_LENGTH, USERNAME_PATTERN } from '$shared/accountrules';

	/**
	 * Create a console account.
	 *
	 * The password is optional on purpose: an account can be prepared before its
	 * owner is at a keyboard, and handing them a password over chat so they can
	 * change it five minutes later is worse than creating the account without one
	 * and setting it while they watch. An account with no password simply cannot
	 * sign in, which the Accounts screen says in its own state column.
	 */

	let username = $state('');
	let displayName = $state('');
	let email = $state('');
	let description = $state('');
	let withPassword = $state(true);
	let password = $state('');
	let confirm = $state('');
	let mustChange = $state(false);
	let disabled = $state(false);
	let saving = $state(false);

	const nameError = $derived.by(() => {
		if (!username) {
			return '';
		}

		if (!USERNAME_PATTERN.test(username)) {
			return t('web.accountNew.nameRule');
		}

		return '';
	});

	const passwordError = $derived.by(() => {
		if (!withPassword || !password) {
			return '';
		}

		if (password.length < MIN_PASSWORD_LENGTH) {
			return t('web.accountNew.passwordRule', { min: MIN_PASSWORD_LENGTH });
		}

		if (confirm && password !== confirm) {
			return t('web.accountNew.mismatch');
		}

		return '';
	});

	const ready = $derived(
		!!username &&
			!nameError &&
			!passwordError &&
			(!withPassword || (!!password && password === confirm))
	);

	async function submit(): Promise<void> {
		saving = true;

		try {
			const result = await post('/accounts', {
				username,
				password: withPassword ? password : undefined,
				displayName,
				email,
				description,
				mustChangePassword: withPassword && mustChange,
				disabled
			});

			Notify.success(t('web.accountNew.created', { name: result.account.username }), {
				detail: withPassword
					? t('web.accountNew.canSignIn')
					: t('web.accountNew.needsPassword', { name: result.account.username })
			});

			await goto(`/console/accounts/${result.account.id}`);
		} catch (err) {
			Notify.error(t('web.accountNew.failed'), { detail: (err as Error).message });
			saving = false;
		}
	}
</script>

<Wizard
	title={t('web.accountNew.title')}
	description={t('web.accountNew.description')}
	submitLabel={t('web.accountNew.submit')}
	disabled={!ready}
	loading={saving}
	onsubmit={submit}
>
	{#snippet summary()}
		{#if username}
			<b>{username}</b>
			·
			{withPassword ? t('web.accountNew.recapWithPassword') : t('web.accountNew.recapNoPassword')}
			·
			{disabled ? t('web.accounts.disabled') : t('web.accounts.enabled')}
		{:else}
			{t('web.accountNew.recapEmpty')}
		{/if}
	{/snippet}

	<Panel title={t('web.accountNew.identityPanel')} description={t('web.accountNew.identityHint')}>
		<FormGrid>
			<label class="field">
				<span class="lbl">{t('web.accountNew.username')}</span>
				<span class="hint">{t('web.accountNew.usernameHint')}</span>
				<input
					class="input"
					type="text"
					spellcheck="false"
					autocapitalize="none"
					bind:value={username}
				/>
				{#if nameError}<span class="err">{nameError}</span>{/if}
			</label>

			<label class="field">
				<span class="lbl">{t('web.accountNew.displayName')}</span>
				<span class="hint">{t('web.accountNew.displayNameHint')}</span>
				<input class="input" type="text" bind:value={displayName} />
			</label>

			<label class="field">
				<span class="lbl">{t('web.accountNew.email')}</span>
				<span class="hint">{t('web.accountNew.emailHint')}</span>
				<input class="input" type="email" spellcheck="false" bind:value={email} />
			</label>

			<label class="field">
				<span class="lbl">{t('web.accountNew.purpose')}</span>
				<span class="hint">{t('web.accountNew.purposeHint')}</span>
				<input class="input" type="text" bind:value={description} />
			</label>
		</FormGrid>
	</Panel>

	<div class="gap"></div>

	<Panel title={t('web.accountNew.accessPanel')} description={t('web.accountNew.accessHint')}>
		<label class="check">
			<Checkbox
				checked={withPassword}
				onchange={(value) => (withPassword = value)}
				label={t('web.accountNew.setPasswordNow')}
			/>
			<span>{t('web.accountNew.setPasswordNow')}</span>
		</label>

		{#if withPassword}
			<FormGrid>
				<label class="field">
					<span class="lbl">{t('web.login.password')}</span>
					<input class="input" type="password" autocomplete="new-password" bind:value={password} />
				</label>

				<label class="field">
					<span class="lbl">{t('web.login.confirmPassword')}</span>
					<input class="input" type="password" autocomplete="new-password" bind:value={confirm} />
					{#if passwordError}<span class="err">{passwordError}</span>{/if}
				</label>
			</FormGrid>

			<label class="check">
				<Checkbox
					checked={mustChange}
					onchange={(value) => (mustChange = value)}
					label={t('web.accountNew.mustChange')}
				/>
				<span>{t('web.accountNew.mustChange')}</span>
			</label>
		{:else}
			<Flash kind="warning">{t('web.accountNew.noPasswordNotice')}</Flash>
		{/if}

		<label class="check">
			<Checkbox
				checked={disabled}
				onchange={(value) => (disabled = value)}
				label={t('web.accountNew.createDisabled')}
			/>
			<span>{t('web.accountNew.createDisabled')}</span>
		</label>
	</Panel>

	<div class="gap"></div>

	<Flash kind="info">{t('web.accountNew.noPermissionsNotice')}</Flash>
</Wizard>

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
</style>
