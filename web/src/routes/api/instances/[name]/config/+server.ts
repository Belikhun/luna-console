// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import {
	loadCluster,
	saveCluster,
	loadLock,
	saveLock,
	managedInstances,
	addonDirForFamily
} from '$core/config';
import { applyInstanceOptions, setPort, setServerProperty, setVersion } from '$core/admin';
import type { InstanceOptionUpdate } from '$core/admin';
import {
	SERVER_SETTINGS,
	SETTING_GROUPS,
	parseJavaAgents,
	parseJavaArgs,
	validateSettings
} from '$core/settings';
import { applySettings, readServerProperties } from '$core/services/settings';
import { inventory, javaSelection, suggestedFeature } from '$core/runtimes';
import { syncVelocityToml } from '$core/proxy';
import { autoRestartOf, getStatus, restartDelayOf } from '$core/instances';
import { compatReport, deploy } from '$core/plugins';
import { effectiveTargets, instanceGroupNames } from '$core/families';
import { traitsOf } from '$core/software';
import { loadPacksLock, savePacksLock } from '$core/packslock';
import { applyAddonGroups } from '$core/addons';
import { pushEvent } from '$lib/server/luna';
import { startJob } from '$lib/server/jobs';

/** GET → the instance's editable settings, the settings schema, and its raw server.properties. */
export async function GET({ params }) {
	const cfg = await loadCluster();
	const inst = managedInstances(cfg)[params.name];

	if (!inst) {
		throw error(404, 'unknown instance');
	}

	const properties = await readServerProperties(cfg, params.name);

	// the form renders from the schema, so a key Paper has not written yet still
	// gets a field; showing the default it will boot with
	const settings = Object.fromEntries(
		SERVER_SETTINGS.map((spec) => [spec.key, properties[spec.key] ?? spec.fallback])
	);

	// what this instance's own machine has installed, so the runtime picker can
	// mark a choice the machine does not hold yet rather than hiding it: starting
	// installs it, which is exactly what an operator picking it wants
	const machine = inst.daemon ?? '';
	const fleet = await inventory(cfg);
	const machineRuntimes = fleet.find((row) => row.machine === machine)?.runtimes ?? null;

	// the addons this instance is actually given, so the java-agent picker offers
	// the ones deploy will put there rather than the whole pool: an agent naming an
	// addon this instance never receives is a server that refuses to start
	const lock = await loadLock();
	const addons = Object.entries(lock.plugins)
		.filter(([key]) => effectiveTargets(cfg, lock, key).includes(params.name))
		.map(([key, entry]) => ({
			key,
			path: `${addonDirForFamily(entry.family)}/${entry.file}`,
			version: entry.installed?.versionNumber ?? null
		}));

	return json({
		memory: inst.memory,
		profile: inst.profile,
		java: inst.java ?? null,
		runtime: inst.runtime ?? null,
		javaArgs: inst.javaArgs ?? [],
		javaAgents: inst.javaAgents ?? [],
		// the server's own jar sits in the same directory the agent picker lists,
		// and it is the one jar there that can never be an agent
		binaryName: traitsOf(inst.software, inst.mcVersion).binaryName ?? null,
		addons,
		autoRestart: autoRestartOf(inst),
		restartDelay: restartDelayOf(inst),
		port: inst.port,
		mcVersion: inst.mcVersion ?? null,
		profiles: Object.keys(cfg.javaProfiles),
		profileDetails: Object.fromEntries(
			Object.entries(cfg.javaProfiles).map(([key, profile]) => [
				key,
				{ java: profile.java ?? null, runtime: profile.runtime ?? null }
			])
		),
		machineRuntimes,
		selection: javaSelection(cfg, inst),
		suggestedFeature: suggestedFeature(inst.mcVersion),
		schema: SERVER_SETTINGS,
		groups: SETTING_GROUPS,
		settings,
		serverProperties: properties,
		addonGroups: instanceGroupNames(inst).filter((group) => group !== 'default'),
		software: inst.software
	});
}

/**
 * PATCH { memory?, profile?, java?, javaArgs?, port?, settings?, properties?,
 *         mcVersion?, forceVersion? }
 *
 * Everything except a version change applies immediately and answers with what it
 * touched. A version change downloads a server jar, so it answers with a job the
 * client watches instead; see /api/jobs/[id].
 */
