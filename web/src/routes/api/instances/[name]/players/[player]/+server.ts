// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import { readPlayerDetail, resolvePlayerRef } from '$core/playerstate';
import * as luna from '$core/services/luna';
import { errorMessage } from '$lib/server/http';
import { isUuid } from '$shared/uuid';

/**
 * GET → everything one backend and the proxy know about one player.
 *
 * The player may be named by uuid or by username; a username is resolved through
 * the instance's own usercache, so it answers for anyone who has ever joined this
 * backend, online or not. The saved state (inventory, vitals, advancements,
 * stats) comes from the owning daemon; the profile, live presence and balance
 * come from the proxy and are best-effort, since a player can have a save here
 * without the proxy ever having recorded them.
 */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const name = params.name;

	if (!managedInstances(cfg)[name]) {
		throw error(404, 'unknown instance');
	}

	let resolved: { uuid: string; name?: string } | undefined;

	try {
		resolved = await resolvePlayerRef(cfg, name, params.player);
	} catch (err) {
		throw error(502, errorMessage(err));
	}

	// a uuid nobody here has seen is still a valid question; the answer is an
	// empty save, and the proxy may still know the name
	if (!resolved && isUuid(params.player)) {
		resolved = { uuid: params.player.toLowerCase() };
	}

	if (!resolved) {
		throw error(404, `no player named ${params.player} on ${name}`);
	}

	const uuid = resolved.uuid;

	const [detail, profile, roster, vault] = await Promise.all([
		readPlayerDetail(cfg, name, uuid),
		luna.registeredPlayer(uuid),
		luna.players(name),
		luna.vaultAccount(uuid)
	]);

	const live = roster.ok ? (roster.data?.players ?? []).find((player) => player.uuid.toLowerCase() === uuid) : undefined;
	const username = live?.username
		?? (profile.ok ? profile.data?.username : undefined)
		?? resolved.name
		?? detail.name
		?? uuid;

	return json({
		instance: name,
		uuid,
		username,
		online: live !== undefined,
		live: live ?? null,
		lunaAvailable: roster.ok,
		...(roster.ok ? {} : { lunaError: roster.error ?? 'unknown error' }),
		profile: profile.ok ? (profile.data ?? null) : null,
		vault: vault.ok && vault.data?.hasAccount ? vault.data : null,
		detail
	});
}
