// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { loadCluster } from '$core/config';
import { SERVER_SETTINGS, SETTING_GROUPS } from '$core/settings';

/**
 * GET → what the launch wizard needs before any instance exists: the Java
 * profile names to pick from and the settings schema with its groups.
 *
 * The wizard used to read these off the first existing instance's config, which
 * an account that owns no instance yet (a new customer, a fresh cluster) could
 * not reach, leaving it a form with nothing in it.
 */
export async function GET() {
	const cfg = await loadCluster();

	return json({
		profiles: Object.keys(cfg.javaProfiles ?? {}),
		schema: SERVER_SETTINGS,
		groups: SETTING_GROUPS
	});
}
