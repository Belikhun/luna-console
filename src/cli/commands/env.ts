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
import { t } from "../../shared/i18n";

const MASK = "••••••••";

/**
 * Turn `--machine <name>` / `--instance <name>` into the store's scope target.
 * A machine is named, never keyed, at the CLI. The primary's key is `""`, and
 * asking an operator to type that would be absurd.
 */
async function scopeFrom(opts: Record<string, unknown>): Promise<ScopeTarget> {
	const instance = opts.instance as string | undefined;
	const machine = opts.machine as string | undefined;

	if (instance && machine) {
		throw new UsageError(t("cli.env.scopeConflict"));
	}

	if (instance) {
		const cfg = await loadCluster();

		if (!managedInstances(cfg)[instance]) {
			throw new UsageError(t("cli.env.unknownInstance", { name: instance }));
		}

		return { instance };
	}

	if (machine) {
		const key = machineKeyFor(await listDaemons(), machine);

		if (key === undefined) {
			throw new UsageError(t("cli.env.unknownMachine", { name: machine }));
		}

		return { machine: key };
	}

	return {};
}

/** How a scope reads in a sentence, e.g. " on lobby". */
function scopeLabel(scope: ScopeTarget, machineName?: string): string {
	if (scope.instance !== undefined) {
		return ` ${t("cli.env.onInstance", { name: pc.bold(scope.instance) })}`;
	}

	if (scope.machine !== undefined) {
		return ` ${t("cli.env.onMachine", { name: pc.bold(machineName ?? scope.machine ?? "primary") })}`;
	}

	return "";
}

/** Colour a scope the way the tables do, weakest to strongest. */
function paintScope(scope: EnvScope): string {
	switch (scope) {
		case "builtin":
			return pc.dim(t("cli.env.scopeBuiltin"));

		case "global":
			return pc.blue(t("cli.env.scopeGlobal"));

		case "machine":
			return pc.yellow(t("cli.env.scopeMachine"));

		case "instance":
			return pc.cyan(t("cli.env.scopeInstance"));
	}
}

command({
	path: ["env"],
	desc: t("cli.env.list.desc"),
	opts: [
		{ flag: "--instance", desc: t("cli.env.list.optInstance"), value: true, complete: instanceNames },
		{ flag: "--machine", desc: t("cli.env.list.optMachine"), value: true, complete: machineNames },
		{ flag: "--reveal", desc: t("cli.env.list.optReveal") },
	],

	handler: async (_args, opts) => {
		const env = await loadEnv();
		const instance = opts.instance as string | undefined;
		const reveal = !!opts.reveal;
		const rows: string[][] = [];

		// with an instance, the interesting thing is not the store but what that
		// instance actually resolves, and which scope won
		if (instance) {
			const cfg = await loadCluster();

			if (!managedInstances(cfg)[instance]) {
				throw new UsageError(t("cli.env.unknownInstance", { name: instance }));
			}

			for (const entry of await resolveDetailed(cfg, env, instance)) {
				const value = entry.secret && !reveal ? pc.dim(MASK) : entry.value;
				const shadowed = entry.shadowed.length
					? pc.dim(
							t("cli.env.list.overrides", {
								scopes: entry.shadowed.map((prev) => prev.scope).join(", "),
							}),
						)
					: pc.dim(entry.description ?? "");

				rows.push([entry.name, value, paintScope(entry.scope), shadowed]);
			}

			console.log();
			info(t("cli.env.list.resolvedFor", { name: pc.bold(instance) }));
			printTable(rows, {
				head: [t("cli.head.name"), t("cli.head.value"), t("cli.head.scope"), ""],
			});
			console.log();

			return;
		}

		const machine = opts.machine as string | undefined;

		if (machine) {
			const fleet = await listDaemons();
			const key = machineKeyFor(fleet, machine);

			if (key === undefined) {
				throw new UsageError(t("cli.env.unknownMachine", { name: machine }));
			}

			// a daemon older than the machine scope answers without the key at all
			for (const [name, value] of Object.entries(env.machines?.[key] ?? {})) {
				const secret = env.variables[name]?.secret || BUILTIN_SECRETS.has(name);

				rows.push([name, secret && !reveal ? pc.dim(MASK) : value, paintScope("machine")]);
			}

			if (!rows.length) {
				info(t("cli.env.list.noMachineOverrides", { name: machine }));

				return;
			}

			console.log();
			printTable(rows, {
				head: [t("cli.head.name"), t("cli.head.value"), t("cli.head.scope")],
			});
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
			info(t("cli.env.list.empty"));

			return;
		}

		console.log();
		printTable(rows, {
			head: [t("cli.head.name"), t("cli.head.value"), t("cli.head.scope"), ""],
		});
		console.log();
		info(t("cli.env.list.builtinsHint", { command: pc.bold("luna env --instance <name>") }));
	},
});

