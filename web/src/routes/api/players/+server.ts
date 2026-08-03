import { json } from '@sveltejs/kit';
import * as luna from '$core/services/luna';

/**
 * GET ?search=&sort=&dir=&limit=&offset= → the player directory: every player
 * LunaCore has ever recorded, paged and searchable, with live session state
 * merged in for whoever is online right now.
 */
export async function GET({ url }) {
	const query: luna.RegisteredPlayerQuery = {};

	const search = url.searchParams.get('search');
	const sort = url.searchParams.get('sort');
	const dir = url.searchParams.get('dir');
	const limit = url.searchParams.get('limit');
	const offset = url.searchParams.get('offset');

	if (search) {
		query.search = search;
	}

	if (sort) {
		query.sort = sort;
	}

	if (dir === 'asc' || dir === 'desc') {
		query.dir = dir;
	}

	if (limit) {
		query.limit = Number(limit);
	}

	if (offset) {
		query.offset = Number(offset);
	}

	const result = await luna.registeredPlayers(query);

	if (!result.ok) {
		return json({ available: false, error: result.error ?? 'unknown error' });
	}

	return json({ available: true, ...result.data });
}
