// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, saveCluster, loadLock, saveLock } from '$core/config';
import {
	deploy,
	fitAddonToInstance,
	installFromProvider,
	projectTypeFor,
	uploadJar
} from '$core/plugins';
import { addDataPackFile, deployDataPacks, installDataPackFromProvider } from '$core/datapacks';
import { setPluginOverride } from '$core/families';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import type { PackChannel } from '$core/packslock';
import { ensureAliases, supersedeAddons } from '$core/pluginstate';
import { ensurePortAllocations } from '$core/ports';
import { getProject, isReleaseChannel } from '$core/services/providers';
import { PLUGIN_FAMILIES } from '$core/types';
import type { ClusterConfig, PluginFamily, ProviderId } from '$core/types';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * Put one addon on one instance, from whichever of the three places it comes.
 *
 * One route rather than three because the interesting half is the same for all
 * of them: the addon has to reach the pool, then this instance's targets, then a
 * build this instance's Minecraft version can run, then its directory, and any
 * copy of the same addon already there has to go or the server loads it twice.
 * Splitting that across an upload route, a targets PATCH and a provider install
 * is what made "add a plugin to this backend" a three-screen errand in the first
 * place.
 *
 * POST body:
 *   { source: 'upload',   plugin, family, data,                deploy?, supersede? }
 *   { source: 'pool',     plugin,                    version?, deploy?, supersede? }
 *   { source: 'provider', provider, slug, id?, family, channel?, version?, deploy?, supersede? }
 * plus `kind: 'datapack'` when the addon is a data pack: same three sources,
 * but a pack lives in the packs lock, deploys into the world rather than an
 * addon directory, and has no per-instance version to pin - one zip serves
 * every target, resolved against all their MC versions at install time.
 *
 * `version` (pool and provider) is a manual override: install exactly that
 * build on this instance as a pin, past the compatibility gate. Without it the
 * instance gets the newest build its MC version can run.
 *
 * `supersede` is `{ plugins?, files? }` exactly as the collisions route reported
 * them; it runs *after* the new addon is in place, so a failure never leaves the
 * instance with neither copy.
 */
export async function POST({ params, request }) {
	const body = await request.json();
	const name = params.name;
	const cfg = await loadCluster();

	if (!cfg.instances[name]) {
		throw error(404, `unknown instance: ${name}`);
	}

	if (body.kind === 'datapack') {
		return await addDataPack(cfg, name, body);
	}

	const lock = await loadLock();
	const deployHere = body.deploy !== false;

	// An explicit version is the operator's own selection, made against the list
	// the versions endpoint showed them; it overrides the automatic fit below and
	// lands as a pin on this instance, incompatible or not.
	const wantVersion = typeof body.version === 'string' && body.version ? body.version : undefined;

	// A provider install with a version choice is pooled target-less: handing
	// installFromProvider the target would make it resolve a build for it, which is
	// exactly the step the operator is overriding, and which refuses outright when
	// nothing compatible exists - the case the override is for.
	const targets = deployHere && !wantVersion ? [name] : [];

	let entryName = '';
	let holdbacks: unknown[] = [];
	let fit: Awaited<ReturnType<typeof fitAddonToInstance>> | undefined;

	try {
		if (body.source === 'upload') {
			const family = familyOf(body.family);
			const res = await uploadJar(cfg, lock, {
				plugin: String(body.plugin ?? ''),
				family,
				targets,
				dataBase64: String(body.data ?? '')
			});

			entryName = res.name;
		} else if (body.source === 'pool') {
			const plugin = String(body.plugin ?? '');

			if (!plugin) {
				throw error(400, 'plugin is required');
			}

			// a pooled addon reaches one instance through its own override, not by
			// editing the entry's targets: targets are cluster-wide, and adding one
			// instance there is not what the operator asked for
			setPluginOverride(cfg, lock, name, plugin, deployHere ? true : null);
			entryName = plugin;
		} else if (body.source === 'provider') {
			const family = familyOf(body.family);
			const provider = (body.provider ?? 'modrinth') as ProviderId;
			const channel = typeof body.channel === 'string' ? body.channel : undefined;

			if (channel !== undefined && !isReleaseChannel(channel)) {
				throw error(400, `unknown channel: ${channel}`);
			}

			const project = await getProject(provider, body.id ?? body.slug, projectTypeFor(family));

			if (!project) {
				throw error(404, `${provider} project "${body.slug ?? body.id}" not found`);
			}

			const res = await installFromProvider(cfg, lock, provider, project, family, targets, {
				...(channel ? { channel } : {})
			});

			entryName = res.name;
			holdbacks = res.resolution.holdbacks;

			// the coverage the target-less install above did not record; the same
			// override the pool path uses, so removing it later is one gesture
			if (deployHere && wantVersion) {
				setPluginOverride(cfg, lock, name, res.entry.plugin ?? body.slug, true);
			}
		} else {
			throw error(400, "source must be 'upload', 'pool' or 'provider'");
		}

		// Whatever route the addon took to get here, the build this instance runs is
		// settled now rather than at the next update sweep. An addon pooled for one
		// game line and added to a backend on another used to arrive as the pool
		// primary, which `deploy` then declines to copy: listed, absent, and with no
		// version control on this screen to correct it. Skipped for an upload, which
		// has no provider to ask and is the operator's own jar either way.
		if (deployHere && body.source !== 'upload') {
			fit = await fitAddonToInstance(cfg, lock, name, entryName, {
				...(wantVersion ? { version: wantVersion } : {})
			});
		}

		await ensureAliases(lock);
		await saveLock(lock);

		const actions = await deploy(cfg, lock, { instances: [name] });

		await ensurePortAllocations(cfg, lock);
		await saveCluster(cfg);
		await saveLock(lock);

		// only now: the new copy is on disk, so removing the old one cannot leave
		// this instance without the addon at all
		let removed: string[] = [];

		if (body.supersede) {
			const outcome = await supersedeAddons(cfg, lock, name, {
				plugins: body.supersede.plugins,
				files: body.supersede.files
			});

			removed = outcome.removed;

			await saveCluster(cfg);
			await saveLock(lock);
		}

		const deployed = actions.filter((action) => action.action !== 'unchanged').length;

		pushEvent(
			name,
			'action',
			`added ${entryName} from ${body.source}` +
				(removed.length ? ` (superseded ${removed.join(', ')})` : '')
		);

		return json({
			ok: true,
			name: entryName,
			deployed,
			removed,
			holdbacks,
			// what this instance ended up running, and the caveats that came with it: a
			// less stable channel accepted on the way to a compatible build, or a pinned
			// choice the build itself does not declare support for
			...(fit?.fitted
				? {
						version: fit.version,
						escalatedTo: fit.escalatedTo,
						pinned: fit.pinned,
						incompatible: fit.incompatible
					}
				: {})
		});
	} catch (err) {
		// a SvelteKit HttpError already carries its own status; anything else is a
		// refusal from core and reads as a bad request
		if (err && typeof err === 'object' && 'status' in err) {
			throw err;
		}

		throw error(400, errorMessage(err));
	}
}

