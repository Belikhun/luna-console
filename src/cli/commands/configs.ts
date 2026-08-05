// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * `luna configs …` is the terminal half of the config-file editor. Browsing,
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
import { t } from "../../shared/i18n";

/** Load the registry and fail loudly on an instance nobody manages. */
async function requireInstance(name: string): Promise<ClusterConfig> {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[name]) {
		throw new UsageError(t("cli.env.unknownInstance", { name }));
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
	desc: t("cli.configs.list.desc"),
	opts: [
		{ flag: "--instance", desc: t("cli.configs.list.optInstance"), value: true, complete: instanceNames },
	],

	handler: async (_args, opts) => {
		const cfg = await loadCluster();
		const instance = opts.instance as string | undefined;

		if (instance) {
			await requireInstance(instance);
		}

		const rows = await managedFileReport(cfg, instance);

		if (!rows.length) {
			info(t("cli.configs.list.empty"));

			return;
		}

		const table = rows.map((row) => {
			const state = row.missing.length
				? pc.red(t("cli.configs.stateMissingVars"))
				: row.drifted
					? pc.yellow(t("cli.configs.stateDrifted"))
					: row.absent
						? pc.dim(t("cli.configs.stateNotRendered"))
						: pc.green(t("cli.configs.stateInSync"));

			return [
				pc.bold(row.instance),
				row.path,
				row.placeholders.length ? row.placeholders.join(", ") : pc.dim(t("cli.common.none")),
				state,
			];
		});

		console.log();
		printTable(table, {
			head: [
				t("cli.head.instance"),
				t("cli.head.file"),
				t("cli.head.placeholders"),
				t("cli.head.state"),
			],
		});
		console.log();

		const drifted = rows.filter((row) => row.drifted).length;

		if (drifted) {
			warn(t("cli.configs.list.driftWarning", { count: drifted }));
		}
	},
});

command({
	path: ["configs", "ls"],
	desc: t("cli.configs.ls.desc"),
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
				entry.managed ? pc.cyan(t("cli.configs.flagManaged")) : "",
				entry.drifted ? pc.yellow(t("cli.configs.stateDrifted")) : "",
				entry.kind === "file" && !entry.editable ? pc.dim(t("cli.configs.flagNotEditable")) : "",
				entry.noise ? pc.dim(t("cli.configs.flagRuntime")) : "",
			].filter(Boolean);

			return [
				name,
				entry.kind === "dir" ? pc.dim("—") : fmtSize(entry.size),
				flags.join(" "),
			];
		});

		console.log();
		info(`${pc.bold(instance)}${listing.path ? `/${listing.path}` : ""}`);
		printTable(rows, { head: [t("cli.head.name"), t("cli.head.size"), ""] });
		console.log();
	},
});

command({
	path: ["configs", "show"],
	desc: t("cli.configs.show.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "file", required: true },
	],
	opts: [{ flag: "--rendered", desc: t("cli.configs.show.optRendered") }],

	handler: async (args, opts) => {
		const instance = args[0]!;
		const cfg = await requireInstance(instance);
		const file = await readInstanceFile(cfg, instance, args[1]!);

		const body = !opts.rendered && file.template !== undefined ? file.template : file.text;

		if (file.managed) {
			info(
				`${pc.bold(file.path)} ${pc.cyan(t("cli.configs.flagManaged"))}` +
					(opts.rendered
						? pc.dim(` · ${t("cli.configs.show.onDiskRender")}`)
						: pc.dim(` · ${t("cli.configs.show.template")}`)),
			);

			if (file.placeholders.length) {
				info(t("cli.configs.show.placeholders", { names: file.placeholders.join(", ") }));
			}

			if (file.missing.length) {
				warn(t("cli.configs.show.missing", { names: file.missing.join(", ") }));
			}

			if (file.drifted) {
				warn(t("cli.configs.show.driftNote"));
			}
		}

		console.log();
		console.log(body);
	},
});

