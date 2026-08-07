// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { Bail, command, UsageError } from "../framework";
import { profileNames, runtimeIds } from "../completers";
import { info, ok, pc, printTable, warn } from "../ui";
import { loadCluster, saveCluster } from "../../client/core/config";
import {
	createProfile,
	getProfile,
	listProfiles,
	profileConsumers,
	removeProfile,
	renameProfile,
	updateProfile,
} from "../../client/core/profiles";
import { parseJavaArgs } from "../../client/core/settings";
import { t } from "../../shared/i18n";

command({
	path: ["profile"],
	desc: t("cli.profile.list.desc"),

	handler: async () => {
		const cfg = await loadCluster();
		const profiles = listProfiles(cfg);

		if (!profiles.length) {
			info(t("cli.profile.list.empty"));

			return;
		}

		console.log();
		printTable(
			profiles.map((profile) => [
				pc.bold(profile.name),
				profile.runtime ?? pc.dim("—"),
				profile.java ?? pc.dim("—"),
				String(profile.flags.length),
				profile.usedBy.length ? profile.usedBy.join(", ") : pc.dim("—"),
			]),
			{
				head: [
					t("cli.head.name"),
					t("cli.profile.head.runtime"),
					t("cli.profile.head.java"),
					t("cli.profile.head.flags"),
					t("cli.profile.head.usedBy"),
				],
			},
		);
		console.log();
	},
});

command({
	path: ["profile", "show"],
	desc: t("cli.profile.show.desc"),
	args: [{ name: "name", required: true, complete: profileNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const name = args[0]!;
		const profile = getProfile(cfg, name);

		console.log();
		info(t("cli.profile.show.title", { name: pc.bold(name) }));
		printTable(
			[
				[t("cli.profile.head.runtime"), profile.runtime ?? pc.dim("—")],
				[t("cli.profile.head.java"), profile.java ?? pc.dim("—")],
				[t("cli.profile.head.jarArgs"), profile.jarArgs?.join(" ") || pc.dim("—")],
				[t("cli.profile.head.usedBy"), profileConsumers(cfg, name).join(", ") || pc.dim("—")],
			],
			{ head: [t("cli.head.name"), t("cli.head.value")] },
		);

		console.log();
		info(t("cli.profile.show.flagCount", { count: profile.flags.length }));

		for (const flag of profile.flags) {
			console.log(`  ${pc.dim(flag)}`);
		}

		console.log();
	},
});

command({
	path: ["profile", "add"],
	desc: t("cli.profile.add.desc"),
	args: [{ name: "name", required: true }],
	opts: [
		{ flag: "--copy", desc: t("cli.profile.add.optCopy"), value: true, complete: profileNames },
		{ flag: "--runtime", desc: t("cli.profile.add.optRuntime"), value: true, complete: runtimeIds },
		{ flag: "--java", desc: t("cli.profile.add.optJava"), value: true },
		{ flag: "--flags", desc: t("cli.profile.add.optFlags"), value: true },
		{ flag: "--jar-args", desc: t("cli.profile.add.optJarArgs"), value: true },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const name = args[0]!;
		const copy = opts.copy as string | undefined;
		const base = copy ? getProfile(cfg, copy) : undefined;

		createProfile(cfg, name, {
			java: (opts.java as string | undefined) ?? base?.java,
			runtime: (opts.runtime as string | undefined) ?? base?.runtime,
			flags: opts.flags ? parseJavaArgs(opts.flags as string) : [...(base?.flags ?? [])],
			jarArgs: opts["jar-args"]
				? parseJavaArgs(opts["jar-args"] as string)
				: base?.jarArgs
					? [...base.jarArgs]
					: undefined,
		});

		await saveCluster(cfg);
		ok(t("cli.profile.add.done", { name: pc.bold(name) }));
	},
});

command({
	path: ["profile", "edit"],
	desc: t("cli.profile.edit.desc"),
	args: [{ name: "name", required: true, complete: profileNames }],
	opts: [
		{ flag: "--runtime", desc: t("cli.profile.edit.optRuntime"), value: true, complete: runtimeIds },
		{ flag: "--clear-runtime", desc: t("cli.profile.edit.optClearRuntime") },
		{ flag: "--java", desc: t("cli.profile.edit.optJava"), value: true },
		{ flag: "--clear-java", desc: t("cli.profile.edit.optClearJava") },
		{ flag: "--flags", desc: t("cli.profile.edit.optFlags"), value: true },
		{ flag: "--jar-args", desc: t("cli.profile.edit.optJarArgs"), value: true },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const name = args[0]!;
		const patch: Record<string, unknown> = {};

		if (opts["clear-runtime"]) {
			patch.runtime = "";
		} else if (opts.runtime !== undefined) {
			patch.runtime = opts.runtime;
		}

		if (opts["clear-java"]) {
			patch.java = "";
		} else if (opts.java !== undefined) {
			patch.java = opts.java;
		}

		if (opts.flags !== undefined) {
			patch.flags = parseJavaArgs(opts.flags as string);
		}

		if (opts["jar-args"] !== undefined) {
			patch.jarArgs = parseJavaArgs(opts["jar-args"] as string);
		}

		if (!Object.keys(patch).length) {
			throw new UsageError(t("cli.profile.edit.nothing"));
		}

		const { changed } = updateProfile(cfg, name, patch);

		await saveCluster(cfg);
		ok(t("cli.profile.edit.done", { name: pc.bold(name), fields: changed.join(", ") }));
		warn(t("cli.profile.edit.restartNote"));
	},
});

command({
	path: ["profile", "rename"],
	desc: t("cli.profile.rename.desc"),
	args: [
		{ name: "from", required: true, complete: profileNames },
		{ name: "to", required: true },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const [from, to] = args as [string, string];
		const { updatedInstances } = renameProfile(cfg, from, to);

		await saveCluster(cfg);
		ok(t("cli.profile.rename.done", { from: pc.bold(from), to: pc.bold(to) }));

		if (updatedInstances.length) {
			info(t("cli.profile.rename.moved", { instances: updatedInstances.join(", ") }));
		}
	},
});

command({
	path: ["profile", "remove"],
	desc: t("cli.profile.remove.desc"),
	args: [{ name: "name", required: true, complete: profileNames }],
	opts: [{ flag: "--yes", desc: t("cli.profile.remove.optYes") }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const name = args[0]!;

		getProfile(cfg, name);

		if (!opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const sure = await confirm({
				message: t("cli.profile.remove.confirm", { name }),
				initialValue: false,
			});

			if (isCancel(sure) || !sure) {
				throw new Bail(t("cli.profile.remove.cancelled"));
			}
		}

		removeProfile(cfg, name);
		await saveCluster(cfg);
		ok(t("cli.profile.remove.done", { name: pc.bold(name) }));
	},
});
