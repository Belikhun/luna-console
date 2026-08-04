import { json } from '@sveltejs/kit';

import { loadCluster } from '$core/config';
import { assetState, ensureMcAssets } from '$core/mcassets';
import { startJob } from '$lib/server/jobs';

/** GET → whether the Minecraft textures the editor draws with are extracted. */
export async function GET() {
	const cfg = await loadCluster();

	return json({ state: await assetState(cfg) });
}

/** POST → download and extract them; minutes of work, so it runs as a job. */
export async function POST({ request }) {
	const body = (await request.json().catch(() => ({}))) as { force?: boolean };
	const cfg = await loadCluster();

	const job = startJob('mcassets', 'assets', 'Extract Minecraft assets', async (reporter) => {
		return await ensureMcAssets(cfg, { force: !!body?.force, reporter });
	});

	return json({ job });
}
