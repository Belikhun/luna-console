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
import { syncVelocityToml } from '$core/proxy';
import { getStatus } from '$core/instances';
import { compatReport, deploy } from '$core/plugins';
import { pushEvent } from '$lib/server/mrds';
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
	// gets a field — showing the default it will boot with
	const settings = Object.fromEntries(
		SERVER_SETTINGS.map((spec) => [spec.key, properties[spec.key] ?? spec.fallback])
	);

	return json({
		memory: inst.memory,
		profile: inst.profile,
		java: inst.java ?? null,
		javaArgs: inst.javaArgs ?? [],
		port: inst.port,
		mcVersion: inst.mcVersion ?? null,
		profiles: Object.keys(cfg.javaProfiles),
		schema: SERVER_SETTINGS,
		groups: SETTING_GROUPS,
		settings,
		serverProperties: properties,
		pluginGroups: inst.pluginGroups ?? [],
		software: inst.software
	});
}

/**
 * PATCH { memory?, profile?, java?, javaArgs?, port?, settings?, properties?,
 *         mcVersion?, forceVersion? }
 *
 * Everything except a version change applies immediately and answers with what it
 * touched. A version change downloads a server jar, so it answers with a job the
 * client watches instead — see /api/jobs/[id].
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
		await setPort(cfg, name, Number(body.port));
		await syncVelocityToml(cfg);
		changed.push('port');
	}

	if (Array.isArray(body.pluginGroups)) {
		const groups = body.pluginGroups.map(String).filter((group: string) => group !== 'default');
		const unknown = groups.filter((group: string) => !lock.groups?.[group]);

		if (unknown.length) {
			throw error(400, `unknown plugin group(s): ${unknown.join(', ')}`);
		}

		const before = inst.pluginGroups ?? [];
		const different =
			before.length !== groups.length || groups.some((group: string) => !before.includes(group));

		if (different) {
			if (groups.length) {
				inst.pluginGroups = groups;
			} else {
				delete inst.pluginGroups;
			}

			// membership changed — push the union of old and new coverage right away
			await saveCluster(cfg);

			const actions = await deploy(cfg, lock, { instances: [name] });

			await saveLock(lock);

			const jars = actions.filter(
				(action) => action.action !== 'unchanged' && action.action !== 'config'
			).length;

			changed.push(`pluginGroups (${groups.join(', ') || 'default only'}; ${jars} jar(s) touched)`);
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

		// server-version gate per DESIGN.md — the client re-sends with forceVersion
		const incompatible = compatReport(cfg, lock, name, body.mcVersion).filter(
			(row) => row.status === 'incompatible'
		);

		if (incompatible.length && !body.forceVersion) {
			return json({ ok: false, incompatible }, { status: 409 });
		}

		// persist the edits made above before the job reloads the registry from disk
		await saveCluster(cfg);

		const version = String(body.mcVersion);

		const job = startJob('instance-version', name, `${name} → ${version}`, async (reporter) => {
			const fresh = await loadCluster();
			const res = await setVersion(fresh, name, version, reporter);

			await saveCluster(fresh);

			pushEvent(
				name,
				'action',
				`version ${res.from ?? '?'} → ${res.to} (build ${res.build.build})`
			);

			return { from: res.from ?? null, to: res.to, build: res.build.build };
		});

		return json({ ok: true, changed, rejected, job });
	}

	await saveCluster(cfg);

	if (changed.length) {
		pushEvent(name, 'action', `config changed: ${changed.join(', ')}`);
	}

	return json({ ok: true, changed, rejected });
}
