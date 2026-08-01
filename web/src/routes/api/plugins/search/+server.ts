import { json, error } from '@sveltejs/kit';
import { search, PAPER_LOADERS, VELOCITY_LOADERS } from '$core/services/modrinth';

/** GET ?q=&loader= — Modrinth plugin search for the "add plugin" dialog. */
export async function GET({ url }) {
	const query = url.searchParams.get('q');

	if (!query) {
		throw error(400, 'q required');
	}

	const loaders =
		url.searchParams.get('loader') === 'velocity' ? VELOCITY_LOADERS : PAPER_LOADERS;

	return json({ hits: await search(query, loaders) });
}
