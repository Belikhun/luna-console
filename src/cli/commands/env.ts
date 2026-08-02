import { command, UsageError, Bail } from "../framework";
import { pc, ok, info, warn, printTable } from "../ui";
import { instanceNames } from "../completers";
import { loadCluster, managedInstances } from "../../client/core/config";
import { builtinVars, loadEnv, saveEnv, setVariable, unsetVariable } from "../../client/core/environment";

command({
	path: ["env"],
	desc: "List environment variables (config templates read them as ${NAME})",
	opts: [
		{ flag: "--instance", desc: "include this instance's overrides and builtins", value: true },
		{ flag: "--reveal", desc: "show secret values instead of masking them" },
	],

	handler: async (_args, opts) => {
		const env = await loadEnv();
		const instance = opts.instance as string | undefined;
		const rows: string[][] = [];

		if (instance) {
			const cfg = await loadCluster();

			if (!managedInstances(cfg)[instance]) {
				throw new UsageError(`unknown instance: ${instance}`);
			}

			for (const [name, value] of Object.entries(await builtinVars(cfg, instance))) {
				const masked = name === "MRDS_FORWARDING_SECRET" && !opts.reveal ? pc.dim("••••••••") : value;

				rows.push([pc.dim(name), masked, pc.dim("builtin")]);
			}
		}

		for (const [name, def] of Object.entries(env.variables)) {
			const value = def.secret && !opts.reveal ? pc.dim("••••••••") : def.value;

			rows.push([name, value, pc.dim(def.description ?? "")]);
		}

		if (instance) {
			for (const [name, value] of Object.entries(env.instances[instance] ?? {})) {
				rows.push([pc.cyan(name), value, pc.dim(`override on ${instance}`)]);
			}
		}

		if (!rows.length) {
			info("no variables defined — set one with: mrds env set NAME value");

			return;
		}

		console.log();
		printTable(rows, { head: ["name", "value", ""] });
		console.log();
	},
});

command({
	path: ["env", "set"],
	desc: "Set a variable (global, or one instance's override)",
	args: [
		{ name: "name", required: true },
		{ name: "value", required: true, variadic: true },
	],
	opts: [
		{ flag: "--instance", desc: "set as an override for this instance", value: true, complete: instanceNames },
		{ flag: "--secret", desc: "mask the value in every UI" },
		{ flag: "--description", desc: "what the variable is for", value: true },
	],

	handler: async (args, opts) => {
		const [name, ...valueParts] = args as [string, ...string[]];
		const env = await loadEnv();

		setVariable(env, name, valueParts.join(" "), {
			secret: !!opts.secret,
			description: opts.description as string | undefined,
			instance: opts.instance as string | undefined,
		});

		await saveEnv(env);

		const scope = opts.instance ? ` on ${pc.bold(String(opts.instance))}` : "";

		ok(`${pc.bold(name)} set${scope} ${pc.dim("(templates apply it on the next deploy)")}`);
	},
});

command({
	path: ["env", "unset"],
	desc: "Remove a variable (global, or one instance's override)",
	args: [{ name: "name", required: true }],
	opts: [
		{ flag: "--instance", desc: "remove this instance's override only", value: true, complete: instanceNames },
	],

	handler: async (args, opts) => {
		const env = await loadEnv();
		const name = args[0]!;

		if (!unsetVariable(env, name, opts.instance as string | undefined)) {
			throw new Bail(`${name} is not set${opts.instance ? ` on ${opts.instance}` : ""}`);
		}

		await saveEnv(env);
		ok(`${pc.bold(name)} removed`);
		warn("templates that referenced it report missing-var on the next apply");
	},
});

command({
	path: ["env", "apply"],
	desc: "Re-apply every config template to an instance",
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const { loadLock } = await import("../../client/core/config");
		const { applyTemplates, notableTemplateResults } = await import("../../client/core/templates");

		const results = await applyTemplates(cfg, await loadLock(), args[0]!);
		const notable = notableTemplateResults(results);

		if (!notable.length) {
			ok(`${args[0]}: every templated value already in place (${results.length} checked)`);

			return;
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
	},
});
