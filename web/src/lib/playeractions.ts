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
import type { GameMode } from '$core/playerdata';

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
	const result = await post('/moderation/network-ip-bans', { action: 'add', ip, reason });

	if (result.ok === false) {
		throw new Error(result.error ?? 'LunaCore refused the ban');
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
