// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';

import { readMcpCalls } from '$core/mcp';

/** GET ?token=&tool=&ok=&search=&since=&until=&limit= → the MCP call log, newest first. */
export async function GET({ url }) {
	const params = url.searchParams;
	const ok = params.get('ok');
	const since = params.get('since');
	const until = params.get('until');

	const page = await readMcpCalls({
		token: params.get('token') ?? undefined,
		tool: params.get('tool') ?? undefined,
		ok: ok === null
			? undefined
			: ok === 'true',
		search: params.get('search') ?? undefined,
		since: since ? Number(since) : undefined,
		until: until ? Number(until) : undefined,
		limit: Number(params.get('limit') ?? 500)
	});

	return json(page);
}