export async function PATCH({ params, request }) {
	const body = await request.json();
	const cfg = await loadCluster();
	const lock = await loadLock();
	const name = params.name;
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw error(404, 'unknown instance');
	}

	const rejected: Array<{ key: string; error: string }> = [];

	// every registry field goes through one validated core path, the same one the
	// CLI's `instance config` uses; nothing is written unless all of it passes
	const update: InstanceOptionUpdate = {};

	if (body.memory) {
		update.memory = String(body.memory);
	}

	if (body.profile) {
		update.profile = String(body.profile);
	}

	if (body.java !== undefined) {
		update.java = String(body.java) || null;
	}

	if (body.runtime !== undefined) {
		update.runtime = String(body.runtime) || null;
	}

	if (body.autoRestart !== undefined) {
		update.autoRestart = !!body.autoRestart;
	}

	if (body.restartDelay !== undefined) {
		update.restartDelay = Number(body.restartDelay);
	}

	if (body.javaArgs !== undefined) {
		update.javaArgs = Array.isArray(body.javaArgs)
			? body.javaArgs.map(String)
			: parseJavaArgs(String(body.javaArgs));
	}

	if (body.javaAgents !== undefined) {
		update.javaAgents = Array.isArray(body.javaAgents)
			? body.javaAgents.map(String)
			: parseJavaAgents(String(body.javaAgents));
	}

	let changed: string[] = [];

	try {
		changed = applyInstanceOptions(cfg, name, update).changed;
	} catch (err) {
		throw error(400, (err as Error).message);
	}

	if (body.port) {
		// the port is checked against its own machine's allocations; a clash is the
		// caller's mistake, so it comes back as a 400 with the reason, not a 500
		try {
			await setPort(cfg, name, Number(body.port));
		} catch (err) {
			throw error(400, (err as Error).message);
		}

		await syncVelocityToml(cfg);
		changed.push('port');
	}

	if (Array.isArray(body.addonGroups)) {
		const groups = body.addonGroups.map(String).filter((group: string) => group !== 'default');
		const unknown = groups.filter((group: string) => !lock.groups?.[group]);

		if (unknown.length) {
			throw error(400, `unknown addon group(s): ${unknown.join(', ')}`);
		}

		const before = instanceGroupNames(inst).filter((group) => group !== 'default');
		const different =
			before.length !== groups.length || groups.some((group: string) => !before.includes(group));

		if (different) {
			if (groups.length) {
				inst.addonGroups = groups;
			} else {
				delete inst.addonGroups;
			}

			// membership changed; push the union of old and new coverage right away
			await saveCluster(cfg);

			const actions = await deploy(cfg, lock, { instances: [name] });

			await saveLock(lock);

			const jars = actions.filter(
				(action) => action.action !== 'unchanged' && action.action !== 'config'
			).length;

			// the pack half of the same change: rules the proxy reads, world zips
			const packsLock = await loadPacksLock();
			const applied = await applyAddonGroups(cfg, packsLock, lock.groups, { instances: [name] });

			await savePacksLock(packsLock);

			const packs =
				applied.respacks.length +
				applied.datapacks.filter((action) => action.action !== 'unchanged').length;

			changed.push(
				`addonGroups (${groups.join(', ') || 'default only'}; ` +
					`${jars} jar(s), ${packs} pack change(s))`
			);
		}
	}

	// the schema-backed settings form, validated as a batch before anything is written
	if (body.settings) {
		const problems = validateSettings(body.settings as Record<string, string>);

		if (problems.length) {
			throw error(400, problems.map((problem) => problem.error).join('; '));
		}

		const res = await applySettings(cfg, name, body.settings as Record<string, string>);

		for (const change of res.changed) {
			changed.push(`${change.key}=${change.to || '(blank)'}`);
		}

		rejected.push(...res.rejected);
	}

	// raw escape hatch: any server.properties key, spec'd or not
	if (body.properties) {
		for (const [key, value] of Object.entries(body.properties as Record<string, string>)) {
			if (await setServerProperty(cfg, name, key, String(value))) {
				changed.push(`server.properties:${key}`);
			}
		}
	}

	if (body.mcVersion && body.mcVersion !== inst.mcVersion) {
		const status = await getStatus(cfg, name);

		if (status.state !== 'stopped') {
			throw error(409, 'stop the instance before changing its version');
		}

		// server-version gate per DESIGN.md; the client re-sends with forceVersion
		const incompatible = compatReport(cfg, lock, name, body.mcVersion).filter(
			(row) => row.status === 'incompatible'
		);

		if (incompatible.length && !body.forceVersion) {
			return json({ ok: false, incompatible }, { status: 409 });
		}

		// persist the edits made above before the job reloads the registry from disk
		await saveCluster(cfg);

		const version = String(body.mcVersion);

		const loaderVersion = body.loaderVersion ? String(body.loaderVersion) : undefined;

		const job = startJob('instance-version', name, `${name} → ${version}`, async (reporter) => {
			const fresh = await loadCluster();
			const res = await setVersion(fresh, name, { mcVersion: version, loaderVersion }, reporter);

			await saveCluster(fresh);

			pushEvent(
				name,
				'action',
				`version ${res.from ?? '?'} → ${res.to} (build ${res.build.buildId})`
			);

			return { from: res.from ?? null, to: res.to, build: res.build.buildId };
		});

		return json({ ok: true, changed, rejected, job });
	}

	await saveCluster(cfg);

	if (changed.length) {
		pushEvent(name, 'action', `config changed: ${changed.join(', ')}`);
	}

	return json({ ok: true, changed, rejected });
}
