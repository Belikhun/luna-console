import { json } from '@sveltejs/kit';
import { loadCluster } from '$core/config';
import { buildPlan, execute } from '$core/cleanup';
import { pushEvent } from '$lib/server/luna';

const BYTES_PER_MB = 1048576;

/** GET → what a cleanup would remove, without touching anything. */
export async function GET() {
	const cfg = await loadCluster();

	return json({ plan: await buildPlan(cfg) });
}

/** POST → rebuild the plan and execute it. */
export async function POST() {
	const cfg = await loadCluster();
	const plan = await buildPlan(cfg);
	const res = await execute(plan);
	const freedMb = (res.freedBytes / BYTES_PER_MB).toFixed(0);

	pushEvent('cluster', 'action', `cleanup: freed ${freedMb} MB, archived ${res.archivedLogs} logs`);

	return json({ ok: true, ...res });
}
