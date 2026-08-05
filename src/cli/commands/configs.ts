/**
 * `luna configs …` — the terminal half of the config-file editor. Browsing,
 * reading and rendering are all here; the editing itself is the console's job
 * (monaco), because a whole-file template is not something to paste at a prompt.
 */

import { command, UsageError, Bail } from "../framework";
import { pc, ok, info, warn, printTable, ProgressView } from "../ui";
import { instanceNames, machineNames } from "../completers";
import { ProgressReporter } from "../../core/progress";
import { loadCluster, managedInstances } from "../../client/core/config";
import {
	browseInstance,
	createPlaceholder,
	discardDrift,
	manageFile,
	managedFileReport,
	readInstanceFile,
	readoptFile,
	renderManagedFiles,
	unmanageFile,
} from "../../client/core/configfiles";
import { listDaemons } from "../../client/daemon";
import { machineKeyFor } from "../../shared/machines";
import type { ClusterConfig } from "../../core/types";

/** Load the registry and fail loudly on an instance nobody manages. */
async function requireInstance(name: string): Promise<ClusterConfig> {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[name]) {
		throw new UsageError(`unknown instance: ${name}`);
	}

	return cfg;
}

/** Human size, matching the tables elsewhere. */
function fmtSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}

	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}

	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

command({
	path: ["configs"],
	desc: "Managed config files — templates luna renders into instances on every start",
	opts: [
		{ flag: "--instance", desc: "only this instance's files", value: true, complete: instanceNames },
	],

	handler: async (_args, opts) => {
		const cfg = await loadCluster();
		const instance = opts.instance as string | undefined;

		if (instance) {
			await requireInstance(instance);
		}

		const rows = await managedFileReport(cfg, instance);

		if (!rows.length) {
			info("no managed config files — create one from the console's file browser");

			return;
		}

		const table = rows.map((row) => {
			const state = row.missing.length
				? pc.red("missing vars")
				: row.drifted
					? pc.yellow("drifted")
					: row.absent
						? pc.dim("not rendered")
						: pc.green("in sync");

			return [
				pc.bold(row.instance),
				row.path,
				row.placeholders.length ? row.placeholders.join(", ") : pc.dim("none"),
				state,
			];
		});

		console.log();
		printTable(table, { head: ["instance", "file", "placeholders", "state"] });
		console.log();

		const drifted = rows.filter((row) => row.drifted).length;

		if (drifted) {
			warn(`${drifted} file(s) changed outside luna — re-adopt with: luna configs readopt <instance> <file>`);
		}
	},
});

command({
	path: ["configs", "ls"],
	desc: "List one level of an instance's directory",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "path" },
	],

	handler: async (args) => {
		const instance = args[0]!;
		const cfg = await requireInstance(instance);
		const listing = await browseInstance(cfg, instance, args[1] ?? "");

		const rows = listing.entries.map((entry) => {
			const name = entry.kind === "dir" ? pc.blue(`${entry.name}/`) : entry.name;
			const flags = [
				entry.managed ? pc.cyan("managed") : "",
				entry.drifted ? pc.yellow("drifted") : "",
				entry.kind === "file" && !entry.editable ? pc.dim("not editable") : "",
				entry.noise ? pc.dim("runtime") : "",
			].filter(Boolean);

			return [
				name,
				entry.kind === "dir" ? pc.dim("—") : fmtSize(entry.size),
				flags.join(" "),
			];
		});

		console.log();
		info(`${pc.bold(instance)}${listing.path ? `/${listing.path}` : ""}`);
		printTable(rows, { head: ["name", "size", ""] });
		console.log();
	},
});

command({
	path: ["configs", "show"],
	desc: "Print a config file (the template, when it is managed)",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "file", required: true },
	],
	opts: [{ flag: "--rendered", desc: "print what is on disk rather than the template" }],

	handler: async (args, opts) => {
		const instance = args[0]!;
		const cfg = await requireInstance(instance);
		const file = await readInstanceFile(cfg, instance, args[1]!);

		const body = !opts.rendered && file.template !== undefined ? file.template : file.text;

		if (file.managed) {
			info(
				`${pc.bold(file.path)} ${pc.cyan("managed")}` +
					(opts.rendered ? pc.dim(" — on-disk render") : pc.dim(" — template")),
			);

			if (file.placeholders.length) {
				info(`placeholders: ${file.placeholders.join(", ")}`);
			}

			if (file.missing.length) {
				warn(`undefined: ${file.missing.join(", ")} — rendering is refused until they exist`);
			}

			if (file.drifted) {
				warn("the file on disk was changed outside luna — the next start overwrites it");
			}
		}

		console.log();
		console.log(body);
	},
});

