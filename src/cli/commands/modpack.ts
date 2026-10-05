// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { Bail, UsageError, command } from "../framework";
import { ProgressView, Spinner, fmtBytes, info, ok, pc, printTable, warn } from "../ui";
import { instanceNames, machineNames, runtimeIds } from "../completers";
import { loadCluster, loadLock, saveCluster } from "../../client/core/config";
import {
	completeProvision,
	installModpack,
	modpackVersions,
	searchModpacks,
	updateModpack,
} from "../../client/core/modpack";
import { ProgressReporter } from "../../client/core/progress";
import { t } from "../../shared/i18n";

command({
	path: ["modpack", "search"],
	desc: t("cli.modpack.search.desc"),
	args: [{ name: "query", required: true, desc: t("cli.modpack.search.argQuery") }],
	opts: [{ flag: "--loader", desc: t("cli.modpack.search.optLoader"), value: true }],

	handler: async (args, opts) => {
		const spinner = new Spinner().start(t("cli.modpack.search.searching"));
		const loaders = opts.loader ? [String(opts.loader)] : undefined;
		const hits = await searchModpacks(args[0]!, loaders);

		spinner.stop();

		if (!hits.length) {
			info(t("cli.modpack.search.none"));

			return;
		}

		printTable(
			hits.map((hit) => [
				pc.bold(hit.slug),
				hit.title,
				String(hit.downloads),
				hit.mcVersions?.join(", ") ?? pc.dim("—"),
			]),
			{
				head: [
					t("cli.modpack.head.slug"),
					t("cli.modpack.head.title"),
					t("cli.modpack.head.downloads"),
					t("cli.modpack.head.versions"),
				],
			},
		);

		info(t("cli.modpack.search.hint", { command: pc.cyan("luna modpack versions <slug>") }));
	},
});

command({
	path: ["modpack", "versions"],
	desc: t("cli.modpack.versions.desc"),
	args: [{ name: "slug", required: true, desc: t("cli.modpack.versions.argSlug") }],

	handler: async (args) => {
		const spinner = new Spinner().start(t("cli.modpack.versions.fetching"));
		const versions = await modpackVersions(args[0]!);

		spinner.stop();

		if (!versions.length) {
			info(t("cli.modpack.versions.none"));

			return;
		}

		printTable(
			versions.map((version) => [
				version.runnable ? pc.bold(version.versionNumber) : pc.dim(version.versionNumber),
				version.channel,
				version.mcVersions.join(", "),
				version.loaders.join(", "),
				new Date(version.publishedAt).toLocaleDateString(),
				fmtBytes(version.sizeBytes),
			]),
			{
				head: [
					t("cli.modpack.head.version"),
					t("cli.modpack.head.channel"),
					t("cli.modpack.head.minecraft"),
					t("cli.modpack.head.loaders"),
					t("cli.modpack.head.published"),
					t("cli.modpack.head.size"),
				],
			},
		);

		info(t("cli.modpack.versions.dimNote"));
	},
});

