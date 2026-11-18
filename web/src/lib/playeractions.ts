// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The verbs a screen can run against players, shared by every place a player
 * has a context menu: the network-wide pages, an instance's online table and the
 * instance-scoped player screen. Each one calls the console route that owns the
 * action and either returns what happened or throws with the route's own words,
 * so the screens only decide what to ask and how to say the answer.
 */

import { post } from '$lib/api';
import { t } from '$lib/i18n.svelte';
import type { GameMode } from '$core/playerdata';
import type { ContextMenuItem } from '$lib/components/contextmenu';

/** A player as the verbs address one: the name for commands, the uuid for the proxy. */
export interface PlayerTarget {
	username: string;
	uuid: string;
}

/** The access-list and live verbs `/api/players/moderate` accepts. */
export type ModerationAction =
	| 'kick'
	| 'ban'
	| 'pardon'
	| 'ban-ip'
	| 'pardon-ip'
	| 'whitelist-add'
	| 'whitelist-remove'
	| 'op'
	| 'deop';

export interface ModerationSummary {
	/** Targets the server accepted but has not persisted yet */
	unconfirmed: string[];
}

/** Run one live network action on the proxy; throws with LunaCore's refusal. */
export async function lunaAdmin(body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const result = await post('/luna/admin', body);

	if (result.ok === false) {
		throw new Error(result.error ?? 'LunaCore refused the action');
	}

	return result.data ?? {};
}

/**
 * Apply one access-list verb to every target on the given instances. The route
 * fans the pair out itself and records each outcome in the player's moderation
 * log; a failed pair throws with every failure named, an unverified one (sent to
 * a live server that has not written its list yet) is reported, not raised.
 */
export async function moderatePlayers(
	action: ModerationAction,
	targets: PlayerTarget[],
	instances: string[],
	reason = ''
): Promise<ModerationSummary> {
	const result = await post('/players/moderate', {
		action,
		targets: targets.map((target) => ({ name: target.username, uuid: target.uuid })),
		instances,
		reason
	});

	const outcomes: Array<{ target: string; instance: string; ok: boolean; verified?: boolean; error?: string }> =
		result.outcomes ?? [];
	const failed = outcomes.filter((outcome) => !outcome.ok);

	if (failed.length > 0) {
		throw new Error(failed.map((outcome) => `${outcome.target}: ${outcome.error ?? 'failed'}`).join('; '));
	}

	return {
		unconfirmed: outcomes
			.filter((outcome) => outcome.ok && outcome.verified === false)
			.map((outcome) => outcome.target)
	};
}

/** Send one message to each target, through the proxy. */
export async function messagePlayers(targets: PlayerTarget[], message: string): Promise<void> {
	for (const target of targets) {
		await lunaAdmin({ action: 'message', player: target.uuid, message });
	}
}

/** Move each target to another backend; the proxy reports what the target decided. */
export async function transferPlayers(targets: PlayerTarget[], server: string): Promise<void> {
	for (const target of targets) {
		await lunaAdmin({ action: 'transfer', player: target.uuid, server });
	}
}

/** Disconnect each target from the network. */
export async function kickPlayers(targets: PlayerTarget[], reason = ''): Promise<void> {
	for (const target of targets) {
		await lunaAdmin({ action: 'kick', player: target.uuid, reason });
	}
}

/**
 * Close each target's connection outright. A kick waits for the client to take
 * its packet, which never happens once the player's network has dropped; this
 * frees a session the proxy is still holding so the player can log back in.
 */
export async function disconnectPlayers(targets: PlayerTarget[], reason = ''): Promise<void> {
	for (const target of targets) {
		await lunaAdmin({ action: 'disconnect', player: target.uuid, reason });
	}
}

/**
 * `gamemode <mode> <player>` through the instance's console. Vanilla on every
 * JVM server, so it needs no plugin; it needs the instance to be running, which
 * the route reports as a 409 the caller shows.
 */
export async function setGameMode(instance: string, targets: PlayerTarget[], mode: GameMode): Promise<void> {
	for (const target of targets) {
		await post(`/instances/${encodeURIComponent(instance)}/console`, {
			command: `gamemode ${mode} ${target.username}`
		});
	}
}

/**
 * Re-offer the targets their resource packs. luna-pack sends a client its whole
 * applicable set, so this is the player-shaped form of the pack screens' verb.
 */
