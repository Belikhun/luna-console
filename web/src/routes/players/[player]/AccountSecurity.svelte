<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t, tSplit } from '$lib/i18n.svelte';
	import { post } from '$lib/api';
	import { copyText } from '$lib/clipboard';
	import { fmtDateTime } from '$lib/format';
	import { Notify } from '$lib/notifications.svelte';
	import Btn from '$lib/components/Btn.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import DateTime from '$lib/components/DateTime.svelte';
	import Dropdown from '$lib/components/Dropdown.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import InfoGrid from '$lib/components/InfoGrid.svelte';
	import type { InfoCell } from '$lib/components/grid';
	import Modal from '$lib/components/Modal.svelte';
	import Panel from '$lib/components/Panel.svelte';
	import Select from '$lib/components/Select.svelte';
	import type { ContextMenuItem } from '$lib/components/contextmenu';
	import type { AuthInfo, LoginModeInfo } from './player';

	/**
	 * A player's luna-auth account: password, lock, session and login mode, with
	 * the verbs that change them. The panels draw only while the Account tab is
	 * shown; the dialogs stay mounted with the screen, because the header's
	 * Actions menu runs the same verbs from any tab through `menu()`.
	 */
	let {
		player,
		username,
		show,
		auth,
		available,
		problem,
		onchanged
	}: {
		/** The uuid or name the profile was opened with */
		player: string;
		username: string;
		/** Whether the Account tab is the one on screen */
		show: boolean;
		/** The account as luna-auth last reported it; the screen reads it for its header too */
		auth: AuthInfo | undefined;
		available: boolean;
		problem: string;
		/** A verb changed the account; the screen re-reads it and the moderation log */
		onchanged: () => void | Promise<void>;
	} = $props();

	/** Default lifetime offered for a temporary password, in minutes. */
	const DEFAULT_TEMP_MINUTES = 1440;

	/** Lifetimes the dialog offers, matching what luna-auth accepts. */
	const tempLifetimes = $derived([
		{ value: '15', label: t('web.playerDetail.15Minutes') },
		{ value: '60', label: t('web.playerDetail.1Hour') },
		{ value: '360', label: t('web.playerDetail.6Hours') },
		{ value: '1440', label: t('web.playerDetail.24Hours') },
		{ value: '10080', label: t('web.playerDetail.7Days') },
		{ value: '43200', label: t('web.playerDetail.30Days') }
	]);

	let resetOpen = $state(false);
	let tempOpen = $state(false);
	let tempPassword = $state('');
	let tempMinutes = $state(String(DEFAULT_TEMP_MINUTES));
	let tempBusy = $state(false);
	/** The plaintext of a freshly issued password; shown once, then forgotten. */
	let issuedPassword = $state('');
	let issuedOpen = $state(false);
	let modeOpen = $state(false);
	let modeChoice = $state('online');
	let modeForever = $state(false);
	let modeBusy = $state(false);
	let premiumBusy = $state(false);

	const path = $derived(`/players/${encodeURIComponent(player)}/auth`);

	/** Why force-login cannot run right now, or undefined when it can. */
	function forceLoginBlocker(): string | undefined {
		if (!auth?.online) {
			return t('web.playerDetail.forceLoginNotConnected');
		}

		if (!auth.registered) {
			return t('web.playerDetail.forceLoginNoPassword');
		}

		if (auth.authenticated) {
			return t('web.playerDetail.forceLoginAlreadyIn');
		}

		return undefined;
	}

	/**
	 * The account verbs. Each unavailable one keeps its place and says why:
	 * "unlock" on an account that is not locked is information, not clutter.
	 *
	 * @returns the menu rows, for the header's Actions menu and the panel's own
	 */
	export function menu(): ContextMenuItem[] {
		const gone = !available;
		const reason = gone
			? t('web.playerDetail.authUnavailable')
			: undefined;

		const hasSession = !!(auth?.authenticated || auth?.session.hasSession);

		return [
			{
				label: t('web.playerDetail.issueATemporaryPassword'),
				icon: 'key',
				disabled: gone,
				hint: reason,
				action: () => {
					tempPassword = '';
					tempMinutes = String(DEFAULT_TEMP_MINUTES);
					tempOpen = true;
				}
			},
			{
				label: t('web.playerDetail.resetPassword'),
				icon: 'rotate',
				color: 'danger',
				disabled: gone || !auth?.registered,
				hint: reason ?? (auth?.registered ? undefined : t('web.playerDetail.hasNoPassword')),
				action: () => {
					resetOpen = true;
				}
			},
			{
				label: t('web.playerDetail.unlockAccount'),
				icon: 'lockOpen',
				disabled: gone || !auth?.locked,
				hint: reason ?? (auth?.locked ? undefined : t('web.playerDetail.notLockedHint')),
				action: () =>
					void run('unlock', t('web.playerDetail.unlocking'), t('web.playerDetail.unlocked'))
			},
			{
				label: t('web.playerDetail.endAuthenticatedSession'),
				icon: 'userLock',
				disabled: gone || !hasSession,
				hint: reason ?? (hasSession ? undefined : t('web.playerDetail.noSessionToEnd')),
				action: () =>
					void run('logout', t('web.playerDetail.endingSession'), t('web.playerDetail.sessionEnded'))
			},
			{
				label: t('web.playerDetail.forceLogin'),
				icon: 'rightToBracket',
				disabled: gone || !auth?.online || !auth?.registered || auth?.authenticated,
				hint: reason ?? forceLoginBlocker(),
				action: () =>
					void run(
						'forcelogin',
						t('web.playerDetail.forcingLogin', { name: username }),
						t('web.playerDetail.forcedLogin', { name: username })
					)
			},
			{
				label: t('web.playerDetail.changeLoginMode'),
				icon: 'userShield',
				disabled: gone || !auth?.loginMode,
				hint: reason ?? (auth?.loginMode ? undefined : t('web.playerDetail.loginModeUnavailable')),
				action: openLoginMode
			}
		];
	}

	/** Run an account verb that needs no dialog and carries no secret back. */
	async function run(action: string, busy: string, done: string): Promise<void> {
		const note = Notify.loading(busy);

		try {
			const result = await post(path, { action });

			if (result?.ok === false) {
				throw new Error(result.error ?? '');
			}

			note.set({ level: 'success', message: done, closeable: true });
		} catch (err) {
			note.set({ level: 'error', message: busy, detail: (err as Error).message, closeable: true });
		}

		await onchanged();
	}

	async function doReset(): Promise<void> {
		resetOpen = false;

		await run(
			'reset',
			t('web.playerDetail.resettingPassword', { name: username }),
			t('web.playerDetail.passwordCleared', { name: username })
		);
	}

	/**
	 * Issue a temporary password. The plaintext only exists in this response, so
	 * it goes straight into a dialog for the operator to pass on; reloading the
	 * page cannot bring it back.
	 */
	async function doTemporary(): Promise<void> {
		tempBusy = true;

		const note = Notify.loading(t('web.playerDetail.issuingTempPassword', { name: username }));

		try {
			const chosen = tempPassword.trim();
			const result = await post(path, {
				action: 'temporary',
				expiresInMinutes: Number(tempMinutes),
				...(chosen ? { password: chosen } : {})
			});

			if (result.ok === false) {
				throw new Error(result.error ?? '');
			}

			tempOpen = false;
			issuedPassword = result.data?.password ?? chosen;
			issuedOpen = true;

			note.set({
				level: 'success',
				message: t('web.playerDetail.tempPasswordIssued', { name: username }),
				closeable: true
			});

			await onchanged();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.playerDetail.couldNotIssueATemporary'),
				detail: (err as Error).message,
				closeable: true
			});
		}

		tempBusy = false;
	}

	const authCells: InfoCell[] = $derived(
		auth
			? [
					{
						id: 'password',
						label: t('web.playerDetail.password'),
						value: !auth.registered
							? t('web.playerDetail.passwordNone')
							: auth.temporaryPassword
								? t('web.playerDetail.passwordTemporary')
								: t('web.playerDetail.passwordOwn')
					},
					{
						label: t('web.playerDetail.signedIn'),
						value: auth.authenticated ? t('web.common.yes') : t('web.common.no')
					},
					{
						id: 'lock',
						label: t('web.playerDetail.accountLock'),
						value: auth.locked ? t('web.playerDetail.locked') : t('web.playerDetail.notLocked')
					},
					{ label: t('web.playerDetail.failedAttempts'), value: auth.failedAttempts },
					{
						label: t('web.playerDetail.lastLogin'),
						value: auth.lastLoginAtEpochMillis ? fmtDateTime(auth.lastLoginAtEpochMillis) : null,
						time: auth.lastLoginAtEpochMillis || null
					},
					{ label: t('web.playerDetail.lastAddress'), value: auth.lastIp || null, style: 'mono' },
					{
						label: t('web.playerDetail.registeredOn'),
						value: auth.createdAtEpochMillis ? fmtDateTime(auth.createdAtEpochMillis) : null,
						time: auth.createdAtEpochMillis || null
					},
					{
						id: 'session',
						label: t('web.playerDetail.resumableSession'),
						value: auth.session.hasSession ? t('web.playerDetail.sessionKept') : t('web.common.none')
					}
				]
			: []
	);

	// --------------------------------------------------------------- login mode

	function modeLabel(mode: string): string {
		if (mode === 'online') {
			return t('web.playerDetail.loginModeOnline');
		}

		if (mode === 'offline') {
			return t('web.playerDetail.loginModeOffline');
		}

		if (mode === 'ask') {
			return t('web.playerDetail.loginModeAsk');
		}

		if (mode === 'online-if-premium') {
			return t('web.playerDetail.loginModeOnlineIfPremium');
		}

		return '–';
	}

	/** Keys for where a premium verdict came from, as luna-auth names the sources. */
	const PREMIUM_SOURCES: Record<string, string> = {
		mojang: 'web.playerDetail.premiumSourceMojang',
		cache: 'web.playerDetail.premiumSourceCache',
		verified: 'web.playerDetail.premiumSourceVerified',
		known: 'web.playerDetail.premiumSourceKnown',
		failed: 'web.playerDetail.premiumSourceFailed',
		unchecked: 'web.playerDetail.premiumSourceUnchecked'
	};

	/** The sources whose sentence holds `{date}`, drawn with a clickable date. */
	const DATED_PREMIUM_SOURCES = new Set(['mojang', 'cache', 'verified']);

	/** Whether the player owns a Mojang account, in a word. */
	function premiumVerdict(info: LoginModeInfo): string {
		return info.premium.status === 'premium'
			? t('web.playerDetail.premiumYes')
			: info.premium.status === 'not_premium'
				? t('web.playerDetail.premiumNo')
				: t('web.playerDetail.premiumUnknown');
	}

	/** The premium verdict plus where it came from, in one line. */
	function premiumLabel(info: LoginModeInfo): string {
		const premium = info.premium;
		const verdict = premiumVerdict(info);
		const date = premium.checkedAtEpochMillis
			? fmtDateTime(premium.checkedAtEpochMillis)
			: '';
		const sourceKey = PREMIUM_SOURCES[premium.source];

		if (!sourceKey) {
			return verdict;
		}

		return `${verdict} · ${t(sourceKey, { date, error: premium.error })}`;
	}

	const loginModeCells: InfoCell[] = $derived(
		auth?.loginMode
			? [
					{
						label: t('web.playerDetail.loginModeCurrent'),
						value: auth.loginMode.current
							? modeLabel(auth.loginMode.current)
							: t('web.playerDetail.loginModeNotConnected')
					},
					{
						label: t('web.playerDetail.loginModeNext'),
						value: modeLabel(auth.loginMode.next)
					},
					{
						id: 'preference',
						label: t('web.playerDetail.loginModePreference'),
						value: !auth.loginMode.preference
							? t('web.playerDetail.loginModeNone')
							: auth.loginMode.preference.rememberForever
								? t('web.playerDetail.loginModeForever', { mode: modeLabel(auth.loginMode.preference.mode) })
								: t('web.playerDetail.loginModeUntil', {
										mode: modeLabel(auth.loginMode.preference.mode),
										date: fmtDateTime(auth.loginMode.preference.expiresAtEpochMillis)
									})
					},
					{
						id: 'premium',
						label: t('web.playerDetail.loginModePremium'),
						value: premiumLabel(auth.loginMode),
						copyable: false,
						colSpan: 'all'
					}
				]
			: []
	);

	function openLoginMode(): void {
		const preference = auth?.loginMode?.preference;

		modeChoice = preference?.mode ?? 'online';
		modeForever = preference?.rememberForever ?? false;
		modeOpen = true;
	}

	/** True when applying the chosen mode disconnects the player, because their live mode differs. */
	const modeReconnects = $derived(
		!!auth?.loginMode?.current &&
			modeChoice !== 'unset' &&
			auth.loginMode.current !== modeChoice
	);

	async function doLoginMode(): Promise<void> {
		modeBusy = true;

		const note = Notify.loading(t('web.playerDetail.settingLoginMode', { name: username }));

		try {
			const result = await post(path, {
				action: 'mode',
				mode: modeChoice,
				forever: modeChoice !== 'unset' && modeForever
			});

			if (result.ok === false) {
				throw new Error(result.error ?? '');
			}

			modeOpen = false;

			const message = result.data?.disconnected
				? t('web.playerDetail.loginModeSetDisconnected', { name: username })
				: t('web.playerDetail.loginModeSet', { name: username });

			note.set({ level: 'success', message, closeable: true });

			await onchanged();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.playerDetail.couldNotSetLoginMode'),
				detail: (err as Error).message,
				closeable: true
			});
		}

		modeBusy = false;
	}

	/** Have luna-auth forget its cached verdict on the name and ask Mojang now. */
	async function doPremiumCheck(): Promise<void> {
		premiumBusy = true;

		const note = Notify.loading(t('web.playerDetail.checkingWithMojang', { name: username }));

		try {
			const result = await post(path, { action: 'premium-check' });

			if (result.ok === false) {
				throw new Error(result.error ?? '');
			}

			note.set({
				level: 'success',
				message: t('web.playerDetail.checkedWithMojang', { name: username }),
				closeable: true
			});

			await onchanged();
		} catch (err) {
			note.set({
				level: 'error',
				message: t('web.playerDetail.couldNotCheckWithMojang'),
				detail: (err as Error).message,
				closeable: true
			});
		}

		premiumBusy = false;
	}

	const modeChoices = $derived([
		{ value: 'online', label: t('web.playerDetail.loginModeOnline') },
		{ value: 'offline', label: t('web.playerDetail.loginModeOffline') },
		{ value: 'unset', label: t('web.playerDetail.loginModeUnset') }
	]);
