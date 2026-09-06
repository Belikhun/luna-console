// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { allInstances, loadCluster } from '$core/config';
import * as luna from '$core/services/luna';

/**
 * GET ?type=&search=&limit=&offset= → a page of this backend's chat and command
 * log across every player, newest first. On the proxy the page is the whole
 * network's, since the proxy is where every line passes through. An external
 * backend has a log too: the proxy records chat on the way, whoever runs the
 * server, so this route takes any registered instance, not just the managed ones.
 */
export async function GET({ params, url }) {
	const cfg = await loadCluster();
	const name = params.name;
	const inst = allInstances(cfg)[name];

	if (!inst) {
		throw error(404, 'unknown instance');
	}

	const type = url.searchParams.get('type');
	const search = url.searchParams.get('search') ?? '';

	const result = await luna.serverChat({
		...(name === 'proxy' ? {} : { server: name }),
		...(type === 'chat' || type === 'command' ? { type } : {}),
		...(search ? { search } : {}),
		limit: Number(url.searchParams.get('limit') ?? 25),
		offset: Number(url.searchParams.get('offset') ?? 0)
	});

	if (!result.ok) {
		// 404 is an older LunaCore without the route; the screen says so instead of
		// showing an empty log
		return json({
			available: false,
			supported: result.status !== 404,
			error: result.error ?? 'unknown error'
		});
	}

	return json({ available: true, supported: true, ...result.data });
}
