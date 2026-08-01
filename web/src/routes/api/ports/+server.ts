import { json } from '@sveltejs/kit';
import { loadCluster, loadLock, saveCluster } from '$core/config';
import { collectPortRows, auditPorts, ensurePortAllocations } from '$core/ports';
import { readVelocityServers } from '$core/proxy';

/** GET → the cluster-wide port map plus everything the audit flagged. */
export async function GET() {
	const cfg = await loadCluster();
	const lock = await loadLock();
	const rows = await collectPortRows(cfg, lock);
	const onDisk = await readVelocityServers(cfg);

	return json({ ports: rows, issues: await auditPorts(cfg, lock, onDisk) });
}

/** POST { fix: true } — rewrite plugin configs from the registry */
export async function POST() {
	const cfg = await loadCluster();
	const lock = await loadLock();
	const results = await ensurePortAllocations(cfg, lock);

	await saveCluster(cfg);

	const onDisk = await readVelocityServers(cfg);

	return json({
		ok: true,
		ensured: results.length,
		issues: await auditPorts(cfg, lock, onDisk)
	});
}
