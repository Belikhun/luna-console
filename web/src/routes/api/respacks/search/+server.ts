import { json, error } from '@sveltejs/kit';
import { searchProjects } from '$core/services/modrinth';

/** GET ?q= — Modrinth resource pack search for the install dialog. */
export async function GET({ url }) {
	const query = url.searchParams.get('q');

	if (!query) {
		throw error(400, 'q required');
	}

	return json({ hits: await searchProjects(query, 'resourcepack') });
}
