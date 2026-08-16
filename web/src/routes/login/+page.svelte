<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { api, post, del } from '$lib/api';
	import Btn from '$lib/components/Btn.svelte';
	import Checkbox from '$lib/components/Checkbox.svelte';
	import Flash from '$lib/components/Flash.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import LunaBanner from '$lib/components/LunaBanner.svelte';
	import LunaMark from '$lib/components/LunaMark.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import { LANGUAGES, currentLanguage, switchLanguage } from '$lib/i18n.svelte';

	/**
	 * The console's sign-in screen: the only page reachable without a session.
	 *
	 * The layout follows the AWS console's, because that shape is what the rest of
	 * this console is modelled on and an operator arriving here should recognise
	 * it: a centred logo, a narrow credentials card, and a banner panel beside it
	 * carrying the brand. The banner is the plate from `docs/console.svg`, and a
	 * washed copy of it is the page's own background.
	 *
	 * Three states, not one. A console with no accounts cannot ask anyone to sign
	 * in, so it offers the first-run form instead; and an account whose password was
	 * reset is asked to choose a new one before it goes anywhere, because that is the
	 * only moment the flag can be cleared with the old password still in hand.
	 */

	type Mode = 'signin' | 'bootstrap' | 'renew';

	const REMEMBER_KEY = 'luna:lastUser';

	let mode = $state<Mode>('signin');
	let ready = $state(false);

	let username = $state('');
	let password = $state('');
	let confirm = $state('');
	let showPassword = $state(false);
	let remember = $state(false);
	let busy = $state(false);
	let problem = $state('');

	/** Set once a sign-in landed on an account that must choose a new password. */
	let renewFor = $state<{ id: string; username: string } | null>(null);

	/**
	 * The password the session was opened with. Held only for the renew step, which
	 * needs it as the "current" password, and only in memory for that one hop.
	 */
	let sessionPassword = $state('');

	/** Where the gate wanted to go before it bounced us here. */
	const next = $derived(page.url.searchParams.get('next') || '/instances');

	let userField = $state<HTMLInputElement | undefined>();
	let passwordField = $state<HTMLInputElement | undefined>();

	onMount(async () => {
		const saved = localStorage.getItem(REMEMBER_KEY);

		if (saved) {
			username = saved;
			remember = true;
		}

		try {
			const state = await api('/auth/session');

			mode = state.bootstrap ? 'bootstrap' : 'signin';
		} catch (err) {
			// the daemon being down is the interesting case here: without it there is
			// nothing to authenticate against, and saying so beats an empty form
			problem = (err as Error).message;
		}

		ready = true;

		// focus the field the operator actually has to fill in
		if (username && passwordField) {
			passwordField.focus();
		} else {
			userField?.focus();
		}
	});

	const canSubmit = $derived.by(() => {
		if (busy) {
			return false;
		}

		if (mode === 'renew') {
			return !!password && password === confirm;
		}

		if (mode === 'bootstrap') {
			return !!username && !!password && password === confirm;
		}

		return !!username && !!password;
	});

	/** The mismatch is worth saying before the button is pressed, not after. */
	const mismatch = $derived(mode !== 'signin' && !!confirm && password !== confirm);

	function rememberUsername(name: string): void {
		if (remember) {
			localStorage.setItem(REMEMBER_KEY, name);
		} else {
			localStorage.removeItem(REMEMBER_KEY);
		}
	}

	/** Leave for the page the gate bounced us from, with a real navigation. */
	function enterConsole(): void {
		// a full load, not a client-side goto: every layout on the far side of the
		// gate loads its data server-side, and they were all skipped while there was
		// no session
		location.href = next;
	}

	async function signIn(): Promise<void> {
		busy = true;
		problem = '';

		try {
			const result = await post('/auth/session', { username, password });

			rememberUsername(result.account.username);

			if (result.account.mustChangePassword) {
				renewFor = { id: result.account.id, username: result.account.username };
				mode = 'renew';
				confirm = '';
				busy = false;

				return;
			}

			enterConsole();
		} catch (err) {
			problem = (err as Error).message;
			password = '';
			busy = false;
			passwordField?.focus();
		}
	}

	async function createFirst(): Promise<void> {
		busy = true;
		problem = '';

		try {
			const result = await post('/auth/bootstrap', { username, password });

			rememberUsername(result.account.username);
			enterConsole();
		} catch (err) {
			problem = (err as Error).message;
			busy = false;
		}
	}

	/**
	 * Clear the must-change flag with the password the sign-in just used. The
	 * session is already open, so this is the account changing its own password,
	 * which is exactly what the route wants to see.
	 */
	async function renewPassword(): Promise<void> {
		busy = true;
		problem = '';

		try {
			await post(`/accounts/${renewFor!.id}/password`, {
				current: sessionPassword,
				password
			});

			enterConsole();
		} catch (err) {
			problem = (err as Error).message;
			busy = false;
		}
	}

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();

		if (!canSubmit) {
			return;
		}

		if (mode === 'bootstrap') {
			await createFirst();

			return;
		}

		if (mode === 'renew') {
			await renewPassword();

			return;
		}

		sessionPassword = password;

		await signIn();
	}

	/** Back out of a half-finished renewal: the session is open, so it is a sign-out. */
	async function abandonRenewal(): Promise<void> {
		await del('/auth/session').catch(() => {});

		renewFor = null;
		mode = 'signin';
		password = '';
		confirm = '';
		sessionPassword = '';
		problem = '';
	}

	const heading = $derived.by(() => {
		if (mode === 'bootstrap') {
			return t('web.login.bootstrapTitle');
		}

		if (mode === 'renew') {
			return t('web.login.renewTitle');
		}

		return t('web.login.title');
	});
