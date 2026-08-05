import { json, error } from '@sveltejs/kit';

import { loadCluster, loadLock } from '$core/config';
import { BUILTIN_SECRETS, builtinVars, loadEnv, scopesOf } from '$core/environment';
import { variableUsage } from '$core/configfiles';
import { listDaemons } from '$client/daemon';
import { machineNameFor, machineOptions } from '$shared/machines';
import { errorMessage } from '$lib/server/http';

/**
 * One variable as an object: every scope that defines it, everywhere it is
 * referenced from, what each instance resolves it to, and its change trail.
 *
 * Secret values are still withheld here; the reveal endpoint is the only way
 * out, because that is what gets recorded.
 */
export async function GET({ params }) {
	const name = params.name;
	const cfg = await loadCluster();
	const env = await loadEnv();
	const fleet = await listDaemons();

	const def = env.variables[name];
	const scopes = scopesOf(env, name);

	// a builtin is computed per instance rather than stored, so it has no scopes of
	// its own; the screen still has to be able to explain one
	let builtin = false;

	try {
		const first = Object.keys(cfg.instances)[0];

		if (first) {
			builtin = name in (await builtinVars(cfg, first));
		}
	} catch {
		// no instance to compute against; treat it as not builtin
	}

	if (!def && !scopes.length && !builtin) {
		throw error(404, `${name} is not defined`);
	}

	const secret = !!def?.secret || BUILTIN_SECRETS.has(name);

	let usage;

	try {
		usage = await variableUsage(cfg, await loadLock(), name);
	} catch (err) {
		throw error(500, errorMessage(err));
	}

	return json({
		name,
		builtin,
		secret,
		description: def?.description ?? '',
		updatedAt: def?.updatedAt ?? null,
		defined: !!def,
		machines: machineOptions(fleet),
		scopes: scopes.map((entry) => ({
			scope: entry.scope,
			target: entry.target ?? null,
			// the machine's *name*, since "" is the primary's key and unreadable
			targetLabel:
				entry.scope === 'machine' ? machineNameFor(fleet, entry.target ?? '') : (entry.target ?? null),
			value: secret ? '' : entry.value
		})),
		references: usage.references,
		consumers: usage.consumers.map((consumer) => ({
			...consumer,
			value: secret ? '' : consumer.value,
			machineLabel: machineNameFor(fleet, consumer.machine)
		})),
		history: (env.history ?? [])
			.filter((entry) => entry.name === name)
			.slice()
			.reverse()
			.map((entry) => ({
				...entry,
				targetLabel:
					entry.scope === 'machine' ? machineNameFor(fleet, entry.target ?? '') : (entry.target ?? null)
			}))
	});
}
