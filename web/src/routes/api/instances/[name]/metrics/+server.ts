import { json } from '@sveltejs/kit';
import { getHistory, ensureSampler, getEvents } from '$lib/server/mrds';

/** How many recent events the detail page's activity list shows. */
const EVENT_LIMIT = 50;

/** GET → sampled CPU/memory/player history plus recent events for one instance. */
export async function GET({ params }) {
	ensureSampler();

	return json({
		history: getHistory(params.name),
		events: getEvents(params.name).slice(0, EVENT_LIMIT)
	});
}
