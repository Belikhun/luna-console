// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * World and backup commands, thin over the client bridge like every other
 * command file.
 *
 * The console can do all of this too, but the terminal is where an operator
 * already is when a world has gone wrong, and it is the only half of the
 * project that works when the console is down.
 */

import { command, UsageError, Bail } from "../framework";
import { pc, ok, info, warn, fail, printTable, Spinner, ProgressView, fmtBytes } from "../ui";
import { instanceNames } from "../completers";
import { loadCluster } from "../../client/core/config";
import { ProgressReporter } from "../../client/core/progress";
import * as backups from "../../client/core/backups";
import * as world from "../../client/core/world";
import { t } from "../../shared/i18n";

/**
 * Backup ids for shell completion.
 *
 * Every instance's, because a completer is not told which argument came before
 * it; the ids carry their instance name as a prefix, so the list still reads.
 */
async function backupIds(): Promise<string[]> {
	const cfg = await loadCluster();
	const out: string[] = [];

	for (const name of Object.keys(cfg.instances)) {
		for (const entry of await backups.listBackups(cfg, name).catch(() => [])) {
			out.push(entry.id);
		}
	}

	return out;
}

/** A timestamp the tables render the same way everywhere. */
function stamp(at: number): string {
	return new Date(at).toLocaleString();
}

command({
	path: ["world"],
	desc: t("cli.world.show.desc"),
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const name = args[0]!;
		const spin = new Spinner().start(t("cli.world.show.reading"));

		const report = await world.worldInfo(cfg, name);
		const lock = await world.worldLock(cfg, name);

		spin.stop();

		info(`${pc.bold(report.level)} · ${report.layout} · ${fmtBytes(report.sizeBytes)}`);

		if (report.level_dat) {
			info(
				t("cli.world.show.levelLine", {
					version: report.level_dat.mcVersion ?? "?",
					seed: report.level_dat.seed ?? "?",
				}),
			);
		}

		if (!report.exists) {
			warn(t("cli.world.show.notGenerated", { name }));
		}

		printTable(
			report.dimensions.map((dim) => [
				dim.kind,
				dim.path,
				fmtBytes(dim.sizeBytes),
				String(dim.regionFiles),
			]),
			{
				head: [
					t("cli.world.show.colDimension"),
					t("cli.world.show.colPath"),
					t("cli.world.show.colSize"),
					t("cli.world.show.colRegions"),
				],
			},
		);

		if (report.freeBytes !== undefined) {
			info(t("cli.world.show.freeSpace", { free: fmtBytes(report.freeBytes) }));
		}

		if (lock) {
			warn(t("cli.world.show.locked", { kind: lock.kind, phase: lock.phase }));
		}
	},
});

command({
	path: ["world", "reset"],
	desc: t("cli.world.reset.desc"),
	args: [{ name: "instance", required: true, complete: instanceNames }],
	opts: [
		{ flag: "--yes", desc: t("cli.world.reset.optYes") },
		{ flag: "--no-backup", desc: t("cli.world.reset.optNoBackup") },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const name = args[0]!;

		if (!opts.yes) {
			throw new UsageError(t("cli.world.reset.needsYes", { name }));
		}

		// the safety copy first and separately, so a failure here stops the reset
		// rather than leaving nothing to go back to
		if (!opts["no-backup"]) {
			const progress = new ProgressReporter(t("cli.world.reset.backingUp"));
			const view = new ProgressView(progress).start();

			try {
				await backups.createBackup(cfg, name, {
					label: t("cli.world.reset.backupLabel"),
					trigger: "pre-reset",
					skipFreeze: true,
					reporter: progress,
				});
			} finally {
				view.stop();
			}
		}

		const progress = new ProgressReporter(`reset ${name}`);
		const view = new ProgressView(progress).start();

		try {
			await world.resetWorld(cfg, name, { reporter: progress });
		} finally {
			view.stop();
		}

		ok(t("cli.world.reset.done", { name }));
	},
});

command({
	path: ["backup"],
	desc: t("cli.backup.create.desc"),
	args: [{ name: "instance", required: true, complete: instanceNames }],
	opts: [
		{ flag: "--label", desc: t("cli.backup.create.optLabel"), value: true },
		{ flag: "--note", desc: t("cli.backup.create.optNote"), value: true },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const name = args[0]!;
		const progress = new ProgressReporter(`backup ${name}`);
		const view = new ProgressView(progress).start();

		let entry;

		try {
			entry = await backups.createBackup(cfg, name, {
				label: opts.label as string | undefined,
				note: opts.note as string | undefined,
				reporter: progress,
			});
		} finally {
			view.stop();
		}

		ok(
			t("cli.backup.create.done", {
				label: pc.bold(entry.label),
				size: fmtBytes(entry.sizeBytes),
				files: String(entry.fileCount),
			}),
		);

		for (const warning of entry.warnings ?? []) {
			warn(t(`cli.backup.warning.${warning}`));
		}
	},
});

