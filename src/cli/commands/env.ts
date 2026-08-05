import { command, UsageError, Bail } from "../framework";
import { pc, ok, info, warn, printTable, ProgressView } from "../ui";
import { ProgressReporter } from "../../core/progress";
import { instanceNames, machineNames } from "../completers";
import { loadCluster, managedInstances } from "../../client/core/config";
import {
	BUILTIN_SECRETS,
	loadEnv,
	resolveDetailed,
	saveEnv,
	setVariable,
	unsetVariable,
	writeEnvFile,
	type EnvScope,
	type ScopeTarget,
} from "../../client/core/environment";
import { listDaemons } from "../../client/daemon";
import { machineKeyFor, machineNameFor } from "../../shared/machines";

const MASK = "••••••••";

/**
 * Turn `--machine <name>` / `--instance <name>` into the store's scope target.
 * A machine is named, never keyed, at the CLI — the primary's key is `""`, and
 * asking an operator to type that would be absurd.
 */
async function scopeFrom(opts: Record<string, unknown>): Promise<ScopeTarget> {
	const instance = opts.instance as string | undefined;
	const machine = opts.machine as string | undefined;

	if (instance && machine) {
		throw new UsageError("--instance and --machine are different scopes; pass one");
	}

	if (instance) {
		const cfg = await loadCluster();

		if (!managedInstances(cfg)[instance]) {
			throw new UsageError(`unknown instance: ${instance}`);
		}

		return { instance };
	}

	if (machine) {
		const key = machineKeyFor(await listDaemons(), machine);

		if (key === undefined) {
			throw new UsageError(`unknown machine: ${machine}`);
		}

		return { machine: key };
	}

	return {};
}

/** How a scope reads in a sentence, e.g. " on lobby". */
function scopeLabel(scope: ScopeTarget, machineName?: string): string {
	if (scope.instance !== undefined) {
		return ` on ${pc.bold(scope.instance)}`;
	}

	if (scope.machine !== undefined) {
		return ` on machine ${pc.bold(machineName ?? scope.machine ?? "primary")}`;
	}

	return "";
}

/** Colour a scope the way the tables do, weakest to strongest. */
function paintScope(scope: EnvScope): string {
	switch (scope) {
		case "builtin":
			return pc.dim("builtin");

		case "global":
			return pc.blue("global");

		case "machine":
			return pc.yellow("machine");

		case "instance":
			return pc.cyan("instance");
	}
}

command({
	path: ["env"],
	desc: "List environment variables (injected at startup, and read by templates as ${NAME})",
	opts: [
		{ flag: "--instance", desc: "resolve for this instance, showing what wins", value: true, complete: instanceNames },
		{ flag: "--machine", desc: "show this machine's overrides", value: true, complete: machineNames },
		{ flag: "--reveal", desc: "show secret values instead of masking them" },
	],

	handler: async (_args, opts) => {
		const env = await loadEnv();
		const instance = opts.instance as string | undefined;
		const reveal = !!opts.reveal;
		const rows: string[][] = [];

		// with an instance, the interesting thing is not the store but what that
		// instance actually resolves — and which scope won
		if (instance) {
			const cfg = await loadCluster();

			if (!managedInstances(cfg)[instance]) {
				throw new UsageError(`unknown instance: ${instance}`);
			}

			for (const entry of await resolveDetailed(cfg, env, instance)) {
				const value = entry.secret && !reveal ? pc.dim(MASK) : entry.value;
				const shadowed = entry.shadowed.length
					? pc.dim(`overrides ${entry.shadowed.map((prev) => prev.scope).join(", ")}`)
					: pc.dim(entry.description ?? "");

				rows.push([entry.name, value, paintScope(entry.scope), shadowed]);
			}

			console.log();
			info(`resolved for ${pc.bold(instance)} — builtin < global < machine < instance`);
			printTable(rows, { head: ["name", "value", "scope", ""] });
			console.log();

			return;
		}

		const machine = opts.machine as string | undefined;

		if (machine) {
			const fleet = await listDaemons();
			const key = machineKeyFor(fleet, machine);

			if (key === undefined) {
				throw new UsageError(`unknown machine: ${machine}`);
			}

			// a daemon older than the machine scope answers without the key at all
			for (const [name, value] of Object.entries(env.machines?.[key] ?? {})) {
				const secret = env.variables[name]?.secret || BUILTIN_SECRETS.has(name);

				rows.push([name, secret && !reveal ? pc.dim(MASK) : value, paintScope("machine")]);
			}

			if (!rows.length) {
				info(`${machine} has no machine-scoped overrides`);

				return;
			}

			console.log();
			printTable(rows, { head: ["name", "value", "scope"] });
			console.log();

			return;
		}

		for (const [name, def] of Object.entries(env.variables)) {
			const value = def.secret && !reveal ? pc.dim(MASK) : def.value;

			rows.push([name, value, paintScope("global"), pc.dim(def.description ?? "")]);
		}

		const fleet = await listDaemons();

		for (const [key, vars] of Object.entries(env.machines ?? {})) {
			for (const [name, value] of Object.entries(vars)) {
				const secret = env.variables[name]?.secret || BUILTIN_SECRETS.has(name);

				rows.push([
					pc.yellow(name),
					secret && !reveal ? pc.dim(MASK) : value,
					paintScope("machine"),
					pc.dim(machineNameFor(fleet, key)),
				]);
			}
		}

		for (const [inst, vars] of Object.entries(env.instances)) {
			for (const [name, value] of Object.entries(vars)) {
				const secret = env.variables[name]?.secret || BUILTIN_SECRETS.has(name);

				rows.push([
					pc.cyan(name),
					secret && !reveal ? pc.dim(MASK) : value,
					paintScope("instance"),
					pc.dim(inst),
				]);
			}
		}

		if (!rows.length) {
			info("no variables defined — set one with: luna env set NAME value");

			return;
		}

		console.log();
		printTable(rows, { head: ["name", "value", "scope", ""] });
		console.log();
		info(`builtins are per-instance — see them with ${pc.bold("luna env --instance <name>")}`);
	},
});

