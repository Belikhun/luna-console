import { json } from '@sveltejs/kit';
import { loadCluster, loadLock, expandTargets } from '$core/config';

/** GET → every lockfile entry, with its wildcards already expanded. */
export async function GET() {
	const cfg = await loadCluster();
	const lock = await loadLock();

	const plugins = Object.entries(lock.plugins).map(([name, entry]) => ({
		name,
		file: entry.file,
		source: entry.source,
		loader: entry.loader,
		autoUpdate: entry.autoUpdate,
		channel: entry.channel ?? 'release',
		version: entry.installed?.versionNumber ?? null,
		gameVersions: entry.installed?.gameVersions ?? null,
		modrinth: entry.modrinth ?? null,
		targets: entry.targets,
		expandedTargets: expandTargets(cfg, entry.targets),

		variants: Object.values(entry.variants ?? {}).map((variant) => ({
			versionNumber: variant.versionNumber,
			gameVersions: variant.gameVersions ?? null
		})),

		pins: entry.pins ?? {},
		assign: entry.assign ?? {}
	}));

	return json({ plugins: plugins.sort((a, b) => a.name.localeCompare(b.name)) });
}