export async function resendPacks(targets: PlayerTarget[]): Promise<void> {
	const result = await post('/respacks/resend', { players: targets.map((target) => target.username) });

	if (!result.available) {
		throw new Error(result.problem ?? 'luna-pack is not answering');
	}

	const failed = (result.targets ?? []).filter((target: { sent?: boolean }) => !target.sent);

	if (failed.length > 0) {
		throw new Error(
			failed.map((target: { player?: string; problem?: string }) => target.problem ?? target.player ?? '?').join('; ')
		);
	}
}

/** Ban an address at the network level: the proxy refuses it at pre-login. */
export async function banAddressOnNetwork(ip: string, reason = ''): Promise<void> {
	const result = await post('/firewall/bans', { action: 'add', ips: [ip], reason });
	const outcome = result.outcomes?.[0];

	if (!outcome?.ok) {
		throw new Error(outcome?.error ?? 'LunaCore refused the ban');
	}
}

/** The bare address out of the `/host:port` form the proxy reports. */
export function bareAddress(remoteAddress: string): string {
	return remoteAddress.replace(/^\//, '').replace(/:\d+$/, '');
}

/** Targets as a readable list, for notices. */
export function targetNames(targets: PlayerTarget[]): string {
	return targets.map((target) => target.username).join(', ');
}

/** The dialogs and one-shot verbs `PlayerActionDialogs` runs. */
export type PlayerDialogKind =
	| 'message'
	| 'transfer'
	| 'kick'
	| 'force'
	| 'resend'
	| 'ipban'
	| 'ban'
	| 'pardon'
	| 'whitelist-add'
	| 'whitelist-remove'
	| 'op'
	| 'deop';

/** A player a menu acts on, with what the menu needs to know to offer each verb. */
export interface PlayerActionTarget extends PlayerTarget {
	/** False for a player who is not connected; the live verbs skip them */
	online?: boolean;
	/** The backend they are on, which a move leaves out of its destinations */
	server?: string;
	/** Their address as the proxy reports it; absent, an address ban is not offered */
	address?: string;
}

/** What a screen tells the menu builder about where its verbs run. */
export interface PlayerVerbContext {
	/** The players the verbs act on: the selection, or the one row */
	targets: PlayerActionTarget[];
	/** Set on an instance's screens: access verbs then act on this server alone */
	instance?: string;
	/** Instance screens only: whether that server is running, which game mode needs */
	running?: boolean;
	/** Backends a player can be moved to */
	servers: string[];
	/** Opens a dialog, or runs the verb when it needs none */
	open: (kind: PlayerDialogKind, targets: PlayerActionTarget[]) => void;
	/** Instance screens only: the game mode verb */
	setGameMode?: (targets: PlayerActionTarget[], mode: GameMode) => void;
	/** Game modes offered under the game mode verb */
	gameModes?: readonly GameMode[];
	/** Where the one player stands on this server's lists, which disables the verbs that would change nothing */
	flags?: { operator: boolean; whitelisted: boolean; banned: boolean } | null;
}

/** The verbs over a set of players, in the groups a menu puts dividers between. */
export interface PlayerVerbGroups {
	/** Verbs on a live connection: message, move, packs, game mode */
	live: ContextMenuItem[];
	/** The access-list submenu */
	access: ContextMenuItem[];
	/** Disconnecting and banning */
	remove: ContextMenuItem[];
}

/**
 * The player verbs every screen offers, in one order with one set of labels and
 * one reason per disabled verb. A live verb acts on the connected targets only,
 * so a mixed selection still gets it; nobody connected disables it and says so.
 *
 * @param ctx the targets and where the verbs run
 * @returns the verbs by group, for `menuGroups` to join
 */
export function playerVerbGroups(ctx: PlayerVerbContext): PlayerVerbGroups {
	const none = ctx.targets.length === 0;
	const connected = ctx.targets.filter((target) => target.online !== false);
	const addressed = ctx.targets.filter((target) => !!target.address);
	const scoped = ctx.instance !== undefined;

	const noneHint = none
		? t('web.instancePlayers.selectFirst')
		: undefined;

	const offlineHint = connected.length > 0
		? undefined
		: ctx.targets.length === 1
			? t('web.playerActions.playerOffline')
			: t('web.playerActions.nobodyOnline');

	const liveHint = noneHint ?? offlineHint;
	const liveOff = none || connected.length === 0;

	const live: ContextMenuItem[] = [
		{
			label: t('web.instancePlayers.sendAMessage'),
			icon: 'paperPlane',
			disabled: liveOff,
			hint: liveHint,
			action: () => ctx.open('message', connected)
		},
		{
			label: t('web.instancePlayers.moveToAnotherBackend'),
			icon: 'rightLeft',
			disabled: liveOff || ctx.servers.length === 0,
			hint: liveHint ?? (ctx.servers.length === 0 ? t('web.instancePlayers.noOtherBackend') : undefined),
			action: () => ctx.open('transfer', connected)
		},
		{
			label: t('web.instancePlayers.resendPacks'),
			icon: 'image',
			disabled: liveOff,
			hint: liveHint ?? t('web.playersOnline.resendWholeSet'),
			action: () => ctx.open('resend', connected)
		}
	];

	if (scoped && ctx.setGameMode) {
		const setGameMode = ctx.setGameMode;
		const stopped = ctx.running === false;

		live.push({
			label: t('web.instancePlayers.setGameMode'),
			icon: 'joystick',
			disabled: liveOff || stopped,
			hint: liveHint ?? (stopped ? t('web.instancePlayers.needsRunning') : undefined),
			submenu: (ctx.gameModes ?? []).map((mode) => ({
				label: t(`web.instancePlayers.mode.${mode}`),
				action: () => setGameMode(connected, mode)
			}))
		});
	}

	// on a network screen each of these asks which servers first, hence the ellipsis
	const suffix = scoped
		? ''
		: '…';

	const flags = ctx.targets.length === 1
		? ctx.flags
		: null;

	const access: ContextMenuItem[] = [
		{
			label: t('web.instancePlayers.accessLists'),
			icon: 'userShield',
			disabled: none,
			hint: noneHint,
			submenu: [
				{
					label: `${t('web.instancePlayers.addToWhitelist')}${suffix}`,
					icon: 'userTick',
					disabled: flags?.whitelisted === true,
					hint: flags?.whitelisted ? t('web.playerActions.alreadyWhitelisted') : undefined,
					action: () => ctx.open('whitelist-add', ctx.targets)
				},
				{
					label: `${t('web.instancePlayers.removeFromWhitelist')}${suffix}`,
					icon: 'userMinus',
					disabled: flags?.whitelisted === false,
					hint: flags?.whitelisted === false ? t('web.playerActions.notWhitelisted') : undefined,
					action: () => ctx.open('whitelist-remove', ctx.targets)
				},
				{ separator: true },
				{
					label: `${t('web.instancePlayers.grantOperator')}${suffix}`,
					icon: 'userCog',
					disabled: flags?.operator === true,
					hint: flags?.operator ? t('web.playerActions.alreadyOperator') : undefined,
					action: () => ctx.open('op', ctx.targets)
				},
				{
					label: `${t('web.instancePlayers.revokeOperator')}${suffix}`,
					icon: 'userLock',
					disabled: flags?.operator === false,
					hint: flags?.operator === false ? t('web.playerActions.notOperator') : undefined,
					action: () => ctx.open('deop', ctx.targets)
				},
				{ separator: true },
				{
					label: scoped ? t('web.instancePlayer.pardonHere') : t('web.players.pardon'),
					icon: 'handshake',
					disabled: flags?.banned === false,
					hint: flags?.banned === false ? t('web.playerActions.notBanned') : undefined,
					action: () => ctx.open('pardon', ctx.targets)
				}
			]
		}
	];

	const remove: ContextMenuItem[] = [
		{
			label: t('web.instancePlayers.disconnect'),
			icon: 'userSlash',
			color: 'danger',
			disabled: liveOff,
			hint: liveHint,
			action: () => ctx.open('kick', connected)
		},
		{
			label: t('web.instancePlayers.forceDisconnect'),
			icon: 'unlink',
			color: 'danger',
			disabled: liveOff,
			hint: liveHint,
			action: () => ctx.open('force', connected)
		},
		{
			label: scoped ? t('web.instancePlayers.banHere') : t('web.players.ban'),
			icon: 'gavel',
			color: 'danger',
			disabled: none || flags?.banned === true,
			hint: noneHint ?? (flags?.banned ? t('web.playerActions.alreadyBanned') : undefined),
			action: () => ctx.open('ban', ctx.targets)
		},
		{
			label: t('web.instancePlayers.banAddressOnNetwork'),
			icon: 'ban',
			color: 'danger',
			disabled: none || addressed.length === 0,
			hint: noneHint ?? (addressed.length === 0 ? t('web.playerActions.noKnownAddress') : undefined),
			action: () => ctx.open('ipban', addressed)
		}
	];

	return { live, access, remove };
}

/** A few targets by name, a crowd by its size: what a dialog title and a notice can hold. */
export function targetSummary(targets: PlayerTarget[]): string {
	return targets.length <= 3
		? targetNames(targets)
		: t('web.playerActions.nPlayers', { count: targets.length });
}