command({
	path: ["env", "set"],
	desc: "Set a variable, globally or as a machine/instance override",
	args: [
		{ name: "name", required: true },
		{ name: "value", required: true, variadic: true },
	],
	opts: [
		{ flag: "--instance", desc: "override for this instance only", value: true, complete: instanceNames },
		{ flag: "--machine", desc: "override for every instance on this machine", value: true, complete: machineNames },
		{ flag: "--secret", desc: "mask the value in every UI" },
		{ flag: "--description", desc: "what the variable is for", value: true },
	],

	handler: async (args, opts) => {
		const [name, ...valueParts] = args as [string, ...string[]];
		const scope = await scopeFrom(opts);
		const env = await loadEnv();

		setVariable(env, name, valueParts.join(" "), {
			...scope,
			secret: !!opts.secret,
			description: opts.description as string | undefined,
		});

		await saveEnv(env);

		ok(
			`${pc.bold(name)} set${scopeLabel(scope, opts.machine as string | undefined)} ` +
				pc.dim("(instances pick it up on their next start)"),
		);
	},
});

command({
	path: ["env", "unset"],
	desc: "Remove a variable, or one machine's/instance's override",
	args: [{ name: "name", required: true }],
	opts: [
		{ flag: "--instance", desc: "remove this instance's override only", value: true, complete: instanceNames },
		{ flag: "--machine", desc: "remove this machine's override only", value: true, complete: machineNames },
	],

	handler: async (args, opts) => {
		const scope = await scopeFrom(opts);
		const env = await loadEnv();
		const name = args[0]!;

		if (!unsetVariable(env, name, scope)) {
			throw new Bail(`${name} is not set${scopeLabel(scope, opts.machine as string | undefined)}`);
		}

		await saveEnv(env);
		ok(`${pc.bold(name)} removed${scopeLabel(scope, opts.machine as string | undefined)}`);
		warn("instances keep the old value until they restart");
	},
});

command({
	path: ["env", "inject"],
	desc: "Rewrite an instance's .luna-env from the store (takes effect on its next start)",
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const instance = args[0]!;

		if (!managedInstances(cfg)[instance]) {
			throw new UsageError(`unknown instance: ${instance}`);
		}

		const path = await writeEnvFile(cfg, instance);

		ok(`wrote ${pc.dim(path)}`);
		info("the JVM reads it at startup — restart the instance to apply");
	},
});

command({
	path: ["env", "apply"],
	desc: "Re-apply every config template and managed config file to an instance",
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const instance = args[0]!;

		if (!managedInstances(cfg)[instance]) {
			throw new UsageError(`unknown instance: ${instance}`);
		}

		const { loadLock } = await import("../../client/core/config");
		const { applyTemplates, notableTemplateResults } = await import("../../client/core/templates");
		const { renderManagedFiles } = await import("../../client/core/configfiles");

		// the plugin-owned half: per-entry `config` ops, surgical key edits
		const results = await applyTemplates(cfg, await loadLock(), instance);
		const notable = notableTemplateResults(results);

		if (!notable.length) {
			ok(`${instance}: every templated value already in place (${results.length} checked)`);
		}

		for (const result of notable) {
			const line =
				`${result.plugin} ${pc.dim(result.file)} ${result.key ?? ""} ${result.outcome}` +
				(result.detail ? pc.dim(` ${result.detail}`) : "");

			if (result.outcome === "set" || result.outcome === "wrote") {
				ok(line);
			} else {
				warn(line);
			}
		}

		// the operator-owned half: whole-file templates edited in the console
		const progress = new ProgressReporter(`render ${instance}`);
		const view = new ProgressView(progress).start();
		let rendered: Awaited<ReturnType<typeof renderManagedFiles>>;

		try {
			rendered = await renderManagedFiles(cfg, instance, progress);
		} finally {
			view.stop();
		}

		for (const result of rendered) {
			const line = `${pc.dim(result.path)} ${result.outcome}${result.detail ? pc.dim(` — ${result.detail}`) : ""}`;

			if (result.outcome === "written") {
				ok(line);
			} else if (result.outcome !== "unchanged") {
				warn(line);
			}
		}

		const changed = rendered.filter((result) => result.outcome !== "unchanged").length;

		if (rendered.length && !changed) {
			ok(`${instance}: ${rendered.length} managed config file(s) already up to date`);
		}
	},
});
