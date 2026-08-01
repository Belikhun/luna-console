import { json } from '@sveltejs/kit';
import { cliBinary, root } from '$lib/server/mrds';

/** POST { words: string[] } → { completions: string[] }
 *  Uses the CLI's own completion engine so the web shell and terminal never drift. */
export async function POST({ request }) {
	const { words } = await request.json();

	if (!Array.isArray(words)) {
		return json({ completions: [] });
	}

	const proc = Bun.spawn([cliBinary(), '__complete', '--', ...words.map(String)], {
		env: { ...process.env, MRDS_ROOT: root() },
		stdout: 'pipe',
		stderr: 'ignore'
	});

	const out = await new Response(proc.stdout).text();

	await proc.exited;

	return json({ completions: out.split('\n').filter(Boolean) });
}
