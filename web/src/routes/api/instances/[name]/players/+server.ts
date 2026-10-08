// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import { listSavedPlayers, readKnownPlayers, readPlayerRoster } from '$core/playerstate';
import type { KnownPlayer, PlayerRosterEntry } from '$core/playerdata';
import type { ClusterConfig } from '$core/types';
import * as luna from '$core/services/luna';
import type { LunaPlayer, PlaySession, VaultAccountInfo } from '$core/services/luna';
import { instanceStatus } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/** One player on one backend: what the proxy knows live, plus the backend's last save. */
export interface InstancePlayerRow extends LunaPlayer {
	/** The current stint on this backend, from the directory's open session */
	stintSince: number | null;
	stintMillis: number | null;
	/** LunaVault's view; null when the proxy has no vault or the player no account */
	balance: { amount: number; formatted: string } | null;
	vitals: PlayerRosterEntry['vitals'];
	advancements: PlayerRosterEntry['advancements'];
}

/** One row of the "everyone who has played here" table. */
export interface KnownPlayerRow extends KnownPlayer {
	/** Connected to this backend right now, by the proxy's roster */
	online: boolean;
}

/**
 * GET → who is on this backend right now; `?known=1` → everyone who has ever
 * played on it.
 *
 * The roster itself comes from the proxy, which is the only thing that knows who
 * is connected where; the saved state comes from the instance's own playerdata
 * through the owning daemon; the balance and the current stint come from the
 * proxy's vault and directory, one call per player and all in parallel. Every
 * part past the roster is best-effort: a missing save or an absent vault leaves
 * its columns empty rather than failing the table.
 */
export async function GET({ params, url }) {
	const cfg = await loadCluster();
	const name = params.name;

	if (!managedInstances(cfg)[name]) {
		throw error(404, 'unknown instance');
	}

	if (url.searchParams.get('known') === '1') {
		return await knownPlayers(cfg, name);
	}

	const status = await instanceStatus(name);
	const roster = await luna.players(name);

	if (!roster.ok) {
		return json({
			available: false,
			error: roster.error ?? 'unknown error',
			state: status.state,
			players: []
		});
	}

	const live = roster.data?.players ?? [];
	const uuids = live.map((player) => player.uuid);

	let saved: PlayerRosterEntry[] = [];
	let savedProblem: string | undefined;

	try {
		saved = uuids.length > 0 ? await readPlayerRoster(cfg, name, uuids) : [];
	} catch (err) {
		savedProblem = errorMessage(err);
	}

	const savedByUuid = new Map(saved.map((entry) => [entry.uuid.toLowerCase(), entry]));

	const rows = await Promise.all(
		live.map(async (player): Promise<InstancePlayerRow> => {
			const [vault, sessions] = await Promise.all([
				luna.vaultAccount(player.uuid),
				luna.playerSessions(player.uuid, { server: name, limit: 1 })
			]);

			const entry = savedByUuid.get(player.uuid.toLowerCase());
			const stint = currentStint(sessions.ok ? (sessions.data?.sessions ?? []) : [], name);

			return {
				...player,
				stintSince: stint?.connectedAtEpochMillis ?? null,
				stintMillis: stint ? Date.now() - stint.connectedAtEpochMillis : null,
				balance: balanceOf(vault.ok ? vault.data : undefined),
				vitals: entry?.vitals ?? null,
				advancements: entry?.advancements ?? null
			};
		})
	);

	return json({
		available: true,
		state: status.state,
		generatedAtEpochMillis: roster.data?.generatedAtEpochMillis ?? Date.now(),
		...(savedProblem ? { savedProblem } : {}),
		players: rows
	});
}

/**
 * Everyone the backend holds a save for. The saves are the record because they
 * are the one thing every server software writes for every player who joins,
 * proxy or not; the proxy's roster only adds who of them is here now, and a
 * proxy that does not answer leaves everyone offline rather than failing the
 * table.
 */
async function knownPlayers(cfg: ClusterConfig, name: string): Promise<Response> {
	const [known, roster] = await Promise.all([
		readKnownPlayers(cfg, name).then(
			(players) => ({ players, problem: undefined }),
			() => knownFromOlderDaemon(cfg, name)
		),
		luna.players(name)
	]);

	const online = new Set(
		(roster.ok ? (roster.data?.players ?? []) : []).map((player) => player.uuid.toLowerCase())
	);

	const rows: KnownPlayerRow[] = known.players.map((player) => ({
		...player,
		online: online.has(player.uuid)
	}));

	return json({
		lunaAvailable: roster.ok,
		...(known.problem ? { problem: known.problem } : {}),
		players: rows
	});
}

/**
 * The same rows composed from the two reads every daemon build has, for an owner
 * that predates `playerstate.known` (a follower not upgraded yet). Play time
 * comes only from the newer op, so it stays unknown here.
 */
async function knownFromOlderDaemon(
	cfg: ClusterConfig,
	name: string
): Promise<{ players: KnownPlayer[]; problem: string | undefined }> {
	try {
		const saved = await listSavedPlayers(cfg, name);
		const roster = saved.length > 0
			? await readPlayerRoster(cfg, name, saved.map((player) => player.uuid))
			: [];
		const rosterByUuid = new Map(roster.map((entry) => [entry.uuid, entry]));

		const players = saved.map((player): KnownPlayer => {
			const entry = rosterByUuid.get(player.uuid);
			const known = player.name ?? entry?.vitals?.lastKnownName;

			return {
				uuid: player.uuid,
				...(known ? { name: known } : {}),
				savedAt: player.savedAt,
				playTicks: null,
				vitals: entry?.vitals ?? null,
				advancements: entry?.advancements ?? null
			};
		});

		return { players, problem: undefined };
	} catch (err) {
		return { players: [], problem: errorMessage(err) };
	}
}

/**
 * The open session on this backend, when the newest one is it. A LunaCore build
 * without the server filter answers with the newest session anywhere, which is
 * still the current one, so the check on `server` is what keeps it honest.
 */
function currentStint(sessions: PlaySession[], server: string): PlaySession | undefined {
	const newest = sessions[0];

	if (!newest || !newest.open || newest.server.toLowerCase() !== server.toLowerCase()) {
		return undefined;
	}

	return newest;
}

function balanceOf(vault: VaultAccountInfo | undefined): InstancePlayerRow['balance'] {
	if (!vault || !vault.hasAccount) {
		return null;
	}

	return { amount: vault.balance, formatted: vault.balanceFormatted };
}
