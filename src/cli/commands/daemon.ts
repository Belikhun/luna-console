// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { command, Bail } from "../framework";
import { configuredToken } from "../../daemon/config";
import { pc, info, ok, warn, fail, printTable, ProgressView, Sym } from "../ui";
import { ProgressReporter } from "../../core/progress";
import { ensureConnected, daemonInfo, DaemonUnavailable } from "../../client/socket";
import { loadCluster, saveCluster } from "../../client/core/config";
import {
	checkDaemonUpgrade,
	daemonDetail,
	daemonHealth,
	listDaemons,
	upgradeDaemon,
	type HealthSample,
	type UpgradeCheck,
} from "../../client/daemon";
import { t } from "../../shared/i18n";

/** Milliseconds → compact "3d 4h" / "2h 5m" / "3m 12s" uptime. */
function uptimeText(sinceMs: number): string {
	const seconds = Math.floor((Date.now() - sinceMs) / 1000);
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);

	if (days > 0) {
		return `${days}d ${hours}h`;
	}

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}

	return `${minutes}m ${seconds % 60}s`;
}

/** "37%" with the tone the console uses for the same thresholds. */
function pctCell(used: number, total: number): string {
	if (total <= 0) {
		return pc.dim("—");
	}

	const pct = Math.round((used / total) * 100);
	const text = `${pct}%`;

	if (pct >= 90) {
		return pc.red(text);
	}

	if (pct >= 75) {
		return pc.yellow(text);
	}

	return text;
}

