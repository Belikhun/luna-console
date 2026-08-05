import { json, error } from '@sveltejs/kit';
import { loadersFor, projectTypeFor } from '$core/plugins';
import { searchProvider } from '$core/services/providers';
import type { PluginFamily, ProviderId } from '$core/types';

/**
 * GET ?q=&family=&provider=; provider search for the "install addon" dialog.
 * The family picks both halves of the query: mods and plugins are separate
 * project types upstream, so a neoforge search never returns a paper plugin
 * and vice versa. The provider defaults to Modrinth.
 */
export async function GET({ url }) {
	const query = url.searchParams.get('q');

	if (!query) {
		throw error(400, 'q required');
	}

	const requested = url.searchParams.get('family');
	const family: PluginFamily =
		requested === 'velocity' || requested === 'neoforge' ? requested : 'paper';
	const provider = (url.searchParams.get('provider') ?? 'modrinth') as ProviderId;

	try {
		const hits = await searchProvider(provider, query, projectTypeFor(family), loadersFor(family));

		return json({ hits });
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : String(err));
	}
}
