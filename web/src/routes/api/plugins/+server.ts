import { json } from '@sveltejs/kit';
import { addonDirForFamily, loadCluster, loadLock, saveLock } from '$core/config';
import { effectiveTargets, familyOf, pluginNameOf } from '$core/families';
import { projectTypeFor } from '$core/plugins';
import { displayNameOf, ensureAliases } from '$core/pluginstate';
import { projectUrl } from '$core/services/providers';

/**
 * GET ?kind=plugins|mods → the addon universe grouped by identity: one row per
 * addon, its family builds nested — the list view never shows loaders, the info
 * view unpacks the families.
 *
 * `kind` splits the two screens. It is a filter on the *builds*, not on the
 * addon: something like luna-core, which ships a paper plugin and a neoforge
 * mod, is genuinely both and appears on both screens with only the matching
 * families listed.
 */
export async function GET({ url }) {
	const cfg = await loadCluster();
	const lock = await loadLock();

	const requested = url.searchParams.get('kind');
	const kind = requested === 'mods' || requested === 'plugins' ? requested : null;

	if (await ensureAliases(lock)) {
		await saveLock(lock);
	}

	const grouped = new Map<string, any>();

	for (const [key, entry] of Object.entries(lock.plugins)) {
		const plugin = pluginNameOf(key, entry);

		if (kind && addonDirForFamily(familyOf(entry)) !== kind) {
			continue;
		}

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
			remote: entry.remote ?? null,
			url: entry.remote ? projectUrl(entry.remote, projectTypeFor(familyOf(entry))) : null,
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