command({
	path: ["configs", "manage"],
	desc: "Take a config file under management, adopting its current text as the template",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "file", required: true },
	],
	opts: [{ flag: "--description", desc: "what this file is for", value: true }],

	handler: async (args, opts) => {
		const instance = args[0]!;
		const cfg = await requireInstance(instance);

		await manageFile(cfg, instance, args[1]!, {
			description: opts.description as string | undefined,
		});

		ok(`${pc.bold(args[1]!)} is now managed on ${pc.bold(instance)}`);
		info("luna renders it from the template on every start — edit it in the console");
	},
});

command({
	path: ["configs", "unmanage"],
	desc: "Stop managing a config file, leaving it on disk as it is",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "file", required: true },
	],

	handler: async (args) => {
		const instance = args[0]!;
		const cfg = await requireInstance(instance);

		if (!(await unmanageFile(cfg, instance, args[1]!))) {
			throw new Bail(`${args[1]} is not managed on ${instance}`);
		}

		ok(`${pc.bold(args[1]!)} released — the last render stays on disk`);
	},
});

command({
	path: ["configs", "placeholder"],
	desc: "Replace a literal value in a config file with an ${ENV_VAR}",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "file", required: true },
		{ name: "name", required: true },
		{ name: "value", required: true, variadic: true },
	],
	opts: [
		{ flag: "--all", desc: "replace every occurrence, not just the first" },
		{ flag: "--instance-scope", desc: "define the variable for this instance only" },
		{ flag: "--machine", desc: "define the variable for one machine only", value: true, complete: machineNames },
		{ flag: "--secret", desc: "mask the value in every UI" },
		{ flag: "--description", desc: "what the variable is for", value: true },
		{ flag: "--force", desc: "accept a value or file change that would otherwise be refused" },
	],

	handler: async (args, opts) => {
		const [instance, file, name, ...valueParts] = args as [string, string, string, ...string[]];
		const cfg = await requireInstance(instance);
		const machine = opts.machine as string | undefined;

		if (machine && opts["instance-scope"]) {
			throw new UsageError("--machine and --instance-scope are different scopes; pass one");
		}

		let machineKey: string | undefined;

		if (machine) {
			machineKey = machineKeyFor(await listDaemons(), machine);

			if (machineKey === undefined) {
				throw new UsageError(`unknown machine: ${machine}`);
			}
		}

		const result = await createPlaceholder(cfg, instance, file, {
			name,
			value: valueParts.join(" "),
			all: !!opts.all,
			secret: !!opts.secret,
			force: !!opts.force,
			description: opts.description as string | undefined,
			...(opts["instance-scope"] ? { instance } : {}),
			...(machineKey !== undefined ? { machine: machineKey } : {}),
		});

		ok(
			`${pc.bold(file)}: ${result.replaced} occurrence(s) now read ` +
				`${pc.cyan(`\${${result.name}}`)} ${pc.dim(`(${result.scope} scope)`)}`,
		);

		if (result.changedFile) {
			warn("the rendered file differs from what was there — it was rewritten (forced)");
		} else {
			info("the file on disk is unchanged — the value simply lives in the environment now");
		}
	},
});

command({
	path: ["configs", "render"],
	desc: "Render an instance's managed config files from their templates",
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const instance = args[0]!;
		const cfg = await requireInstance(instance);
		const progress = new ProgressReporter(`render ${instance}`);
		const view = new ProgressView(progress).start();

		try {
			const results = await renderManagedFiles(cfg, instance, progress);

			view.stop();

			if (!results.length) {
				info(`${instance} has no managed config files`);

				return;
			}

			for (const result of results) {
				const line = `${result.path} ${result.outcome}${result.detail ? pc.dim(` — ${result.detail}`) : ""}`;

				if (result.outcome === "written") {
					ok(line);
				} else if (result.outcome === "unchanged") {
					info(pc.dim(line));
				} else {
					warn(line);
				}
			}
		} catch (err) {
			view.stop();

			throw err;
		}
	},
});

command({
	path: ["configs", "readopt"],
	desc: "Pull a drifted file's current text back into its template, keeping placeholders",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "file", required: true },
	],

	handler: async (args) => {
		const instance = args[0]!;
		const cfg = await requireInstance(instance);
		const result = await readoptFile(cfg, instance, args[1]!);

		ok(`${pc.bold(result.path)} re-adopted from disk`);

		if (result.kept.length) {
			info(`placeholders kept: ${result.kept.join(", ")}`);
		} else {
			warn("no placeholder values matched the new text — the template is now literal");
		}
	},
});

command({
	path: ["configs", "discard-drift"],
	desc: "Delete the .luna-drift copy kept beside a file",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "file", required: true },
	],

	handler: async (args) => {
		const instance = args[0]!;
		const cfg = await requireInstance(instance);

		if (!(await discardDrift(cfg, instance, args[1]!))) {
			throw new Bail(`no drift copy beside ${args[1]}`);
		}

		ok("drift copy removed");
	},
});
