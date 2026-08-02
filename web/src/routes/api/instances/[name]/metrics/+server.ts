import { json } from '@sveltejs/kit';
import { getHistory, getEvents } from '$lib/server/luna';

/** How many recent events the detail page's activity list shows. */
const EVENT_LIMIT = 50;

/** GET → sampled CPU/memory/player history plus recent events for one instance. */
export async function GET({ params }) {
	const [history, events] = await Promise.all([getHistory(params.name), getEvents(params.name)]);

	return json({
		history,
		events: events.slice(0, EVENT_LIMIT)
	});
}
