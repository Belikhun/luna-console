import { json } from '@sveltejs/kit';
import { loadCluster } from '$core/config';
import { syncVelocityToml, readVelocityServers } from '$core/proxy';
import { sendCommand, getStatus } from '$core/instances';
import { pushEvent } from '$lib/server/luna';
import { jsonBody } from '$lib/server/http';

/** GET → the routing tables the registry wants, next to what is on disk. */
export async function GET() {
	const cfg = await loadCluster();
	const preview = await syncVelocityToml(cfg, true);
	const onDisk = await readVelocityServers(cfg);

	return json({
		changed: preview.changed,
		preview: preview.diffPreview,
		desired: preview.servers,
		onDisk,
		tryList: preview.tryList,
		forcedHosts: preview.forcedHosts
	});
}

/** POST { reload? }; apply sync (and optionally `velocity reload`) */
export async function POST({ request }) {
	const body = await jsonBody(request);
	const cfg = await loadCluster();
	const res = await syncVelocityToml(cfg, false);
	let reloaded = false;

	if (body.reload) {
		const status = await getStatus(cfg, 'proxy');

		if (status.state !== 'stopped') {
			reloaded = await sendCommand(cfg, 'proxy', 'velocity reload');
		}
	}

	const outcome = res.changed ? ' (updated)' : ' (no changes)';
	const reload = reloaded ? ' + reload' : '';

	pushEvent('proxy', 'action', `velocity.toml sync${outcome}${reload}`);

	return json({ ok: true, changed: res.changed, reloaded });
}