/** The family a body names, defaulting to paper and refusing the undeployable one. */
function familyOf(value: unknown): Exclude<PluginFamily, 'universal'> {
	const family = typeof value === 'string' && PLUGIN_FAMILIES.includes(value as PluginFamily)
		? (value as PluginFamily)
		: 'paper';

	// "universal" describes a jar that carries two descriptors; upstream never
	// publishes one, and an upload declares it deliberately on the pool screen
	return family === 'universal' ? 'paper' : family;
}

/**
 * The data pack half of the POST above, in the packs lock instead of the
 * plugins lock. Before this branch existed the dialog's data pack kind fell
 * through to the jar code, which pooled a pack zip as a paper plugin.
 *
 * The three sources map onto what packs already have: a provider install
 * resolves the newest build compatible with this instance's MC version (the
 * install refuses when none exists, naming the newest build and what it does
 * support), the pool source adds this instance to the pack's targets, and an
 * upload writes the zip into the pool aimed here. Deploying is the same sweep
 * the packs screen runs, scoped to this instance.
 */
async function addDataPack(cfg: ClusterConfig, name: string, body: any): Promise<Response> {
	const lock = await loadPacksLock();
	const deployHere = body.deploy !== false;
	const targets = deployHere ? [name] : [];

	let entryName = '';
	let version: string | undefined;

	try {
		if (body.source === 'upload') {
			const res = await addDataPackFile(cfg, lock, String(body.plugin ?? ''), String(body.data ?? ''), targets);

			entryName = res.name;
		} else if (body.source === 'pool') {
			const pack = String(body.plugin ?? '');
			const entry = lock.datapacks[pack];

			if (!entry) {
				throw error(404, `unknown data pack: ${pack}`);
			}

			if (deployHere && !entry.targets.includes(name)) {
				entry.targets = [...entry.targets, name].sort();
			}

			entryName = pack;
			version = entry.installed?.versionNumber;
		} else if (body.source === 'provider') {
			const provider = (body.provider ?? 'modrinth') as ProviderId;
			const channel = typeof body.channel === 'string' ? body.channel : undefined;

			if (channel !== undefined && !isReleaseChannel(channel)) {
				throw error(400, `unknown channel: ${channel}`);
			}

			const project = await getProject(provider, body.id ?? body.slug, 'datapack');

			if (!project) {
				throw error(404, `${provider} project "${body.slug ?? body.id}" not found`);
			}

			const res = await installDataPackFromProvider(cfg, lock, provider, project, targets, {
				...(channel ? { channel: channel as PackChannel } : {})
			});

			entryName = res.name;
			version = res.entry.installed?.versionNumber;
		} else {
			throw error(400, "source must be 'upload', 'pool' or 'provider'");
		}

		await savePacksLock(lock);

		const actions = deployHere
			? await deployDataPacks(cfg, lock, {
					instances: [name],
					groups: (await loadLock()).groups
				})
			: [];

		pushEvent(name, 'action', `added data pack ${entryName} from ${body.source}`);

		return json({
			ok: true,
			name: entryName,
			deployed: actions.filter((action: { action: string }) => action.action !== 'unchanged').length,
			removed: [],
			holdbacks: [],
			...(version ? { version } : {})
		});
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) {
			throw err;
		}

		throw error(400, errorMessage(err));
	}
}
