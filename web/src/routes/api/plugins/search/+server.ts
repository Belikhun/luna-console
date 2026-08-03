import { json, error } from '@sveltejs/kit';
import { loadersFor, projectTypeFor } from '$core/plugins';
import { searchProjects } from '$core/services/modrinth';
import type { PluginFamily } from '$core/types';

/**
 * GET ?q=&family= — Modrinth search for the "install addon" dialog. The family
 * picks both halves of the query: mods and plugins are separate project types
 * upstream, so a neoforge search never returns a paper plugin and vice versa.
 */
export async function GET({ url }) {
	const query = url.searchParams.get('q');

	if (!query) {
		throw error(400, 'q required');
	}

	// `loader` is the pre-mods spelling of the same parameter
	const requested = url.searchParams.get('family') ?? url.searchParams.get('loader');
	const family: PluginFamily =
		requested === 'velocity' || requested === 'neoforge' ? requested : 'paper';

	return json({ hits: await searchProjects(query, projectTypeFor(family), loadersFor(family)) });
}
