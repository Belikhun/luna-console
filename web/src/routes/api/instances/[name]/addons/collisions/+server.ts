// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, loadLock } from '$core/config';
import { addonCollisions } from '$core/pluginstate';
import { PLUGIN_FAMILIES } from '$core/types';
import type { PluginFamily } from '$core/types';
import { errorMessage } from '$lib/server/http';

/**
 * GET ?plugin=<name>&family=<family> → what putting that addon here would run
 * into: the pool entry it would overwrite, and the copies of the same addon
 * already on this instance under other names.
 *
 * Asked while the upload dialog is still open, which is the only moment the
 * answer is worth anything: afterwards the duplicate is already installed and
 * the operator is debugging a server that loaded the same plugin twice.
 */
export async function GET({ params, url }) {
	const plugin = (url.searchParams.get('plugin') ?? '').trim();
	const family = url.searchParams.get('family') ?? 'paper';

	if (!PLUGIN_FAMILIES.includes(family as PluginFamily)) {
		throw error(400, `unknown family: ${family}`);
	}

	// an empty name is the dialog's opening state, not a bad request; answering
	// "nothing to collide with" keeps the caller from special-casing it
	if (!plugin) {
		return json({ managed: [], unmanaged: [] });
	}

	try {
		return json(
			await addonCollisions(await loadCluster(), await loadLock(), params.name, {
				plugin,
				family: family as PluginFamily
			})
		);
	} catch (err) {
		throw error(404, errorMessage(err));
	}
}
