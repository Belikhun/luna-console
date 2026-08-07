// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { Bail, command, UsageError } from "../framework";
import { machineNames, runtimeIds } from "../completers";
import { fmtBytes, info, ok, pc, printTable, ProgressView, warn } from "../ui";
import { ProgressReporter } from "../../core/progress";
import { loadCluster } from "../../client/core/config";
import {
	available,
	install,
	inventory,
	remove,
	runtimeConsumers,
	suggestedFeature,
	validateRuntimeId,
	RUNTIME_VENDORS,
} from "../../client/core/runtimes";
import { listDaemons } from "../../client/daemon";
import { machineKeyFor, machineNameFor } from "../../shared/machines";
import { t } from "../../shared/i18n";
import type { ClusterConfig } from "../../core/types";

/**
 * Resolve `--machine <name>` to the key the registry scopes by. Absent means
 * this daemon's own machine, which is the one an operator is standing on.
 */
async function machineFrom(opts: Record<string, unknown>): Promise<{ key: string; name: string }> {
	const fleet = await listDaemons();
	const typed = opts.machine as string | undefined;

	if (!typed) {
		const primary = fleet.find((row) => row.mode === "primary");

		return { key: "", name: primary?.name ?? "primary" };
	}

	const key = machineKeyFor(fleet, typed);

	if (key === undefined) {
		throw new UsageError(t("cli.runtime.unknownMachine", { name: typed }));
	}

	return { key, name: machineNameFor(fleet, key) };
}

/** Runtime ids the cluster asks for, so a listing can say what is spoken for. */
function consumerLabel(cfg: ClusterConfig, id: string, machine: string): string {
	const consumers = (runtimeConsumers(cfg)[id] ?? []).filter(
		(consumer) => consumer.kind === "profile" || consumer.machine === machine,
	);

	if (!consumers.length) {
		return pc.dim("—");
	}

	return consumers.map((consumer) => consumer.name).join(", ");
}

command({
	path: ["runtime"],
	desc: t("cli.runtime.list.desc"),
	opts: [
		{ flag: "--machine", desc: t("cli.runtime.list.optMachine"), value: true, complete: machineNames },
	],

	handler: async (_args, opts) => {
		const cfg = await loadCluster();
		const fleet = await listDaemons();
		const only = opts.machine as string | undefined;
		const rows: string[][] = [];

		for (const machine of await inventory(cfg)) {
			const name = machineNameFor(fleet, machine.machine);

			if (only && name !== only) {
				continue;
			}

			// a machine that did not answer is not a machine with nothing installed,
			// and saying so would invite an operator to install a second copy
			if (machine.runtimes === null) {
				rows.push([name, pc.dim(t("cli.runtime.list.unreachable")), "", "", "", ""]);

				continue;
			}

			if (!machine.runtimes.length) {
				rows.push([name, pc.dim(t("cli.runtime.list.none")), "", "", "", ""]);

				continue;
			}

			for (const runtime of machine.runtimes) {
				rows.push([
					name,
					pc.bold(runtime.id),
					runtime.vendor,
					runtime.platform,
					runtime.sizeBytes ? fmtBytes(runtime.sizeBytes) : pc.dim("—"),
					consumerLabel(cfg, runtime.id, machine.machine),
				]);
			}
		}

		if (!rows.length) {
			info(t("cli.runtime.list.empty"));

			return;
		}

		console.log();
		printTable(rows, {
			head: [
				t("cli.head.machine"),
				t("cli.runtime.head.runtime"),
				t("cli.runtime.head.vendor"),
				t("cli.runtime.head.platform"),
				t("cli.head.size"),
				t("cli.runtime.head.usedBy"),
			],
		});
		console.log();
	},
});

command({
	path: ["runtime", "available"],
	desc: t("cli.runtime.available.desc"),
	args: [{ name: "feature", desc: t("cli.runtime.available.argFeature") }],
	opts: [
		{ flag: "--machine", desc: t("cli.runtime.available.optMachine"), value: true, complete: machineNames },
		{
			flag: "--vendor",
			desc: t("cli.runtime.available.optVendor"),
			value: true,
			complete: async () => [...RUNTIME_VENDORS],
		},
		{ flag: "--lts", desc: t("cli.runtime.available.optLts") },
		{ flag: "--refresh", desc: t("cli.runtime.available.optRefresh") },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const machine = await machineFrom(opts);
		const vendor = opts.vendor as string | undefined;

		if (vendor && !RUNTIME_VENDORS.includes(vendor as never)) {
			throw new UsageError(
				t("cli.runtime.unknownVendor", { name: vendor, vendors: RUNTIME_VENDORS.join(", ") }),
			);
		}

		const feature = args[0] ? Number.parseInt(args[0], 10) : undefined;

		if (args[0] && !feature) {
			throw new UsageError(t("cli.runtime.available.badFeature", { value: args[0] }));
		}

		const rows = await available(cfg, machine.key, {
			vendor,
			feature,
			refresh: !!opts.refresh,
		});

		const shown = rows.filter((row) => !opts.lts || row.lts);

		if (!shown.length) {
			info(t("cli.runtime.available.empty", { machine: machine.name }));

			return;
		}

		console.log();
		printTable(
			shown.map((row) => [
				pc.bold(row.id),
				row.vendor,
				String(row.feature),
				row.lts ? pc.green(t("cli.runtime.available.lts")) : pc.dim("—"),
				row.size ? fmtBytes(row.size) : pc.dim("—"),
			]),
			{
				head: [
					t("cli.runtime.head.runtime"),
					t("cli.runtime.head.vendor"),
					t("cli.runtime.head.feature"),
					t("cli.runtime.head.lts"),
					t("cli.head.size"),
				],
			},
		);
		console.log();
		info(t("cli.runtime.available.forPlatform", { machine: pc.bold(machine.name) }));
	},
});

