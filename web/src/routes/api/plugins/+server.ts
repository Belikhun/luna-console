import { json } from '@sveltejs/kit';
import { loadCluster, loadLock, saveLock } from '$core/config';
import { effectiveTargets, familyOf, pluginNameOf } from '$core/families';
import { displayNameOf, ensureAliases } from '$core/pluginstate';

/**
 * GET → the plugin universe grouped by identity: one row per plugin, its
 * family builds nested — the list view never shows loaders, the info view
 * unpacks the families.
 */
export async function GET() {
	const cfg = await loadCluster();
	const lock = await loadLock();

	if (await ensureAliases(lock)) {
		await saveLock(lock);
	}

	const grouped = new Map<string, any>();

	for (const [key, entry] of Object.entries(lock.plugins)) {
		const plugin = pluginNameOf(key, entry);

		if (!grouped.has(plugin)) {
			grouped.set(plugin, {
				plugin,
				displayName: displayNameOf(key, entry),
				description: entry.meta?.description ?? null,
				families: [],
				sources: [] as string[],
				effective: [] as string[],
				autoUpdate: false,
				pinned: false,
				variantCount: 0
			});
		}

		const row = grouped.get(plugin)!;
		const effective = effectiveTargets(cfg, lock, key);

		row.families.push({
			key,
			family: familyOf(entry),
			source: entry.source,
			autoUpdate: entry.autoUpdate,
			channel: entry.channel ?? 'release',
			version: entry.installed?.versionNumber ?? null,
			gameVersions: entry.installed?.gameVersions ?? null,
			modrinth: entry.modrinth ?? null,
			targets: entry.targets,
			effective,
			variants: Object.values(entry.variants ?? {}).map((variant) => ({
				versionNumber: variant.versionNumber,
				gameVersions: variant.gameVersions ?? null
			})),
			pins: entry.pins ?? {},
			assign: entry.assign ?? {}
		});

		if (!row.sources.includes(entry.source)) {
			row.sources.push(entry.source);
		}

		for (const target of effective) {
			if (!row.effective.includes(target)) {
				row.effective.push(target);
			}
		}

		row.autoUpdate = row.autoUpdate || entry.autoUpdate;
		row.pinned = row.pinned || Object.keys(entry.pins ?? {}).length > 0;
		row.variantCount += Object.keys(entry.variants ?? {}).length;

		if (!row.description && entry.meta?.description) {
			row.description = entry.meta.description;
		}
	}

	const plugins = [...grouped.values()].map((row) => ({
		...row,
		effective: row.effective.sort()
	}));

	return json({ plugins: plugins.sort((a, b) => a.plugin.localeCompare(b.plugin)) });
}
