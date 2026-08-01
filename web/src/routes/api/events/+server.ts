import { json } from '@sveltejs/kit';
import { getEvents, ensureSampler } from '$lib/server/mrds';

/** GET ?instance= → the cluster event log, newest first. */
export async function GET({ url }) {
	ensureSampler();

	return json({ events: getEvents(url.searchParams.get('instance') ?? undefined) });
}