command({
	path: ["env", "set"],
	desc: t("cli.env.set.desc"),
	args: [
		{ name: "name", required: true },
		{ name: "value", required: true, variadic: true },
	],
	opts: [
		{ flag: "--instance", desc: t("cli.env.set.optInstance"), value: true, complete: instanceNames },
		{ flag: "--machine", desc: t("cli.env.set.optMachine"), value: true, complete: machineNames },
		{ flag: "--secret", desc: t("cli.env.set.optSecret") },
		{ flag: "--description", desc: t("cli.env.set.optDescription"), value: true },
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
			`${t("cli.env.set.done", { name: pc.bold(name) })}${scopeLabel(scope, opts.machine as string | undefined)} ` +
				pc.dim(t("cli.env.set.pickupNote")),
		);
	},
});

command({
	path: ["env", "unset"],
	desc: t("cli.env.unset.desc"),
	args: [{ name: "name", required: true }],
	opts: [
		{ flag: "--instance", desc: t("cli.env.unset.optInstance"), value: true, complete: instanceNames },
		{ flag: "--machine", desc: t("cli.env.unset.optMachine"), value: true, complete: machineNames },
	],

	handler: async (args, opts) => {
		const scope = await scopeFrom(opts);
		const env = await loadEnv();
		const name = args[0]!;

		if (!unsetVariable(env, name, scope)) {
			throw new Bail(
				`${t("cli.env.unset.notSet", { name })}${scopeLabel(scope, opts.machine as string | undefined)}`,
			);
		}

		await saveEnv(env);
		ok(
			`${t("cli.env.unset.done", { name: pc.bold(name) })}${scopeLabel(scope, opts.machine as string | undefined)}`,
		);
		warn(t("cli.env.unset.restartNote"));
	},
});

command({
	path: ["env", "inject"],
	desc: t("cli.env.inject.desc"),
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const instance = args[0]!;

		if (!managedInstances(cfg)[instance]) {
			throw new UsageError(t("cli.env.unknownInstance", { name: instance }));
		}

		const path = await writeEnvFile(cfg, instance);

		ok(t("cli.env.inject.wrote", { path: pc.dim(path) }));
		info(t("cli.env.inject.applyNote"));
	},
});

command({
	path: ["env", "apply"],
	desc: t("cli.env.apply.desc"),
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const instance = args[0]!;

		if (!managedInstances(cfg)[instance]) {
			throw new UsageError(t("cli.env.unknownInstance", { name: instance }));
		}

		const { loadLock } = await import("../../client/core/config");
		const { applyTemplates, notableTemplateResults } = await import("../../client/core/templates");
		const { renderManagedFiles } = await import("../../client/core/configfiles");

		// the plugin-owned half: per-entry `config` ops, surgical key edits
		const results = await applyTemplates(cfg, await loadLock(), instance);
		const notable = notableTemplateResults(results);

		if (!notable.length) {
			ok(t("cli.env.apply.templatesInPlace", { name: instance, count: results.length }));
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
			const line = `${pc.dim(result.path)} ${result.outcome}${result.detail ? pc.dim(` · ${result.detail}`) : ""}`;

			if (result.outcome === "written") {
				ok(line);
			} else if (result.outcome !== "unchanged") {
				warn(line);
			}
		}

		const changed = rendered.filter((result) => result.outcome !== "unchanged").length;

		if (rendered.length && !changed) {
			ok(t("cli.env.apply.filesUpToDate", { name: instance, count: rendered.length }));
		}
	},
});
