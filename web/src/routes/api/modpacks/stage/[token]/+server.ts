// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';
import { inspectStagedMrpack } from '$core/modpack';
import { errorMessage } from '$lib/server/http';

/** GET → what the uploaded .mrpack would install: its name, loader, versions and download size. */
export async function GET({ params }) {
	try {
		return json({ summary: await inspectStagedMrpack(params.token) });
	} catch (err) {
		throw error(400, errorMessage(err));
	}
}
