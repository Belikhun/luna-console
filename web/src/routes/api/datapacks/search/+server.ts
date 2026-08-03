import { json, error } from '@sveltejs/kit';
import { searchProvider } from '$core/services/providers';
import type { ProviderId } from '$core/types';

/** GET ?q=&provider= — data pack search for the install dialog. */
export async function GET({ url }) {
	const query = url.searchParams.get('q');

	if (!query) {
		throw error(400, 'q required');
	}

	const provider = (url.searchParams.get('provider') ?? 'modrinth') as ProviderId;

	try {
		return json({ hits: await searchProvider(provider, query, 'datapack') });
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : String(err));
	}
}
