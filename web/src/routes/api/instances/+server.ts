import { json } from '@sveltejs/kit';
import { listStatuses } from '$lib/server/mrds';

/** GET → live status of every instance, for the instances table. */
export async function GET() {
	return json(await listStatuses());
}
