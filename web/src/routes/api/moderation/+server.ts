// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import { getAccessLists } from '$core/playerlists';
import type { AccessLists } from '$core/playerlists';
import { traitsOf } from '$core/software';

/**
 * The network-wide access-list view: every backend's whitelist, operators,
 * player bans and IP bans fetched in one sweep and folded per target, so the
 * moderation screen can answer "who is banned, and where" without opening
 * eight instance tabs. Mutations stay on POST /api/players/moderate, which
 * already fans one verb out across instances.
 */

interface InstanceSummary {
	name: string;
	state: string;
	whitelistEnabled: boolean;
	enforceWhitelist: boolean;
	error?: string;
}

interface AggregatedBan {
	name: string;
	uuid: string;
	reason: string;
	source: string;
	created: string;
	expires: string;
	instances: string[];
}

interface AggregatedIpBan {
	ip: string;
	reason: string;
	source: string;
	created: string;
	expires: string;
	instances: string[];
}

interface AggregatedWhitelistEntry {
	name: string;
	uuid: string;
	instances: string[];
}

interface AggregatedOp {
	name: string;
	uuid: string;
	/** Highest level held anywhere; per-instance levels can differ */
	level: number;
	bypassesPlayerLimit: boolean;
	instances: string[];
}

/** Two profiles can share a name; the exact id wins as the fold key. */
function playerKey(uuid: string, name: string): string {
	return uuid || name.toLowerCase();
}

export async function GET() {
	const cfg = await loadCluster();
	const managed = managedInstances(cfg);

	// the proxy keeps no vanilla access lists; only backends hold them
	const names = Object.entries(managed)
		.filter(([, inst]) => !traitsOf(inst.software).isProxy)
		.map(([name]) => name)
		.sort();

	const results = await Promise.all(
		names.map(async (name): Promise<{ name: string; lists?: AccessLists; error?: string }> => {
			try {
				return { name, lists: await getAccessLists(cfg, name) };
			} catch (err) {
				return { name, error: (err as Error).message };
			}
		})
	);

	const summaries: InstanceSummary[] = [];
	const bans = new Map<string, AggregatedBan>();
	const ipBans = new Map<string, AggregatedIpBan>();
	const whitelist = new Map<string, AggregatedWhitelistEntry>();
	const ops = new Map<string, AggregatedOp>();

	for (const result of results) {
		if (!result.lists) {
			summaries.push({
				name: result.name,
				state: 'unknown',
				whitelistEnabled: false,
				enforceWhitelist: false,
				error: result.error ?? 'unreachable'
			});
			continue;
		}

		const lists = result.lists;

		summaries.push({
			name: result.name,
			state: lists.state,
			whitelistEnabled: lists.whitelistEnabled,
			enforceWhitelist: lists.enforceWhitelist
		});

		for (const entry of lists.bans) {
			const key = playerKey(entry.uuid, entry.name);
			const folded = bans.get(key);

			if (folded) {
				folded.instances.push(result.name);
				folded.reason = folded.reason || entry.reason || '';
			} else {
				bans.set(key, {
					name: entry.name,
					uuid: entry.uuid,
					reason: entry.reason ?? '',
					source: entry.source,
					created: entry.created,
					expires: entry.expires,
					instances: [result.name]
				});
			}
		}

		for (const entry of lists.ipBans) {
			const folded = ipBans.get(entry.ip);

			if (folded) {
				folded.instances.push(result.name);
				folded.reason = folded.reason || entry.reason || '';
			} else {
				ipBans.set(entry.ip, {
					ip: entry.ip,
					reason: entry.reason ?? '',
					source: entry.source,
					created: entry.created,
					expires: entry.expires,
					instances: [result.name]
				});
			}
		}

		for (const entry of lists.whitelist) {
			const key = playerKey(entry.uuid, entry.name);
			const folded = whitelist.get(key);

			if (folded) {
				folded.instances.push(result.name);
			} else {
				whitelist.set(key, {
					name: entry.name,
					uuid: entry.uuid,
					instances: [result.name]
				});
			}
		}

		for (const entry of lists.ops) {
			const key = playerKey(entry.uuid, entry.name);
			const folded = ops.get(key);

			if (folded) {
				folded.instances.push(result.name);
				folded.level = Math.max(folded.level, entry.level);
				folded.bypassesPlayerLimit = folded.bypassesPlayerLimit || entry.bypassesPlayerLimit;
			} else {
				ops.set(key, {
					name: entry.name,
					uuid: entry.uuid,
					level: entry.level,
					bypassesPlayerLimit: entry.bypassesPlayerLimit,
					instances: [result.name]
				});
			}
		}
	}

	return json({
		instances: summaries,
		bans: [...bans.values()],
		ipBans: [...ipBans.values()],
		whitelist: [...whitelist.values()],
		ops: [...ops.values()]
	});
}
