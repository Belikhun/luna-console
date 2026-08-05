import { json, error } from '@sveltejs/kit';

import { loadEnv, saveEnv, setVariable, unsetVariable, BUILTIN_SECRETS } from '$core/environment';
import { listDaemons } from '$client/daemon';
import { machineKeyFor, machineOptions } from '$shared/machines';
import { pushEvent } from '$lib/server/luna';
import { errorMessage } from '$lib/server/http';

/**
 * A scope from the request body. `machine` and `instance` are mutually
 * exclusive, and a machine arrives as a *name*; the store keys the primary by
 * `""`, which no UI should have to know.
 */
async function scopeFrom(body: {
	machine?: unknown;
	instance?: unknown;
}): Promise<{ machine?: string; instance?: string }> {
	const instance = body.instance ? String(body.instance) : undefined;
	const machine = body.machine ? String(body.machine) : undefined;

	if (instance && machine) {
		throw error(400, 'a variable is scoped to an instance or a machine, not both');
	}

	if (instance) {
		return { instance };
	}

	if (machine) {
		const key = machineKeyFor(await listDaemons(), machine);

		if (key === undefined) {
			throw error(400, `unknown machine: ${machine}`);
		}

		return { machine: key };
	}

	return {};
}

/**
 * GET → every variable, plus the machine and instance overrides. Secret values
 * never leave the server; the client gets `secret: true` and an empty value, at
 * every scope, because an override of a secret name is just as sensitive.
 */
export async function GET() {
	const env = await loadEnv();
	const fleet = await listDaemons();
	const machines = machineOptions(fleet);

	const isSecret = (name: string): boolean =>
		!!env.variables[name]?.secret || BUILTIN_SECRETS.has(name);

	const variables = Object.entries(env.variables).map(([name, def]) => ({
		name,
		value: def.secret ? '' : def.value,
		secret: !!def.secret,
		description: def.description ?? ''
	}));

	const overrides = [
		// `?? {}`: a daemon older than the machine scope answers without the key
		...Object.entries(env.machines ?? {}).flatMap(([key, vars]) =>
			Object.entries(vars).map(([name, value]) => ({
				scope: 'machine' as const,
				// the row is addressed by name everywhere in the UI
				target: machines.find((option) => option.key === key)?.name ?? (key || 'primary'),
				name,
				value: isSecret(name) ? '' : value,
				secret: isSecret(name)
			}))
		),
		...Object.entries(env.instances ?? {}).flatMap(([instance, vars]) =>
			Object.entries(vars).map(([name, value]) => ({
				scope: 'instance' as const,
				target: instance,
				name,
				value: isSecret(name) ? '' : value,
				secret: isSecret(name)
			}))
		)
	];

	return json({
		variables: variables.sort((a, b) => a.name.localeCompare(b.name)),
		overrides: overrides.sort(
			(a, b) => a.name.localeCompare(b.name) || a.target.localeCompare(b.target)
		),
		machines
	});
}

/** POST { name, value, secret?, description?, machine?, instance? } → set a variable. */
export async function POST({ request }) {
	const body = await request.json();
	const scope = await scopeFrom(body);
	const env = await loadEnv();

	try {
		setVariable(env, String(body.name ?? ''), String(body.value ?? ''), {
			...scope,
			secret: !!body.secret,
			description: body.description !== undefined ? String(body.description) : undefined
		});
	} catch (err) {
		throw error(400, errorMessage(err));
	}

	await saveEnv(env);

	const where = scope.instance
		? ` on ${scope.instance}`
		: scope.machine !== undefined
			? ` on machine ${body.machine}`
			: '';

	pushEvent('env', 'action', `variable ${body.name} set${where}`);

	return json({ ok: true });
}

/** DELETE ?name=&machine=|&instance= → remove a variable or one override. */
export async function DELETE({ url }) {
	const name = url.searchParams.get('name') ?? '';
	const scope = await scopeFrom({
		machine: url.searchParams.get('machine') ?? undefined,
		instance: url.searchParams.get('instance') ?? undefined
	});
	const env = await loadEnv();

	if (!unsetVariable(env, name, scope)) {
		throw error(404, `${name} is not set at that scope`);
	}

	await saveEnv(env);

	const where = scope.instance
		? ` from ${scope.instance}`
		: scope.machine !== undefined
			? ` from machine ${url.searchParams.get('machine')}`
			: '';

	pushEvent('env', 'action', `variable ${name} removed${where}`);

	return json({ ok: true });
}
