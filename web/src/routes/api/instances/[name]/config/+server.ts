// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { json, error } from '@sveltejs/kit';

import { loadCluster, saveCluster, loadLock, saveLock, managedInstances } from '$core/config';
import { setJavaArgs, setPort, setServerProperty, setVersion } from '$core/admin';
import {
	SERVER_SETTINGS,
	SETTING_GROUPS,
	applySettings,
	parseJavaArgs,
	readServerProperties,
	validateSettings
} from '$core/settings';
import { inventory, javaSelection, suggestedFeature, validateRuntimeId } from '$core/runtimes';
import { syncVelocityToml } from '$core/proxy';
import {
	DEFAULT_RESTART_DELAY,
	autoRestartOf,
	getStatus,
	restartDelayOf,
	validateRestartDelay
} from '$core/instances';
import { compatReport, deploy } from '$core/plugins';
import { instanceGroupNames } from '$core/families';
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

	return json({
		memory: inst.memory,
		profile: inst.profile,
		java: inst.java ?? null,
		runtime: inst.runtime ?? null,
		javaArgs: inst.javaArgs ?? [],
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

	const changed: string[] = [];
	const rejected: Array<{ key: string; error: string }> = [];

	if (body.memory) {
		inst.memory = body.memory;
		changed.push('memory');
	}

	if (body.profile) {
		if (!cfg.javaProfiles[body.profile]) {
			throw error(400, `unknown profile ${body.profile}`);
		}

		inst.profile = body.profile;
		changed.push('profile');
	}

	if (body.java !== undefined) {
		inst.java = body.java || undefined;
		changed.push('java');
	}

	if (body.autoRestart !== undefined) {
		// stored only when it departs from the default, so an untouched instance
		// keeps the registry entry it has always had
		inst.autoRestart = body.autoRestart ? undefined : false;
		changed.push('autoRestart');
	}

	if (body.restartDelay !== undefined) {
		const seconds = Number(body.restartDelay);
		const bad = validateRestartDelay(seconds);

		if (bad) {
			throw error(400, bad);
		}

		inst.restartDelay = seconds === DEFAULT_RESTART_DELAY ? undefined : seconds;
		changed.push('restartDelay');
	}

	if (body.runtime !== undefined) {
		const id = String(body.runtime);
		const bad = id ? validateRuntimeId(id) : undefined;

		if (bad) {
			throw error(400, bad);
		}

		inst.runtime = id || undefined;
		changed.push('runtime');
	}

	if (body.javaArgs !== undefined) {
		const args = Array.isArray(body.javaArgs)
			? body.javaArgs.map(String)
			: parseJavaArgs(String(body.javaArgs));

		try {
			setJavaArgs(cfg, name, args);
		} catch (err) {
			throw error(400, (err as Error).message);
		}

		changed.push(args.length ? `javaArgs (${args.length} flag(s))` : 'javaArgs (cleared)');
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
