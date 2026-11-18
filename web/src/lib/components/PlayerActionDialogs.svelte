<!-- Copyright (c) 2026 Belikhun. All rights reserved.
     Proprietary software: use, copying, modification and distribution are
     prohibited without written permission. See LICENSE at the repository root. -->

<script lang="ts">
	import { t } from '$lib/i18n.svelte';
	import { post } from '$lib/api';
	import {
		MOB_EFFECTS,
		banAddressOnNetwork,
		bareAddress,
		effectLabel,
		giveEffect,
		lunaAdmin,
		resendPacks,
		setChatChannel,
		setGameMode as setGameModeOn,
		targetSummary
	} from '$lib/playeractions';
	import type { ModerationAction, PlayerActionTarget, PlayerDialogKind } from '$lib/playeractions';
	import type { GameMode } from '$core/playerdata';
	import type { ChatChannelType } from '$core/services/luna';
	import { CHAT_CHANNEL_LABEL } from '$lib/chatchannel';
	import { Notify } from '$lib/notifications.svelte';
	import Btn from './Btn.svelte';
	import Checkbox from './Checkbox.svelte';
	import ConfirmModal from './ConfirmModal.svelte';
	import Modal from './Modal.svelte';
	import MultiSelect from './MultiSelect.svelte';
	import PlayerPicker from './PlayerPicker.svelte';
	import Select from './Select.svelte';

	/**
	 * The dialogs behind the player verbs, and the verbs themselves: message,
	 * move, disconnect, resend packs, chat channel, game mode, the access lists
	 * and both kinds of ban. Every screen with a player menu mounts one and calls `open`, so a
	 * verb asks the same question and reports the same way wherever it is used.
	 *
	 * With `instance` set the access verbs act on that server alone and need no
	 * question; without it they ask which servers first.
	 */
	let {
		instance,
		servers = [],
		instances = [],
		ondone
	}: {
		/** The server the access verbs are scoped to; absent on the network screens */
		instance?: string;
		/** Backends a player can be moved to */
		servers?: string[];
		/** Backends the access verbs can target, offered when there is no `instance` */
		instances?: string[];
		/** Runs after a verb settles, so the screen can re-read what it shows */
		ondone?: () => void | Promise<void>;
	} = $props();

	interface Failure {
		who: string;
		error: string;
	}

	let pending: PlayerActionTarget[] = $state([]);

	let messageOpen = $state(false);
	let messageText = $state('');
	let transferOpen = $state(false);
	let transferTo = $state('');
	let kickOpen = $state(false);
	let kickReason = $state('');
	let kickForce = $state(false);
	let banOpen = $state(false);
	let banReason = $state('');
	let ipBanOpen = $state(false);
	let ipBanReason = $state('');
	let directOpen = $state(false);
	let directTo = $state('');
	let directName = $state('');

	// the picker's value; OTHER_EFFECT swaps in the free-text id field
	const OTHER_EFFECT = '__other';

	let effectOpen = $state(false);
	let effectPick = $state('minecraft:speed');
	let effectCustom = $state('');
	let effectLevel = $state(1);
	let effectSeconds = $state(60);
	let effectForever = $state(false);
	let effectHide = $state(false);

	const effectOptions = $derived([
		...MOB_EFFECTS
			.map((id) => ({ value: `minecraft:${id}`, label: effectLabel(id) }))
			.sort((a, b) => a.label.localeCompare(b.label)),
		{ value: OTHER_EFFECT, label: t('web.instancePlayers.effectOther') }
	]);

	const effectId = $derived(
		effectPick === OTHER_EFFECT
			? effectCustom.trim().toLowerCase()
			: effectPick
	);

	// a namespaced id the command parser takes: letters, digits, `_ - . /`, one optional namespace
	const effectValid = $derived(/^([a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(effectId));

	const effectReady = $derived(
		effectValid
		&& Number.isInteger(effectLevel) && effectLevel >= 1 && effectLevel <= 256
		&& (effectForever || (Number.isFinite(effectSeconds) && effectSeconds >= 1))
	);
	let moderateOpen = $state(false);
	let moderateAction: ModerationAction = $state('ban');
	let moderateInstances: string[] = $state([]);
	let moderateReason = $state('');

	const who = $derived(targetSummary(pending));

	/** A move never offers the backend every target is already on. */
	const destinations = $derived.by(() => {
		const current = new Set(pending.map((target) => target.server ?? ''));
		const only = current.size === 1
			? [...current][0]
			: '';

		return servers.filter((name) => name !== only && name !== instance);
	});

	/**
	 * Open the dialog for a verb, or run it when it asks nothing.
	 *
	 * @param kind the verb
	 * @param targets the players it acts on
	 */
	export function open(kind: PlayerDialogKind, targets: PlayerActionTarget[]): void {
		if (targets.length === 0) {
			return;
		}

		pending = targets;

		switch (kind) {
			case 'message':
				messageText = '';
				messageOpen = true;
				break;

			case 'transfer':
				transferTo = destinations[0] ?? '';
				transferOpen = true;
				break;

			case 'kick':
			case 'force':
				kickForce = kind === 'force';
				kickReason = '';
				kickOpen = true;
				break;

			case 'resend':
				void doResend(targets);
				break;

			case 'effect':
				effectOpen = true;
				break;

			case 'ipban':
				ipBanReason = '';
				ipBanOpen = true;
				break;

			case 'channel-network':
				void doChannel(targets, 'network');
				break;

			case 'channel-server':
				void doChannel(targets, 'server');
				break;

			case 'channel-direct':
				directTo = '';
				directName = '';
				directOpen = true;
				break;

			default:
				openModeration(kind, targets);
		}
	}

	/**
	 * Set the targets' game mode on the scoped server.
	 *
	 * @param targets the connected players to change
	 * @param mode the game mode to put them in
	 */
	export function setGameMode(targets: PlayerActionTarget[], mode: GameMode): void {
		const server = instance;

		if (!server || targets.length === 0) {
			return;
		}

		const names = targetSummary(targets);

		void report(
			t('web.instancePlayers.settingGameMode', { targets: names }),
			t('web.instancePlayers.gameModeSet', { targets: names, mode: t(`web.instancePlayers.mode.${mode}`) }),
			targets.length,
			async () => {
				await setGameModeOn(server, targets, mode);

				return [];
			}
		);
	}

	function openModeration(action: ModerationAction, targets: PlayerActionTarget[]): void {
		moderateAction = action;

		if (instance !== undefined) {
			// a ban is the one scoped verb worth a question: it takes a reason
			if (action === 'ban') {
				banReason = '';
				banOpen = true;
			} else {
				void moderate(action, targets, [instance], '');
			}

			return;
		}

		moderateInstances = [...instances];
		moderateReason = '';
		moderateOpen = true;
	}

	/**
	 * Run a verb, say how it went and let the screen re-read. A verb over several
	 * players answers with the ones it failed for, so a partial result names them
	 * instead of reading as a success or as a total failure.
	 */
	function doEffect(): void {
		const server = instance;
		const targets = pending;

		if (!server || targets.length === 0 || !effectReady) {
			return;
		}

		effectOpen = false;

		const names = targetSummary(targets);
		const effect = effectLabel(effectId);

		const grant = {
			effect: effectId,
			level: effectLevel,
			seconds: effectForever
				? null
				: effectSeconds,
			hideParticles: effectHide
		};

		void report(
			t('web.instancePlayers.givingEffect', { effect, targets: names }),
			t('web.instancePlayers.effectGiven', { effect, targets: names }),
			targets.length,
			async () => {
				await giveEffect(server, targets, grant);

				return [];
			}
		);
	}

	async function report(
		busy: string,
		done: string,
		total: number,
		work: () => Promise<Failure[]>
	): Promise<void> {
		const note = Notify.loading(busy);

		try {
			const failed = await work();
			const detail = failed.map((failure) => `${failure.who}: ${failure.error}`).join('\n');

			if (failed.length === 0) {
				note.set({ level: 'success', message: done, closeable: true });
			} else if (failed.length < total) {
				note.set({
					level: 'warning',
					message: t('web.playerActions.partial', { done: total - failed.length, total }),
					detail,
					closeable: true
				});
			} else {
				note.set({ level: 'error', message: busy, detail, closeable: true });
			}
		} catch (err) {
			note.set({ level: 'error', message: busy, detail: (err as Error).message, closeable: true });
		}

		await ondone?.();
	}

	/** One proxy action per target, each failure kept beside the name it belongs to. */
	async function eachTarget(
		targets: PlayerActionTarget[],
		work: (target: PlayerActionTarget) => Promise<unknown>
	): Promise<Failure[]> {
		const failed: Failure[] = [];

		for (const target of targets) {
			try {
				await work(target);
			} catch (err) {
				failed.push({ who: target.username, error: (err as Error).message });
			}
		}

		return failed;
	}

	async function doMessage(): Promise<void> {
		const targets = pending;
		const text = messageText.trim();

		messageOpen = false;

		if (!text) {
			return;
		}

		await report(
			t('web.instancePlayers.sendingMessage', { targets: who }),
			t('web.instancePlayers.messageDelivered', { targets: who }),
			targets.length,
			() => eachTarget(targets, (target) => lunaAdmin({ action: 'message', player: target.uuid, message: text }))
		);
	}

	async function doTransfer(): Promise<void> {
		const targets = pending;
		const server = transferTo;

		transferOpen = false;

		if (!server) {
			return;
		}

		await report(
			t('web.instancePlayers.moving', { targets: who, server }),
			t('web.instancePlayers.moved', { targets: who, server }),
			targets.length,
			() => eachTarget(targets, (target) => lunaAdmin({ action: 'transfer', player: target.uuid, server }))
		);
	}

	async function doKick(): Promise<void> {
		const targets = pending;
		const reason = kickReason.trim();

		// a kick waits for the client to take its packet; a forced one closes the connection outright
		const action = kickForce
			? 'disconnect'
			: 'kick';

		kickOpen = false;

		await report(
			t('web.instancePlayers.disconnecting', { targets: who }),
			t('web.instancePlayers.disconnected', { targets: who }),
			targets.length,
			() => eachTarget(targets, (target) => lunaAdmin({ action, player: target.uuid, reason }))
		);
	}

	async function doResend(targets: PlayerActionTarget[]): Promise<void> {
		const names = targetSummary(targets);

		await report(
			t('web.instancePlayers.resendingPacks', { targets: names }),
			t('web.instancePlayers.resentPacks', { targets: names }),
			targets.length,
			async () => {
				await resendPacks(targets);

				return [];
			}
		);
	}

	/**
	 * Put each target in a chat channel. The proxy tells each player in game, and
	 * a target already in that channel is left alone and still counts as done.
	 */
	async function doChannel(
		targets: PlayerActionTarget[],
		channel: ChatChannelType,
		recipient = '',
		recipientName = ''
	): Promise<void> {
		const names = targetSummary(targets);
		const label = recipientName
			? `${t(CHAT_CHANNEL_LABEL[channel])} (${recipientName})`
			: t(CHAT_CHANNEL_LABEL[channel]);

		await report(
			t('web.chatChannel.setting', { targets: names }),
			t('web.chatChannel.setDone', { targets: names, channel: label }),
			targets.length,
			() => eachTarget(targets, (target) => setChatChannel(target, channel, recipient))
		);
	}

	function doDirect(): void {
		const recipient = directTo.trim();

		directOpen = false;

		if (!recipient) {
			return;
		}

		void doChannel(pending, 'direct', recipient, directName || recipient);
	}

	async function doIpBan(): Promise<void> {
		const targets = pending;
		const reason = ipBanReason.trim();

		ipBanOpen = false;

		await report(
			t('web.instancePlayers.ipBanning', { targets: who }),
			t('web.instancePlayers.ipBanned', { targets: who }),
			targets.length,
			() => eachTarget(targets, (target) => banAddressOnNetwork(bareAddress(target.address ?? ''), reason))
		);
	}

	function doScopedBan(): void {
		banOpen = false;

		if (instance !== undefined) {
			void moderate('ban', pending, [instance], banReason.trim());
		}
	}

	function doModerate(): void {
		moderateOpen = false;

		void moderate(moderateAction, pending, moderateInstances, moderateReason.trim());
	}

	/**
	 * One access-list verb over every target on every chosen server. The route
	 * fans the pairs out and records each in the player's moderation log; a pair
	 * a live server accepted but has not written yet is reported apart, since it
	 * is neither a failure nor confirmed.
	 */
	async function moderate(
		action: ModerationAction,
		targets: PlayerActionTarget[],
		onInstances: string[],
		reason: string
	): Promise<void> {
		const label = t(`web.instancePlayers.verb.${action}`);
		const names = targetSummary(targets);
		const note = Notify.loading(t('web.instancePlayers.updatingLists'));

		try {
			const result = await post('/players/moderate', {
				action,
				targets: targets.map((target) => ({ name: target.username, uuid: target.uuid })),
				instances: onInstances,
				reason
			});

			const outcomes: Array<{
				ok: boolean;
				verified?: boolean;
				target: string;
				instance: string;
				error?: string;
			}> = result.outcomes ?? [];

			const place = (outcome: { target: string; instance: string }): string =>
				outcome.instance
					? `${outcome.target} @ ${outcome.instance}`
					: outcome.target;

			const failed = outcomes.filter((outcome) => !outcome.ok);
			const unconfirmed = outcomes.filter((outcome) => outcome.ok && outcome.verified === false);

			if (failed.length > 0) {
				note.set({
					level: failed.length < outcomes.length ? 'warning' : 'error',
					message: t('web.players.partialSucceeded', {
						label,
						ok: outcomes.length - failed.length,
						total: outcomes.length
					}),
					detail: failed.map((outcome) => `${place(outcome)}: ${outcome.error ?? ''}`).join('\n'),
					closeable: true
				});
			} else if (unconfirmed.length > 0) {
				note.set({
					level: 'warning',
					message: t('web.players.someUnconfirmed', { label, count: unconfirmed.length }),
					detail: unconfirmed.map(place).join('\n'),
					closeable: true
				});
			} else {
				note.set({
					level: 'success',
					message: t('web.instancePlayers.applied', { action: label, targets: names }),
					closeable: true
				});
			}
		} catch (err) {
			note.set({ level: 'error', message: label, detail: (err as Error).message, closeable: true });
		}

		await ondone?.();
	}
</script>

<Modal title={t('web.instancePlayers.messageTitle', { targets: who })} bind:open={messageOpen}>
	<label class="field">
		<span class="lbl">{t('web.instancePlayers.message')}</span>
		<span class="hint">{t('web.instancePlayers.messageHint')}</span>
		<input class="input" bind:value={messageText} placeholder={t('web.instancePlayers.typeAMessage')} />
	</label>
	{#snippet footer()}
		<Btn onclick={() => (messageOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" disabled={!messageText.trim()} onclick={doMessage}>{t('web.instancePlayers.send')}</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.instancePlayers.moveTitle', { targets: who })} bind:open={transferOpen}>
	<p>{t('web.playersOnline.theProxyMovesThem')}</p>
	<div class="field">
		<span class="lbl">{t('web.instancePlayers.destination')}</span>
		<Select
			bind:value={transferTo}
			width="100%"
			options={destinations.map((name) => ({ value: name, label: name }))}
		/>
	</div>
	{#snippet footer()}
		<Btn onclick={() => (transferOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" disabled={!transferTo} onclick={doTransfer}>{t('web.instancePlayers.move')}</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.instancePlayers.disconnectTitle', { targets: who })} bind:open={kickOpen}>
	<p>{instance !== undefined ? t('web.instancePlayers.disconnectHint') : t('web.playersOnline.theyAreRemovedFrom')}</p>
	<label class="field">
		<span class="lbl">{t('web.instancePlayers.reasonShown')}</span>
		<span class="hint">{t('web.playersOnline.optionalLunacoreSendsIts')}</span>
		<input class="input" bind:value={kickReason} placeholder={t('web.playersOnline.eGRestartingTheLobby')} />
	</label>
	<label class="force">
		<Checkbox checked={kickForce} label={t('web.instancePlayers.force')} onchange={(on) => (kickForce = on)} />
		<span>
			{t('web.instancePlayers.force')}
			<span class="dim">{t('web.instancePlayers.forceHint')}</span>
		</span>
	</label>
	{#snippet footer()}
		<Btn onclick={() => (kickOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="danger" onclick={doKick}>{t('web.playersOnline.disconnect')}</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.instancePlayers.giveEffectTitle', { targets: who })} bind:open={effectOpen}>
	<p>{t('web.instancePlayers.giveEffectLead')}</p>
	<div class="field">
		<span class="lbl">{t('web.instancePlayers.effect')}</span>
		<Select bind:value={effectPick} width="100%" searchable options={effectOptions} />
	</div>
	{#if effectPick === OTHER_EFFECT}
		<label class="field">
			<span class="lbl">{t('web.instancePlayers.effectId')}</span>
			<span class="hint">{t('web.instancePlayers.effectIdHint')}</span>
			<input class="input mono" bind:value={effectCustom} placeholder="farmersdelight:comfort" />
		</label>
	{/if}
	<div class="pair">
		<label class="field">
			<span class="lbl">{t('web.instancePlayers.effectLevel')}</span>
			<input class="input" type="number" min="1" max="256" step="1" bind:value={effectLevel} />
		</label>
		<label class="field">
			<span class="lbl">{t('web.instancePlayers.effectSeconds')}</span>
			<input class="input" type="number" min="1" max="1000000" step="1" disabled={effectForever} bind:value={effectSeconds} />
		</label>
	</div>
	<label class="force">
		<Checkbox checked={effectForever} label={t('web.instancePlayers.effectForever')} onchange={(on) => (effectForever = on)} />
		<span>
			{t('web.instancePlayers.effectForever')}
			<span class="dim">{t('web.instancePlayers.effectForeverHint')}</span>
		</span>
	</label>
	<label class="force">
		<Checkbox checked={effectHide} label={t('web.instancePlayers.hideParticles')} onchange={(on) => (effectHide = on)} />
		<span>
			{t('web.instancePlayers.hideParticles')}
			<span class="dim">{t('web.instancePlayers.hideParticlesHint')}</span>
		</span>
	</label>
	{#snippet footer()}
		<Btn onclick={() => (effectOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn variant="primary" icon="flaskVial" disabled={!effectReady} onclick={doEffect}>{t('web.instancePlayers.give')}</Btn>
	{/snippet}
</Modal>

<Modal title={t('web.chatChannel.directTitle', { targets: who })} bind:open={directOpen}>
	<p>{t('web.chatChannel.directLead')}</p>
	<div class="field">
		<span class="lbl">{t('web.chatChannel.recipient')}</span>
		<span class="hint">{t('web.chatChannel.recipientHint')}</span>
		{#if directOpen}
			<PlayerPicker bind:value={directTo} onpick={(player) => (directName = player?.username ?? '')} />
		{/if}
	</div>
	{#snippet footer()}
		<Btn onclick={() => (directOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn
			variant="primary"
			icon="envelope"
			disabled={!directTo.trim()}
			title={!directTo.trim() ? t('web.chatChannel.pickRecipient') : undefined}
			onclick={doDirect}
		>
			{t('web.chatChannel.confirm')}
		</Btn>
	{/snippet}
</Modal>

<ConfirmModal
	bind:open={banOpen}
	title={t('web.instancePlayers.banTitle', { targets: who })}
	lead={t('web.instancePlayers.banLead', { instance: instance ?? '' })}
	notes={[t('web.instancePlayers.banNote')]}
	confirmLabel={t('web.instancePlayers.ban')}
	onconfirm={doScopedBan}
>
	<label class="field">
		<span class="lbl">{t('web.instancePlayers.reason')}</span>
		<input class="input" bind:value={banReason} placeholder={t('web.instancePlayers.reasonOptional')} />
	</label>
</ConfirmModal>

<ConfirmModal
	bind:open={ipBanOpen}
	title={t('web.instancePlayers.ipBanTitle', { targets: who })}
	lead={t('web.instancePlayers.ipBanLead', {
		addresses: pending.map((target) => bareAddress(target.address ?? '')).join(', ')
	})}
	notes={[t('web.instancePlayers.ipBanNote')]}
	confirmLabel={t('web.instancePlayers.banAddress')}
	onconfirm={doIpBan}
>
	<label class="field">
		<span class="lbl">{t('web.instancePlayers.reason')}</span>
		<input class="input" bind:value={ipBanReason} placeholder={t('web.instancePlayers.reasonOptional')} />
	</label>
</ConfirmModal>

<Modal
	title={t('web.playerActions.moderateTitle', {
		action: t(`web.instancePlayers.verb.${moderateAction}`),
		targets: who
	})}
	bind:open={moderateOpen}
>
	<div class="field">
		<span class="lbl">{t('web.nav.instancesList')}</span>
		<span class="hint">{t('web.players.instancesHint')}</span>
		<MultiSelect
			bind:value={moderateInstances}
			width="100%"
			options={instances.map((name) => ({ value: name, label: name }))}
		/>
	</div>

	{#if moderateAction === 'ban'}
		<label class="field">
			<span class="lbl">{t('web.access.colReason')}</span>
			<span class="hint">{t('web.players.reasonHint')}{t('web.players.reasonShown')}</span>
			<input class="input" bind:value={moderateReason} placeholder={t('web.players.eGGriefingOnSurvival')} />
		</label>
	{/if}

	{#snippet footer()}
		<Btn onclick={() => (moderateOpen = false)}>{t('web.common.cancel')}</Btn>
		<Btn
			variant={moderateAction === 'ban' ? 'danger' : 'primary'}
			disabled={moderateInstances.length === 0}
			title={moderateInstances.length === 0 ? t('web.playerActions.pickAServer') : undefined}
			onclick={doModerate}
		>
			{t(`web.instancePlayers.verb.${moderateAction}`)}
		</Btn>
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

	.field {
		margin-top: 0.75rem;
	}

	// level and duration side by side
	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0 1rem;
	}
</style>
