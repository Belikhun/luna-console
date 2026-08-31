// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock, managedInstances } from '$core/config';
import { familyOf } from '$core/families';
import { projectTypeFor } from '$core/plugins';
import {
	aliasesOf,
	ensureAliases,
	instancePluginReport,
	pluginLogReport
} from '$core/pluginstate';
import { projectUrl } from '$core/services/providers';

/**
 * GET → one plugin on one instance: its report row (state, version, origin) plus
 * every log line of the current boot session attributed to it.
 */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const lock = await loadLock();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	if (await ensureAliases(lock)) {
		await saveLock(lock);
	}

	const { rows, session } = await instancePluginReport(cfg, lock, params.name);
	const row = rows.find((entry) => entry.plugin === params.plugin || entry.key === params.plugin);

	if (!row) {
		throw error(404, 'this plugin is not on this instance');
	}

	const entry = lock.plugins[row.key]!;
	const log = pluginLogReport(session, aliasesOf(row.key, entry), row.file);

	return json({
		row,
		aliases: aliasesOf(row.key, entry),
		meta: entry.meta ?? null,
		remote: entry.remote ?? null,
		url: entry.remote
			? projectUrl(entry.remote, projectTypeFor(familyOf(entry)))
			: null,
		channel: entry.channel ?? 'release',
		sessionComplete: session.complete,
		log: {
			lines: log.lines,
			warnings: log.warnings,
			errors: log.errors
		}
	});
}