</script>

<svelte:head><title>{t('web.login.title')} | Luna Console</title></svelte:head>

<div class="login">
	<div class="wash" aria-hidden="true">
		<LunaBanner viewBox="0 0 3186 1039" radius="0" marks={false} />
	</div>

	<header class="top">
		<span class="spacer"></span>
		<!-- the one thing on this screen somebody without an account can actually
		     use; a player who followed a link here should not hit a dead end -->
		<a class="tolink" href="/public">
			<Icon name="globe" size="0.75rem" style="solid" />
			<span>{t('web.login.publicPage')}</span>
		</a>
		<label class="langpick">
			<Icon name="globe" size="0.75rem" style="solid" />
			<select
				value={currentLanguage()}
				onchange={(event) => switchLanguage(event.currentTarget.value as 'en' | 'vi')}
			>
				{#each LANGUAGES as lang}
					<option value={lang.code}>{lang.label}</option>
				{/each}
			</select>
		</label>
	</header>

	<div class="brand">
		<LunaMark size="2.5rem" glyph="1.625rem" />
		<span class="wordmark">luna</span>
	</div>

	<div class="cols">
		<section class="card">
			<h1>
				{heading}
				<span
					class="hint"
					title={mode === 'bootstrap'
						? t('web.login.bootstrapHint')
						: t('web.login.signInHint')}
				>
					<Icon name="circleInfo" size="0.875rem" style="solid" />
				</span>
			</h1>

			{#if !ready}
				<p class="checking"><Spinner size="0.875rem" /> {t('web.login.checking')}</p>
			{:else}
				{#if mode === 'bootstrap'}
					<Flash kind="warning">{t('web.login.bootstrapNotice')}</Flash>
				{/if}

				{#if mode === 'renew'}
					<Flash kind="info">
						{t('web.login.renewNotice', { name: renewFor?.username ?? '' })}
					</Flash>
				{/if}

				{#if problem}
					<Flash kind="error">{problem}</Flash>
				{/if}

				<form onsubmit={submit}>
					{#if mode !== 'renew'}
						<label class="field">
							<span class="lbl">{t('web.login.username')}</span>
							<input
								bind:this={userField}
								class="input"
								type="text"
								autocomplete="username"
								spellcheck="false"
								autocapitalize="none"
								bind:value={username}
								disabled={busy}
							/>
						</label>

						{#if mode === 'signin'}
							<label class="check">
								<Checkbox
									checked={remember}
									onchange={(value) => (remember = value)}
									label={t('web.login.remember')}
								/>
								<span>{t('web.login.remember')}</span>
							</label>
						{/if}
					{/if}

					<label class="field">
						<span class="lbl">
							{mode === 'signin' ? t('web.login.password') : t('web.login.newPassword')}
						</span>
						<input
							bind:this={passwordField}
							class="input"
							type={showPassword ? 'text' : 'password'}
							autocomplete={mode === 'signin' ? 'current-password' : 'new-password'}
							bind:value={password}
							disabled={busy}
						/>
					</label>

					{#if mode !== 'signin'}
						<label class="field">
							<span class="lbl">{t('web.login.confirmPassword')}</span>
							<input
								class="input"
								type={showPassword ? 'text' : 'password'}
								autocomplete="new-password"
								bind:value={confirm}
								disabled={busy}
							/>
							{#if mismatch}<span class="err">{t('web.login.mismatch')}</span>{/if}
						</label>
					{/if}

					<label class="check">
						<Checkbox
							checked={showPassword}
							onchange={(value) => (showPassword = value)}
							label={t('web.login.showPassword')}
						/>
						<span>{t('web.login.showPassword')}</span>
					</label>

					<div class="go">
						<Btn variant="primary" type="submit" disabled={!canSubmit} loading={busy}>
							{mode === 'signin'
								? t('web.login.signIn')
								: mode === 'bootstrap'
									? t('web.login.createAccount')
									: t('web.login.setPassword')}
						</Btn>
					</div>

					{#if mode === 'renew'}
						<div class="go">
							<Btn onclick={abandonRenewal} disabled={busy}>{t('web.login.cancelRenew')}</Btn>
						</div>
					{/if}
				</form>
			{/if}

			<p class="fine">{t('web.login.fineprint')}</p>
		</section>

		<!-- The plate is 3:1 and this panel is not, so the panel frames one part of the
		     composition. The window sits *inside* the artwork's inset rectangle (x 64
		     to 3122, y 64 to 975) so its edges never cross that frame, and it is
		     centred on the largest star. The corner squares are dropped at this size:
		     they are registration marks on a banner metres wide, and here they read as
		     artefacts rather than as design. -->
		<aside class="promo">
			<LunaBanner viewBox="960 64 1200 911" marks={false}>
				<div class="promotext">
					<h2>{t('web.login.bannerTitle')}</h2>
					<p>{t('web.login.bannerBody')}</p>
					<span class="who">
						<Icon name="hardDrive" size="0.875rem" style="solid" />
						{t('web.login.bannerFoot')}
					</span>
				</div>
			</LunaBanner>
		</aside>
	</div>
</div>

<style lang="scss">
	// the whole viewport is the screen: there is no chrome on this page, because
	// none of it would have anything to talk to yet
	.login {
		position: relative;
		min-height: 100vh;
		background: var(--bg-body);
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 0 1.5rem 3rem;
		overflow: hidden;
	}

	// the banner plate again, full-bleed and almost entirely faded out; enough for
	// the violet to be present in the page without competing with the card
	.wash {
		position: absolute;
		inset: 0;
		opacity: 0.35;
		pointer-events: none;

		&::after {
			content: '';
			position: absolute;
			inset: 0;
			background: linear-gradient(180deg, rgb(15 20 26 / 55%), rgb(15 20 26 / 92%));
		}
	}

	.top {
		position: relative;
		width: 100%;
		display: flex;
		align-items: center;
		gap: 1rem;
		height: 3rem;
		font-size: 0.75rem;
	}

	.spacer {
		flex: 1;
	}

	// sits with the language picker rather than being styled as a link: this is
	// page chrome, and chrome opts out of the underline body links carry
	.tolink {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--text);
		font-size: 0.6875rem;
		text-decoration: none;

		&:hover {
			color: var(--link);
		}

		&:focus-visible {
			@include focus-ring;
		}
	}

	// same treatment as the status bar's picker, so the control is recognisably
	// the console's and not something this page invented
	.langpick {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--text);
		font-size: 0.6875rem;

		select {
			background: transparent;
			border: none;
			color: var(--text);
			font-size: 0.6875rem;
			cursor: pointer;

			&:hover {
				color: var(--link);
			}

			option {
				background: var(--bg-panel);
				color: var(--text);
			}
		}
	}

	.brand {
		position: relative;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin: 1.5rem 0 2rem;
	}

	.wordmark {
		color: var(--text-heading);
		font-size: 1.75rem;
		font-weight: 700;
		letter-spacing: -0.02em;
	}

	// card and banner are one centred group, as they are on the screen this is
	// modelled on; the card keeps its width and the banner is what gives first
	.cols {
		position: relative;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		gap: 1.25rem;
		width: 100%;

		@include below($bp-medium) {
			flex-direction: column;
			align-items: center;
		}
	}

	.card {
		width: 21rem;
		flex: none;
		background: var(--bg-panel);
		border: 0.1rem solid var(--border-divider);
		border-radius: var(--radius-container);
		box-shadow: var(--shadow-panel);
		padding: 1.25rem;

		h1 {
			display: flex;
			align-items: center;
			gap: 0.5rem;
			font-size: 1.125rem;
			margin-bottom: 1rem;
		}
	}

	.hint {
		color: var(--link);
		display: inline-flex;
		cursor: help;
	}

	.checking {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.8125rem;
	}

	// a checkbox and its own label; the field's `.lbl` is for the input above it
	.check {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: -0.375rem 0 0.875rem;
		font-size: 0.8125rem;
		cursor: pointer;
	}

	// the submit button spans the card, which is what makes it read as the one
	// thing this screen is for
	.go {
		margin-top: 0.75rem;

		:global(.btn) {
			width: 100%;
		}
	}

	.fine {
		margin: 1rem 0 0;
		color: var(--text-secondary);
		font-size: 0.6875rem;
		line-height: 1.4;
	}

	.promo {
		width: 28rem;
		height: 22rem;
		flex: none;

		@include below($bp-medium) {
			width: 21rem;
			height: 11rem;
		}
	}

	.promotext {
		height: 100%;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		gap: 0.75rem;
		padding: 2rem;
		color: #fff;

		h2 {
			color: #fff;
			font-size: 1.5rem;
			line-height: 1.2;
			max-width: 18rem;
		}

		p {
			margin: 0;
			font-size: 0.875rem;
			line-height: 1.5;
			max-width: 22rem;
			color: rgb(255 255 255 / 82%);
		}

		@include below($bp-medium) {
			padding: 1.25rem;

			h2 {
				font-size: 1.125rem;
			}

			p {
				display: none;
			}
		}
	}

	.who {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.75rem;
		color: rgb(255 255 255 / 70%);
	}
</style>
