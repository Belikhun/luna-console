// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json } from '@sveltejs/kit';
import { cliBinary, root } from '$lib/server/luna';

/** POST { words: string[] } → { completions: string[] }
 *  Uses the CLI's own completion engine so the web shell and terminal never drift. */
export async function POST({ request }) {
	const { words } = await request.json();

	if (!Array.isArray(words)) {
		return json({ completions: [] });
	}

	const proc = Bun.spawn([cliBinary(), '__complete', '--', ...words.map(String)], {
		env: { ...process.env, LUNA_ROOT: root() },
		stdout: 'pipe',
		stderr: 'ignore'
	});

	const out = await new Response(proc.stdout).text();

	await proc.exited;

	return json({ completions: out.split('\n').filter(Boolean) });
}