/** Bytes → "12.3 GB", for the disk column. */
function gb(bytes: number): string {
	return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** The health lines shared by `daemon status` and `daemon show`. */
function printHealth(health: HealthSample): void {
	const memPct = pctCell(health.memUsedMb, health.memTotalMb);
	const diskPct = pctCell(health.diskUsedBytes, health.diskTotalBytes);

	info(`cpu       ${health.cpuPct}% (load ${health.load1.toFixed(2)} ${health.load5.toFixed(2)} ${health.load15.toFixed(2)})`);
	info(`memory    ${health.memUsedMb} / ${health.memTotalMb} MB (${memPct})`);
	info(`disk      ${gb(health.diskUsedBytes)} / ${gb(health.diskTotalBytes)} (${diskPct})`);
	info(
		`inst mem  ${t("cli.daemon.instMem", {
			mb: health.instancesRssMb,
			count: Object.keys(health.instanceRssMb).length,
		})}`,
	);
}

command({
	path: ["daemon", "run"],
	desc: t("cli.daemon.run.desc"),

	handler: async () => {
		const { runDaemon } = await import("../../daemon/index");

		await runDaemon();
	},
});

command({
	path: ["daemon", "status"],
	desc: t("cli.daemon.status.desc"),

	handler: async () => {
		try {
			await ensureConnected();
		} catch (err) {
			if (err instanceof DaemonUnavailable) {
				fail(t("cli.daemon.status.noDaemon"));
				info(
					t("cli.daemon.status.startHint", {
						run: pc.cyan("luna daemon run"),
						install: pc.cyan("luna daemon service install"),
					}),
				);
				process.exitCode = 1;

				return;
			}

			throw err;
		}

		const d = daemonInfo();

		ok(`daemon "${d.name}" · ${d.mode}`);
		info(
			`version   ${d.version}${d.buildAt ? ` ${t("cli.daemon.status.builtAt", { date: new Date(d.buildAt).toLocaleString() })}` : ""}`,
		);
		info(`root      ${d.root}`);
		info(`pid       ${d.pid} (${t("cli.daemon.status.up", { uptime: uptimeText(d.startedAt) })})`);
		info(`protocol  ${d.protocol} · ${d.platform}`);

		if (d.listen) {
			info(`cluster   ${d.listen.host}:${d.listen.port}`);
		}

		const health = await daemonHealth();

		if (health) {
			printHealth(health);
		}

		// answered from the daemon's cached check, so this costs nothing here
		const check = await checkDaemonUpgrade(d.name, false).catch(() => undefined);

		if (check?.offer) {
			warn(
				`update    ${t("cli.daemon.status.updateAvailable", {
					version: check.offer.version,
					origin: check.offer.origin,
					command: pc.cyan("luna daemon upgrade"),
				})}`,
			);
		}
	},
});

command({
	path: ["daemon", "list"],
	desc: t("cli.daemon.list.desc"),

	handler: async () => {
		const rows = await listDaemons();

		const table: string[][] = [];

		for (const row of rows) {
			const health = row.health;

			table.push([
				row.online ? pc.green(Sym.ok) : pc.red(Sym.bad),
				pc.bold(row.name),
				row.mode,
				row.host ?? pc.dim("—"),
				row.instances.length ? row.instances.join(", ") : pc.dim(t("cli.common.none")),
				health ? `${health.cpuPct}%` : pc.dim("—"),
				health ? pctCell(health.memUsedMb, health.memTotalMb) : pc.dim("—"),
				health ? pctCell(health.diskUsedBytes, health.diskTotalBytes) : pc.dim("—"),
				row.latencyMs === null ? pc.dim("—") : `${row.latencyMs}ms`,
				row.outdated
					? pc.yellow(`${row.version} ${t("cli.daemon.list.oldTag")}`)
					: (row.version ?? pc.dim("—")),
				row.online
					? pc.green(t("cli.daemon.list.online"))
					: row.lastSeen
						? new Date(row.lastSeen).toLocaleString()
						: pc.dim(t("cli.daemon.list.never")),
			]);
		}

		printTable(table, {
			head: [
				"",
				t("cli.head.name"),
				t("cli.head.mode"),
				t("cli.head.host"),
				t("cli.head.instances"),
				"cpu",
				"mem",
				t("cli.head.disk"),
				t("cli.head.latency"),
				t("cli.head.version"),
				t("cli.head.lastSeen"),
			],
		});
	},
});

command({
	path: ["daemon", "show"],
	desc: t("cli.daemon.show.desc"),
	args: [
		{
			name: "name",
			required: true,
			complete: async () => (await listDaemons()).map((row) => row.name),
		},
	],

	handler: async (args) => {
		const name = args[0]!;
		const detail = await daemonDetail(name);

		if (!detail) {
			throw new Bail(t("cli.daemon.unknown", { name }));
		}

		const { row } = detail;

		if (row.online) {
			ok(`daemon "${row.name}" · ${row.mode}, ${t("cli.daemon.list.online")}`);
		} else {
			fail(`daemon "${row.name}" · ${row.mode}, ${t("cli.daemon.show.offline")}`);
		}

		info(
			`version   ${row.version ?? pc.dim("—")}${row.outdated ? pc.yellow(` ${t("cli.daemon.show.behindPrimary")}`) : ""}`,
		);
		info(`host      ${row.host ?? pc.dim("—")}${row.addresses.length ? ` (${row.addresses.join(", ")})` : ""}`);
		info(`root      ${row.root ?? pc.dim("—")}`);
		info(
			`instances ${row.instances.length ? row.instances.join(", ") : pc.dim(t("cli.common.none"))}`,
		);

		if (row.latencyMs !== null) {
			info(`latency   ${row.latencyMs}ms`);
		}

		if (row.health) {
			printHealth(row.health);
		}

		if (row.checks.length) {
			console.log("");

			printTable(
				row.checks.map((check) => [
					check.ok === undefined ? pc.dim(Sym.bad) : check.ok ? pc.green(Sym.ok) : pc.red(Sym.bad),
					check.name,
					pc.dim(check.detail),
				]),
				{ head: ["", t("cli.head.check"), t("cli.head.detail")] },
			);
		}

		const rss = Object.entries(row.health?.instanceRssMb ?? {});

		if (rss.length) {
			console.log("");

			printTable(
				rss.map(([instance, mb]) => [
					instance,
					row.health?.states[instance] ?? pc.dim("?"),
					`${mb} MB`,
				]),
				{ head: [t("cli.head.instance"), t("cli.head.state"), t("cli.head.resident")] },
			);
		}
	},
});

/** Bytes → "90.5 MB", the size an upgrade would transfer. */
function mb(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The offers table both `--check` and a refused upgrade print. */
function printOffers(check: UpgradeCheck): void {
	if (check.offers.length > 0) {
		printTable(
			check.offers.map((offer) => [
				offer.newer ? pc.green(Sym.ok) : pc.dim(Sym.bad),
				offer.channel,
				offer.version,
				mb(offer.size),
				pc.dim(offer.origin),
			]),
			{
				head: [
					"",
					t("cli.head.channel"),
					t("cli.head.version"),
					t("cli.head.size"),
					t("cli.head.source"),
				],
			},
		);
	}

	for (const note of check.notes) {
		info(pc.dim(note));
	}
}

command({
	path: ["daemon", "upgrade"],
	desc: t("cli.daemon.upgrade.desc"),
	args: [
		{
			name: "name",
			required: false,
			complete: async () => (await listDaemons()).map((row) => row.name),
		},
	],
	opts: [
		{ flag: "--check", desc: t("cli.daemon.upgrade.optCheck") },
		{ flag: "--force", desc: t("cli.daemon.upgrade.optForce") },
	],

	handler: async (args, opts) => {
		// no name means "this host's daemon", which is the common case for the
		// primary; a follower is always addressed by name from the primary
		const name = args[0] ?? (await ensureConnected()).name;
		const rows = await listDaemons();
		const row = rows.find((entry) => entry.name === name);

		if (!row) {
			throw new Bail(t("cli.daemon.unknown", { name }));
		}

		if (!row.online) {
			throw new Bail(t("cli.daemon.upgrade.notConnected", { name }));
		}

		if (opts.check) {
			const check = await checkDaemonUpgrade(name, true);

			info(t("cli.daemon.upgrade.runs", { name, version: check.current, platform: check.platform }));
			printOffers(check);

			if (check.offer) {
				ok(
					t("cli.daemon.upgrade.available", {
						version: check.offer.version,
						origin: check.offer.origin,
					}),
				);
			} else if (check.offers.length > 0) {
				ok(t("cli.daemon.upgrade.upToDate"));
			} else {
				// "up to date" would be a lie when nothing answered at all
				warn(t("cli.daemon.upgrade.noSource"));
			}

			return;
		}

		info(
			t("cli.daemon.upgrade.upgrading", {
				name,
				version: row.version ?? t("cli.daemon.upgrade.unknownBuild"),
			}),
		);

		// the download is the whole wait, so the daemon's own tree is what the
		// operator watches; this end only renders it
		const progress = new ProgressReporter(`upgrade ${name}`);
		const view = new ProgressView(progress).start();

		let result;

		try {
			result = await upgradeDaemon(name, !!opts.force, progress);

			view.stop();
		} catch (err) {
			view.stop();

			// the daemon's refusal names every channel it tried; show the table
			// underneath it so the reason is obvious rather than quoted
			const check = await checkDaemonUpgrade(name, false).catch(() => undefined);

			if (check) {
				printOffers(check);
			}

			throw new Bail(err instanceof Error ? err.message : String(err));
		}

		ok(
			`${name}: ${result.from} → ${result.to} ${pc.dim(t("cli.daemon.upgrade.fromOrigin", { origin: result.origin }))}`,
		);
		info(t("cli.daemon.upgrade.exitNote"));
	},
});

command({
	path: ["daemon", "remove"],
	desc: t("cli.daemon.remove.desc"),
	args: [
		{
			name: "name",
			required: true,
			complete: async () => {
				try {
					const cfg = await loadCluster();

					return Object.keys(cfg.daemons ?? {});
				} catch {
					return [];
				}
			},
		},
	],

	handler: async (args) => {
		const name = args[0]!;
		const cfg = await loadCluster();

		if (!cfg.daemons?.[name]) {
			throw new Bail(t("cli.daemon.unknown", { name }));
		}

		const rows = await listDaemons();
		const live = rows.find((row) => row.name === name);

		if (live?.online) {
			throw new Bail(t("cli.daemon.remove.stillConnected", { name }));
		}

		const owned = Object.entries(cfg.instances)
			.filter(([, inst]) => inst.daemon === name)
			.map(([instName]) => instName);

		if (owned.length > 0) {
			throw new Bail(t("cli.daemon.remove.ownsInstances", { name, names: owned.join(", ") }));
		}

		delete cfg.daemons[name];
		await saveCluster(cfg);

		ok(t("cli.daemon.remove.done", { name }));
	},
});

command({
	path: ["daemon", "token"],
	desc: t("cli.daemon.token.desc"),
	opts: [{ flag: "--new", desc: t("cli.daemon.token.optNew") }],

	handler: async (_args, opts) => {
		if (opts.new) {
			const bytes = new Uint8Array(32);

			crypto.getRandomValues(bytes);

			// printed, never written: adopting a new token is a cluster-wide edit,
			// and doing it silently here would cut off every follower mid-sentence
			console.log(Buffer.from(bytes).toString("base64url"));

			info(t("cli.daemon.token.setHint", { key: pc.cyan("token") }));
			warn(t("cli.daemon.token.adoptNote"));

			return;
		}

		const { token, from } = await configuredToken();

		if (!token) {
			throw new Bail(
				from
					? t("cli.daemon.token.notConfigured", { file: from })
					: t("cli.daemon.token.noConfig"),
			);
		}

		console.log(token);
		info(t("cli.daemon.token.fromFile", { file: pc.dim(from!) }));
	},
});

/** systemd unit name, without the .service suffix systemctl accepts either way. */
export const UNIT_NAME = "luna-daemon";

/** Where the system-scope unit lives (`luna setup` writes this one). */
export const UNIT_PATH = `/etc/systemd/system/${UNIT_NAME}.service`;

/**
 * The systemd unit for a 24/7 daemon. Shared with `luna setup`, which writes
 * the same file for a machine it has just configured.
 */
export function unitFile(
	binary: string,
	user: string | undefined,
	configFile: string | undefined,
): string {
	const environment = configFile
		? `Environment=LUNA_DAEMON_CONFIG=${configFile}`
		: `Environment=LUNA_ROOT=${process.env.LUNA_ROOT ?? ""}`;

	const lines = [
		"[Unit]",
		"Description=luna cluster daemon",
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		`ExecStart=${binary} daemon run`,
		"Restart=always",
		"RestartSec=5",
		environment,
		// /run/luna is the first socket candidate; letting systemd own it means
		// the daemon never falls back to XDG_RUNTIME_DIR or /tmp, so every client
		// on the machine finds it at the same path
		"RuntimeDirectory=luna",
		"RuntimeDirectoryMode=0755",
		// a server can outlive a stop signal for a while; killing its screens with
		// the daemon would take the cluster down with a restart
		"KillMode=process",
		"TimeoutStopSec=30",
	];

	if (user) {
		lines.push(`User=${user}`);
	}

	lines.push("", "[Install]", `WantedBy=${user ? "multi-user.target" : "default.target"}`, "");

	return lines.join("\n");
}

command({
	path: ["daemon", "service", "install"],
	desc: t("cli.daemon.service.desc"),
	opts: [
		{ flag: "--user", desc: t("cli.daemon.service.optUser") },
		{ flag: "--config", desc: t("cli.daemon.service.optConfig"), value: true },
	],

	handler: async (_args, opts) => {
		// prefer the cluster symlink over a transient build path
		const symlink = "/mnt/shulker/mrds/luna";
		const binary = existsSync(symlink) ? symlink : process.execPath;
		const configFile = (opts.config as string) ?? process.env.LUNA_DAEMON_CONFIG;

		const userScope = !!opts.user;
		const path = userScope
			? join(homedir(), ".config", "systemd", "user", `${UNIT_NAME}.service`)
			: UNIT_PATH;

		const unit = unitFile(binary, userScope ? undefined : userInfo().username, configFile);

		try {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, unit);
		} catch (err) {
			warn(
				t("cli.daemon.service.writeFailed", {
					path,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
			info(t("cli.daemon.service.manualHint"));
			console.log(`\n${pc.dim(`# ${path}`)}\n${unit}`);

			return;
		}

		ok(t("cli.daemon.service.wrote", { path }));

		const ctl = userScope ? "systemctl --user" : "sudo systemctl";

		info(
			t("cli.daemon.service.enableHint", {
				command: pc.cyan(`${ctl} daemon-reload && ${ctl} enable --now luna-daemon`),
			}),
		);
	},
});
