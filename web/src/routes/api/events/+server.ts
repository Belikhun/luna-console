import { json } from '@sveltejs/kit';
import { getEvents } from '$lib/server/luna';

/** GET ?instance= → the cluster event log, newest first (from the daemon). */
export async function GET({ url }) {
	return json({ events: await getEvents(url.searchParams.get('instance') ?? undefined) });
}