command({
	path: ["runtime", "install"],
	desc: t("cli.runtime.install.desc"),
	args: [{ name: "id", required: true, complete: runtimeIds }],
	opts: [
		{ flag: "--machine", desc: t("cli.runtime.install.optMachine"), value: true, complete: machineNames },
		{ flag: "--force", desc: t("cli.runtime.install.optForce") },
	],

	handler: async (args, opts) => {
		const id = args[0]!;
		const bad = validateRuntimeId(id);

		if (bad) {
			throw new UsageError(bad);
		}

		const cfg = await loadCluster();
		const machine = await machineFrom(opts);

		// the whole wait is the download, so the tree the daemon reports is what the
		// operator watches; this end only renders it
		const progress = new ProgressReporter(`install ${id}`);
		const view = new ProgressView(progress).start();

		try {
			const runtime = await install(cfg, machine.key, id, {
				force: !!opts.force,
				reporter: progress,
			});

			view.stop();
			ok(
				t("cli.runtime.install.done", {
					id: pc.bold(runtime.id),
					machine: pc.bold(machine.name),
				}),
			);
			info(pc.dim(runtime.javaVersionLine ?? runtime.javaPath));
		} catch (err) {
			view.stop();

			throw new Bail((err as Error).message);
		}
	},
});

command({
	path: ["runtime", "remove"],
	desc: t("cli.runtime.remove.desc"),
	args: [{ name: "id", required: true, complete: runtimeIds }],
	opts: [
		{ flag: "--machine", desc: t("cli.runtime.remove.optMachine"), value: true, complete: machineNames },
		{ flag: "--force", desc: t("cli.runtime.remove.optForce") },
		{ flag: "--yes", desc: t("cli.runtime.remove.optYes") },
	],

	handler: async (args, opts) => {
		const id = args[0]!;
		const cfg = await loadCluster();
		const machine = await machineFrom(opts);

		if (!opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const sure = await confirm({
				message: t("cli.runtime.remove.confirm", { id, machine: machine.name }),
				initialValue: false,
			});

			if (isCancel(sure) || !sure) {
				throw new Bail(t("cli.runtime.remove.cancelled"));
			}
		}

		const result = await remove(cfg, machine.key, id, { force: !!opts.force });

		if (!result.removed) {
			throw new Bail(t("core.runtimes.notHere", { id, machine: machine.name }));
		}

		ok(
			t("cli.runtime.remove.done", {
				id: pc.bold(id),
				machine: pc.bold(machine.name),
				freed: result.freedBytes ? fmtBytes(result.freedBytes) : "?",
			}),
		);

		if (opts.force) {
			warn(t("cli.runtime.remove.forcedNote"));
		}
	},
});

command({
	path: ["runtime", "show"],
	desc: t("cli.runtime.show.desc"),
	args: [{ name: "id", required: true, complete: runtimeIds }],

	handler: async (args) => {
		const id = args[0]!;
		const cfg = await loadCluster();
		const fleet = await listDaemons();
		const machines = await inventory(cfg);
		const rows: string[][] = [];

		for (const machine of machines) {
			const name = machineNameFor(fleet, machine.machine);

			if (machine.runtimes === null) {
				rows.push([name, pc.dim(t("cli.runtime.list.unreachable")), ""]);

				continue;
			}

			const found = machine.runtimes.find((runtime) => runtime.id === id);

			rows.push([
				name,
				found ? pc.green(t("cli.runtime.show.installed")) : pc.dim(t("cli.runtime.show.missing")),
				found?.javaVersionLine ?? "",
			]);
		}

		console.log();
		info(t("cli.runtime.show.title", { id: pc.bold(id) }));
		printTable(rows, {
			head: [t("cli.head.machine"), t("cli.head.state"), t("cli.runtime.head.reported")],
		});

		const consumers = runtimeConsumers(cfg)[id] ?? [];

		if (consumers.length) {
			console.log();
			info(
				t("cli.runtime.show.usedBy", {
					consumers: consumers.map((consumer) => consumer.name).join(", "),
				}),
			);
		}

		console.log();
	},
});

command({
	path: ["runtime", "suggest"],
	desc: t("cli.runtime.suggest.desc"),
	args: [{ name: "mcVersion", required: true }],

	handler: async (args) => {
		const version = args[0]!;
		const feature = suggestedFeature(version);

		info(t("cli.runtime.suggest.result", { version: pc.bold(version), feature: pc.bold(String(feature)) }));
	},
});