</script>

{#if show}
	{#if !available}
		<Flash kind="warning">
			<b>{t('web.playerDetail.lunaAuthIsNot')}</b>
			{t('web.playerDetail.authDownDetail', { problem })}
		</Flash>
	{:else if auth}
		{#if auth.temporaryPasswordExpired}
			<Flash kind="warning">{t('web.playerDetail.tempExpiredNotice')}</Flash>
		{:else if auth.temporaryPassword}
			<Flash kind="info">
				{t('web.playerDetail.tempActiveNotice', { date: fmtDateTime(auth.temporaryPasswordUntilEpochMillis) })}
			</Flash>
		{:else if !auth.registered}
			<Flash kind="info">{t('web.playerDetail.neverRegisteredNotice')}</Flash>
		{/if}

		<Panel
			title={t('web.playerDetail.authentication')}
			description={t('web.playerDetail.heldByLunaAuthOn')}
		>
			{#snippet actions()}
				<Dropdown label={t('web.playerDetail.accountActions')} menu={menu()} />
			{/snippet}

			<InfoGrid cells={authCells} columns={[4, 2, 1]}>
				{#snippet custom(cell)}
					{#if cell.id === 'password' && auth?.registered && auth.temporaryPassword}
						{@const split = tSplit('web.playerDetail.passwordTemporaryUntil', 'date')}
						{split.before}<DateTime
							at={auth.temporaryPasswordUntilEpochMillis}
							text={fmtDateTime(auth.temporaryPasswordUntilEpochMillis)}
						/>{split.after}
					{:else if cell.id === 'lock' && auth?.locked}
						{@const split = tSplit('web.playerDetail.lockedUntil', 'date')}
						{split.before}<DateTime
							at={auth.lockedUntilEpochMillis}
							text={fmtDateTime(auth.lockedUntilEpochMillis)}
						/>{split.after}
					{:else if cell.id === 'session' && auth?.session.hasSession}
						{@const split = tSplit('web.playerDetail.sessionUntil', 'date')}
						{split.before}<DateTime
							at={auth.session.expiresAtEpochMillis}
							text={fmtDateTime(auth.session.expiresAtEpochMillis)}
						/>{split.after}
					{:else}
						{cell.value}
					{/if}
				{/snippet}
			</InfoGrid>
		</Panel>

		{#if auth.loginMode}
			{#if auth.loginMode.proxyOnlineMode}
				<Flash kind="info">{t('web.playerDetail.loginModeProxyOnline')}</Flash>
			{:else if !auth.loginMode.mixedMode}
				<Flash kind="info">{t('web.playerDetail.loginModeMixedOff')}</Flash>
			{/if}

			<Panel
				title={t('web.playerDetail.loginMode')}
				description={t('web.playerDetail.loginModeDesc')}
			>
				{#snippet actions()}
					<Btn icon="rotate" loading={premiumBusy} disabled={premiumBusy} onclick={doPremiumCheck}>
						{t('web.playerDetail.checkWithMojang')}
					</Btn>
					<Btn
						variant="primary"
						icon="userShield"
						disabled={auth?.loginMode?.proxyOnlineMode || !auth?.loginMode?.mixedMode}
						onclick={openLoginMode}
					>
						{t('web.playerDetail.changeLoginMode')}
					</Btn>
				{/snippet}

				<InfoGrid cells={loginModeCells} columns={[4, 2, 1]}>
					{#snippet custom(cell)}
						{#if cell.id === 'preference' && auth?.loginMode?.preference && !auth.loginMode.preference.rememberForever}
							{@const preference = auth.loginMode.preference}
							{@const split = tSplit('web.playerDetail.loginModeUntil', 'date', { mode: modeLabel(preference.mode) })}
							{split.before}<DateTime
								at={preference.expiresAtEpochMillis}
								text={fmtDateTime(preference.expiresAtEpochMillis)}
							/>{split.after}
						{:else if cell.id === 'premium' && auth?.loginMode && auth.loginMode.premium.checkedAtEpochMillis && DATED_PREMIUM_SOURCES.has(auth.loginMode.premium.source)}
							{@const premium = auth.loginMode.premium}
							{@const split = tSplit(PREMIUM_SOURCES[premium.source] ?? '', 'date', { error: premium.error })}
							{premiumVerdict(auth.loginMode)} · {split.before}<DateTime
								at={premium.checkedAtEpochMillis}
								text={fmtDateTime(premium.checkedAtEpochMillis)}
							/>{split.after}
						{:else}
							{cell.value}
						{/if}
					{/snippet}
				</InfoGrid>
			</Panel>
		{:else}
			<Flash kind="info">{t('web.playerDetail.loginModeUnavailable')}</Flash>
		{/if}
	{/if}
{/if}

<ConfirmModal
	bind:open={resetOpen}
	title={t('web.playerDetail.resetTitle', { name: username })}
	lead={t('web.playerDetail.resetLead', { name: username })}
	notes={[t('web.playerDetail.ifTheyNeedTo')]}
	confirmLabel={t('web.playerDetail.resetPassword')}
	onconfirm={doReset}
/>

<Modal title={t('web.playerDetail.tempTitle', { name: username })} bind:open={tempOpen}>
	<label class="field">
		<span class="lbl">{t('web.playerDetail.password')}</span>
		<span class="hint">
			{t('web.playerDetail.leaveEmptyAndThe')}
		</span>
		<input class="input mono" bind:value={tempPassword} placeholder={t('web.playerDetail.generateOneForMe')} />
	</label>

	<div class="field">
		<span class="lbl">{t('web.playerDetail.validFor')}</span>
		<span class="hint">
			{t('web.playerDetail.whenItExpiresThe')}
		</span>
		<Select bind:value={tempMinutes} width="100%" options={tempLifetimes} />
	</div>

	{#if auth?.online}
		<p class="dim">{t('web.playerDetail.tempDisconnects', { name: username })}</p>
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (tempOpen = false)}>{t('web.playerDetail.cancel')}</Btn>
		<Btn
			variant="primary"
			disabled={tempBusy || (tempPassword.trim().length > 0 && tempPassword.trim().length < 6)}
			loading={tempBusy}
			onclick={doTemporary}
		>
			{t('web.playerDetail.issuePassword')}
		</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.playerDetail.loginModeDialogTitle', { name: username })} bind:open={modeOpen}>
	<div class="field">
		<span class="lbl">{t('web.playerDetail.loginModeField')}</span>
		<span class="hint">{t('web.playerDetail.loginModeFieldHint')}</span>
		<Select bind:value={modeChoice} width="100%" options={modeChoices} />
	</div>

	{#if modeChoice !== 'unset'}
		<label class="force">
			<Checkbox
				checked={modeForever}
				label={t('web.playerDetail.loginModeKeep')}
				onchange={(value: boolean) => (modeForever = value)}
			/>
			<span>
				{t('web.playerDetail.loginModeKeep')}
				<span class="dim">
					{t('web.playerDetail.loginModeKeepHint', { hours: String(auth?.loginMode?.preferenceHours ?? 24) })}
				</span>
			</span>
		</label>
	{/if}

	{#if modeReconnects}
		<p class="dim">
			{t('web.playerDetail.loginModeReconnectNote', {
				name: username,
				current: modeLabel(auth?.loginMode?.current ?? '')
			})}
		</p>
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (modeOpen = false)}>{t('web.playerDetail.cancel')}</Btn>
		<Btn variant="primary" disabled={modeBusy} loading={modeBusy} onclick={doLoginMode}>
			{t('web.playerDetail.loginModeApply')}
		</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.playerDetail.temporaryPasswordIssued')} bind:open={issuedOpen}>
	<p>{t('web.playerDetail.issuedLead', { name: username })}</p>
	<div class="issued">
		<code>{issuedPassword}</code>
		<Btn icon="copy" onclick={() => void copyText(issuedPassword)}>{t('web.playerDetail.copy')}</Btn>
	</div>
	{#snippet footer()}
		<Btn variant="primary" onclick={() => (issuedOpen = false)}>{t('web.playerDetail.done')}</Btn>
	{/snippet}
</Modal>

<style lang="scss">
	.force {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin-top: 0.75rem;
		font-size: 0.875rem;

		.dim {
			display: block;
			margin-top: 0.125rem;
			font-size: 0.8125rem;
		}
	}

	// the one moment the password is readable, so it is given the room to be read
	.issued {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-top: 1rem;

		code {
			flex: 1;
			background: var(--bg-terminal);
			border-radius: 0.375rem;
			padding: 0.75rem 1rem;
			font-family: var(--font-mono);
			font-size: 1.25rem;
			letter-spacing: 0.125rem;
			user-select: all;
		}
	}
</style>
