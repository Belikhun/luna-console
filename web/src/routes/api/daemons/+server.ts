import { json } from '@sveltejs/kit';

import { listDaemons } from '$client/daemon';

/** GET → every daemon in the cluster: the primary plus known followers, live state included. */
export async function GET() {
	return json({ daemons: await listDaemons() });
}