command({
	path: ["modpack", "install"],
	desc: t("cli.modpack.install.desc"),
	args: [
		{ name: "name", required: true, desc: t("cli.modpack.install.argName") },
		{ name: "slug", desc: t("cli.modpack.install.argSlug") },
	],
	opts: [
		{ flag: "--version", desc: t("cli.modpack.install.optVersion"), value: true },
		{ flag: "--file", desc: t("cli.modpack.install.optFile"), value: true },
		{ flag: "--memory", desc: t("cli.modpack.install.optMemory"), value: true },
		{ flag: "--port", desc: t("cli.modpack.install.optPort"), value: true },
		{ flag: "--profile", desc: t("cli.modpack.install.optProfile"), value: true },
		{ flag: "--runtime", desc: t("cli.modpack.install.optRuntime"), value: true, complete: runtimeIds },
		{ flag: "--daemon", desc: t("cli.modpack.install.optDaemon"), value: true, complete: machineNames },
		{ flag: "--no-register", desc: t("cli.modpack.install.optNoRegister") },
		{ flag: "--skip-optional", desc: t("cli.modpack.install.optSkipOptional") },
	],

	handler: async (args, opts) => {
		const name = args[0]!;
		const slug = args[1];
		const file = opts.file as string | undefined;

		if (!slug === !file) {
			throw new UsageError(t("cli.modpack.install.oneSource"));
		}

		let port: number | undefined;

		if (opts.port !== undefined) {
			port = parseInt(String(opts.port));

			if (!Number.isFinite(port)) {
				throw new UsageError(t("cli.modpack.install.badPort", { value: String(opts.port) }));
			}
		}

		const cfg = await loadCluster();
		const lock = await loadLock();
		const register = !opts["no-register"];

		const progress = new ProgressReporter(t("cli.modpack.install.title", { name }));

		progress.weighOwn(0);

		const pack = progress.child(t("cli.modpack.install.phasePack"), 10);
		const plugins = progress.child(t("cli.modpack.install.phasePlugins"), 2);
		const packs = progress.child(t("cli.modpack.install.phasePacks"), 1);
		const ports = progress.child(t("cli.modpack.install.phasePorts"), 1);
		const proxy = progress.child(t("cli.modpack.install.phaseProxy"), 1);

		const view = new ProgressView(progress).start();

		try {
			const result = await installModpack(cfg, name, {
				slug,
				versionId: opts.version as string | undefined,
				mrpackPath: file,
				memory: opts.memory as string | undefined,
				port,
				profile: opts.profile as string | undefined,
				runtime: opts.runtime as string | undefined,
				daemon: opts.daemon as string | undefined,
				register,
				skipOptional: !!opts["skip-optional"],
				reporter: pack,
			});

			await saveCluster(cfg);

			const outcome = await completeProvision(cfg, lock, name, { plugins, packs, ports, proxy }, register);

			view.stop();

			ok(
				t("cli.modpack.install.installed", {
					name: pc.bold(name),
					pack: result.modpack.name,
					version: result.modpack.versionNumber,
					software: result.software,
					mc: result.mcVersion,
					port: pc.cyan(String(result.port)),
				}),
			);

			info(
				t("cli.modpack.install.filesLine", {
					files: result.files,
					overrides: result.overrides,
					clientOnly: result.clientOnly,
				}),
			);

			if (result.skipped.length) {
				info(t("cli.modpack.install.skippedLine", { files: result.skipped.join(", ") }));
			}

			if (result.removed.length) {
				warn(t("cli.modpack.install.removedLine", { files: result.removed.join(", ") }));
			}

			if (result.withheld.length) {
				info(t("cli.modpack.install.withheldLine", { mods: result.withheld.join(", ") }));
			}

			if (result.rescued.length) {
				info(t("cli.modpack.install.rescuedLine", { mods: result.rescued.map((entry) => `${entry.id} (${entry.from})`).join(", ") }));
			}

			if (result.unresolved.length) {
				warn(t("cli.modpack.install.unresolvedLine", { ids: result.unresolved.join(", ") }));
			}

			if (outcome.forwarding.required.length) {
				info(t("core.admin.requiredAddonsInstalled", { mods: outcome.forwarding.required.join(", ") }));
			}

			if (outcome.forwarding.slug) {
				info(t("core.admin.forwardingModInstalled", { mod: outcome.forwarding.slug }));
			}

			info(t("cli.instance.startHint", { command: pc.cyan(`luna start ${name}`) }));
		} catch (err) {
			view.stop();

			throw new Bail((err as Error).message);
		}
	},
});

command({
	path: ["modpack", "update"],
	desc: t("cli.modpack.update.desc"),
	args: [{ name: "instance", required: true, complete: instanceNames, desc: t("cli.modpack.update.argInstance") }],
	opts: [
		{ flag: "--version", desc: t("cli.modpack.update.optVersion"), value: true },
		{ flag: "--file", desc: t("cli.modpack.update.optFile"), value: true },
		{ flag: "--force", desc: t("cli.modpack.update.optForce") },
		{ flag: "--skip-optional", desc: t("cli.modpack.install.optSkipOptional") },
	],

	handler: async (args, opts) => {
		const name = args[0]!;
		const cfg = await loadCluster();
		const inst = cfg.instances[name];

		if (!inst) {
			throw new UsageError(t("core.instances.unknown", { name }));
		}

		const progress = new ProgressReporter(t("cli.modpack.update.title", { name }));
		const view = new ProgressView(progress).start();

		try {
			const result = await updateModpack(cfg, name, {
				versionId: opts.version as string | undefined,
				mrpackPath: opts.file as string | undefined,
				force: !!opts.force,
				skipOptional: !!opts["skip-optional"],
				reporter: progress,
			});

			await saveCluster(cfg);
			view.stop();

			ok(
				t("cli.modpack.update.updated", {
					name: pc.bold(name),
					from: result.from?.versionNumber ?? pc.dim("—"),
					to: result.to.versionNumber,
				}),
			);

			if (result.versionChanged) {
				info(t("cli.modpack.update.versionLine", { mc: result.mcVersion, loader: result.loaderVersion }));
			}

			info(
				t("cli.modpack.update.filesLine", {
					files: result.files,
					overrides: result.overrides,
					removed: result.removed,
				}),
			);

			if (result.skipped.length) {
				info(t("cli.modpack.install.skippedLine", { files: result.skipped.join(", ") }));
			}

			if (result.rescued.length) {
				info(t("cli.modpack.install.rescuedLine", { mods: result.rescued.map((entry) => `${entry.id} (${entry.from})`).join(", ") }));
			}

			if (result.unresolved.length) {
				warn(t("cli.modpack.install.unresolvedLine", { ids: result.unresolved.join(", ") }));
			}

			info(t("cli.instance.startHint", { command: pc.cyan(`luna start ${name}`) }));
		} catch (err) {
			view.stop();

			throw new Bail((err as Error).message);
		}
	},
});