command({
	path: ["configs", "manage"],
	desc: t("cli.configs.manage.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "file", required: true },
	],
	opts: [{ flag: "--description", desc: t("cli.configs.manage.optDescription"), value: true }],

	handler: async (args, opts) => {
		const instance = args[0]!;
		const cfg = await requireInstance(instance);

		await manageFile(cfg, instance, args[1]!, {
			description: opts.description as string | undefined,
		});

		ok(t("cli.configs.manage.done", { file: pc.bold(args[1]!), instance: pc.bold(instance) }));
		info(t("cli.configs.manage.note"));
	},
});

command({
	path: ["configs", "unmanage"],
	desc: t("cli.configs.unmanage.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "file", required: true },
	],

	handler: async (args) => {
		const instance = args[0]!;
		const cfg = await requireInstance(instance);

		if (!(await unmanageFile(cfg, instance, args[1]!))) {
			throw new Bail(t("cli.configs.unmanage.notManaged", { file: args[1] ?? "", instance }));
		}

		ok(t("cli.configs.unmanage.done", { file: pc.bold(args[1]!) }));
	},
});

command({
	path: ["configs", "placeholder"],
	desc: t("cli.configs.placeholder.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "file", required: true },
		{ name: "name", required: true },
		{ name: "value", required: true, variadic: true },
	],
	opts: [
		{ flag: "--all", desc: t("cli.configs.placeholder.optAll") },
		{ flag: "--instance-scope", desc: t("cli.configs.placeholder.optInstanceScope") },
		{ flag: "--machine", desc: t("cli.configs.placeholder.optMachine"), value: true, complete: machineNames },
		{ flag: "--secret", desc: t("cli.env.set.optSecret") },
		{ flag: "--description", desc: t("cli.env.set.optDescription"), value: true },
		{ flag: "--force", desc: t("cli.configs.placeholder.optForce") },
	],

	handler: async (args, opts) => {
		const [instance, file, name, ...valueParts] = args as [string, string, string, ...string[]];
		const cfg = await requireInstance(instance);
		const machine = opts.machine as string | undefined;

		if (machine && opts["instance-scope"]) {
			throw new UsageError(t("cli.configs.placeholder.scopeConflict"));
		}

		let machineKey: string | undefined;

		if (machine) {
			machineKey = machineKeyFor(await listDaemons(), machine);

			if (machineKey === undefined) {
				throw new UsageError(t("cli.env.unknownMachine", { name: machine }));
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
			`${t("cli.configs.placeholder.done", {
				file: pc.bold(file),
				count: result.replaced,
				placeholder: pc.cyan(`\${${result.name}}`),
			})} ${pc.dim(`(${result.scope} scope)`)}`,
		);

		if (result.changedFile) {
			warn(t("cli.configs.placeholder.rewritten"));
		} else {
			info(t("cli.configs.placeholder.unchanged"));
		}
	},
});

command({
	path: ["configs", "render"],
	desc: t("cli.configs.render.desc"),
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
				info(t("cli.configs.render.empty", { name: instance }));

				return;
			}

			for (const result of results) {
				const line = `${result.path} ${result.outcome}${result.detail ? pc.dim(` · ${result.detail}`) : ""}`;

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
	desc: t("cli.configs.readopt.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "file", required: true },
	],

	handler: async (args) => {
		const instance = args[0]!;
		const cfg = await requireInstance(instance);
		const result = await readoptFile(cfg, instance, args[1]!);

		ok(t("cli.configs.readopt.done", { file: pc.bold(result.path) }));

		if (result.kept.length) {
			info(t("cli.configs.readopt.kept", { names: result.kept.join(", ") }));
		} else {
			warn(t("cli.configs.readopt.nowLiteral"));
		}
	},
});

command({
	path: ["configs", "discard-drift"],
	desc: t("cli.configs.discardDrift.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "file", required: true },
	],

	handler: async (args) => {
		const instance = args[0]!;
		const cfg = await requireInstance(instance);

		if (!(await discardDrift(cfg, instance, args[1]!))) {
			throw new Bail(t("cli.configs.discardDrift.noCopy", { file: args[1] ?? "" }));
		}

		ok(t("cli.configs.discardDrift.done"));
	},
});