command({
	path: ["backups"],
	desc: t("cli.backup.list.desc"),
	args: [{ name: "instance", complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const names = args[0] ? [args[0]] : Object.keys(cfg.instances);
		const rows: string[][] = [];

		for (const name of names) {
			for (const entry of await backups.listBackups(cfg, name).catch(() => [])) {
				rows.push([
					entry.instance,
					entry.label + (entry.pinned ? ` ${pc.yellow("*")}` : ""),
					stamp(entry.createdAt),
					fmtBytes(entry.sizeBytes),
					entry.mcVersion ?? "—",
					entry.trigger,
				]);
			}
		}

		if (rows.length === 0) {
			info(t("cli.backup.list.none"));

			return;
		}

		printTable(rows, {
			head: [
				t("cli.backup.list.colInstance"),
				t("cli.backup.list.colBackup"),
				t("cli.backup.list.colTaken"),
				t("cli.backup.list.colSize"),
				t("cli.backup.list.colVersion"),
				t("cli.backup.list.colSource"),
			],
		});
	},
});

command({
	path: ["backup", "restore"],
	desc: t("cli.backup.restore.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "id", required: true, complete: backupIds },
	],
	opts: [
		{ flag: "--yes", desc: t("cli.backup.restore.optYes") },
		{ flag: "--no-backup", desc: t("cli.backup.restore.optNoBackup") },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const [name, id] = args as [string, string];

		if (!opts.yes) {
			throw new UsageError(t("cli.backup.restore.needsYes", { name }));
		}

		const progress = new ProgressReporter(`restore ${name}`);
		const view = new ProgressView(progress).start();

		try {
			await backups.restoreBackup(cfg, name, id, {
				backupFirst: !opts["no-backup"],
				reporter: progress,
			});
		} finally {
			view.stop();
		}

		ok(t("cli.backup.restore.done", { name, id }));
	},
});

command({
	path: ["backup", "verify"],
	desc: t("cli.backup.verify.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "id", required: true, complete: backupIds },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const [name, id] = args as [string, string];
		const spin = new Spinner().start(t("cli.backup.verify.working"));

		try {
			const entry = await backups.verifyBackup(cfg, name, id);

			spin.stop();
			ok(t("cli.backup.verify.done", { label: entry.label, checksum: entry.checksum ?? "?" }));
		} catch (err) {
			spin.stop();
			fail(err instanceof Error ? err.message : String(err));

			throw new Bail();
		}
	},
});

command({
	path: ["backup", "pin"],
	desc: t("cli.backup.pin.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "id", required: true, complete: backupIds },
	],
	opts: [{ flag: "--off", desc: t("cli.backup.pin.optOff") }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const [name, id] = args as [string, string];
		const entry = await backups.updateBackup(cfg, name, id, { pinned: !opts.off });

		ok(
			entry.pinned
				? t("cli.backup.pin.pinned", { label: entry.label })
				: t("cli.backup.pin.unpinned", { label: entry.label }),
		);
	},
});

command({
	path: ["backup", "remove"],
	desc: t("cli.backup.remove.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "id", required: true, complete: backupIds },
	],
	opts: [{ flag: "--yes", desc: t("cli.backup.remove.optYes") }],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const [name, id] = args as [string, string];

		if (!opts.yes) {
			throw new UsageError(t("cli.backup.remove.needsYes"));
		}

		const entry = await backups.deleteBackup(cfg, name, id);

		if (!entry) {
			warn(t("cli.backup.remove.unknown", { id }));

			return;
		}

		ok(t("cli.backup.remove.done", { label: entry.label }));
	},
});

command({
	path: ["backup", "keep"],
	desc: t("cli.backup.keep.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "count", required: true },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const [name, count] = args as [string, string];
		const keep = Number(count);

		if (!Number.isInteger(keep) || keep < 1) {
			throw new UsageError(t("cli.backup.keep.badCount"));
		}

		await backups.setKeepCount(cfg, name, keep);

		ok(t("cli.backup.keep.done", { name, count: String(keep) }));
	},
});
