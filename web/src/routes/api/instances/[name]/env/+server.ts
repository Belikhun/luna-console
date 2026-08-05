// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, managedInstances } from '$core/config';
import { loadEnv, resolveDetailed, writeEnvFile } from '$core/environment';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * What one instance's environment actually resolves to: every variable with the
 * scope that won and the values it shadows (builtin < global < machine <
 * instance). Secret values are masked at every scope.
 */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const inst = managedInstances(cfg)[params.name];

	if (!inst) {
		throw error(404, 'unknown instance');
	}

	const resolved = await resolveDetailed(cfg, await loadEnv(), params.name);

	return json({
		machine: inst.daemon ?? null,
		variables: resolved.map((entry) => ({
			name: entry.name,
			value: entry.secret ? '' : entry.value,
			scope: entry.scope,
			secret: entry.secret,
			description: entry.description ?? '',
			shadowed: entry.shadowed.map((prev) => ({
				scope: prev.scope,
				value: entry.secret ? '' : prev.value
			}))
		}))
	});
}

/**
 * POST → rewrite the instance's `.luna-env` from the store. The JVM reads it at
 * startup, so this stages the values rather than applying them live; the
 * response says so and the console tells the operator to restart.
 */
export async function POST({ params }) {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[params.name]) {
		throw error(404, 'unknown instance');
	}

	try {
		const path = await writeEnvFile(cfg, params.name);

		pushEvent(params.name, 'action', 'environment file rewritten');

		return json({ ok: true, path, appliesOn: 'next-start' });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
