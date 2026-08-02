import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

import { command, Bail } from "../framework";
import { pc, info, ok, warn, fail, printTable, Sym } from "../ui";
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
	info(`inst mem  ${health.instancesRssMb} MB resident across ${Object.keys(health.instanceRssMb).length} instance(s)`);
}

command({
	path: ["daemon", "run"],
	desc: "Run the mrds daemon in the foreground (primary or follower, per its config)",

	handler: async () => {
		const { runDaemon } = await import("../../daemon/index");

		await runDaemon();
	},
});

command({
	path: ["daemon", "status"],
	desc: "Show the daemon this host's clients are talking to",

	handler: async () => {
		try {
			await ensureConnected();
		} catch (err) {
			if (err instanceof DaemonUnavailable) {
				fail("no daemon is running on this host");
				info(`start one with ${pc.cyan("luna daemon run")} or install the service: ${pc.cyan("luna daemon service install")}`);
				process.exitCode = 1;

				return;
			}

			throw err;
		}

		const d = daemonInfo();

		ok(`daemon "${d.name}" — ${d.mode}`);
		info(`version   ${d.version}${d.buildAt ? ` (built ${new Date(d.buildAt).toLocaleString()})` : ""}`);
		info(`root      ${d.root}`);
		info(`pid       ${d.pid} (up ${uptimeText(d.startedAt)})`);
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
				`update    ${check.offer.version} available from the ${check.offer.origin} — ` +
					`${pc.cyan("luna daemon upgrade")}`,
			);
		}
	},
});

command({
	path: ["daemon", "list"],
	desc: "List every daemon in the cluster with live state",

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
				row.instances.length ? row.instances.join(", ") : pc.dim("none"),
				health ? `${health.cpuPct}%` : pc.dim("—"),
				health ? pctCell(health.memUsedMb, health.memTotalMb) : pc.dim("—"),
				health ? pctCell(health.diskUsedBytes, health.diskTotalBytes) : pc.dim("—"),
				row.latencyMs === null ? pc.dim("—") : `${row.latencyMs}ms`,
				row.outdated ? pc.yellow(`${row.version} (old)`) : (row.version ?? pc.dim("—")),
				row.online
					? pc.green("online")
					: row.lastSeen
						? new Date(row.lastSeen).toLocaleString()
						: pc.dim("never"),
			]);
		}

		printTable(table, {
			head: [
				"",
				"name",
				"mode",
				"host",
				"instances",
				"cpu",
				"mem",
				"disk",
				"latency",
				"version",
				"last seen",
			],
		});
	},
});

command({
	path: ["daemon", "show"],
	desc: "Health, checks and instance memory of one daemon",
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
			throw new Bail(`unknown daemon: ${name}`);
		}

		const { row } = detail;

		if (row.online) {
			ok(`daemon "${row.name}" — ${row.mode}, online`);
		} else {
			fail(`daemon "${row.name}" — ${row.mode}, offline`);
		}

		info(`version   ${row.version ?? pc.dim("—")}${row.outdated ? pc.yellow(" — behind the primary") : ""}`);
		info(`host      ${row.host ?? pc.dim("—")}${row.addresses.length ? ` (${row.addresses.join(", ")})` : ""}`);
		info(`root      ${row.root ?? pc.dim("—")}`);
		info(`instances ${row.instances.length ? row.instances.join(", ") : pc.dim("none")}`);

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
				{ head: ["", "check", "detail"] },
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
				{ head: ["instance", "state", "resident"] },
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
			{ head: ["", "channel", "version", "size", "source"] },
		);
	}

	for (const note of check.notes) {
		info(pc.dim(note));
	}
}

command({
	path: ["daemon", "upgrade"],
	desc: "Upgrade a daemon — from this primary's binary, or the GitHub release",
	args: [
		{
			name: "name",
			required: false,
			complete: async () => (await listDaemons()).map((row) => row.name),
		},
	],
	opts: [
		{ flag: "--check", desc: "report what each channel offers without upgrading" },
		{ flag: "--force", desc: "upgrade even when the build matches or jobs are running" },
	],

	handler: async (args, opts) => {
		// no name means "this host's daemon", which is the common case for the
		// primary — a follower is always addressed by name from the primary
		const name = args[0] ?? (await ensureConnected()).name;
		const rows = await listDaemons();
		const row = rows.find((entry) => entry.name === name);

		if (!row) {
			throw new Bail(`unknown daemon: ${name}`);
		}

		if (!row.online) {
			throw new Bail(`daemon "${name}" is not connected`);
		}

		if (opts.check) {
			const check = await checkDaemonUpgrade(name, true);

			info(`${name} runs ${check.current} (${check.platform})`);
			printOffers(check);

			if (check.offer) {
				ok(`${check.offer.version} available from the ${check.offer.origin}`);
			} else if (check.offers.length > 0) {
				ok("up to date");
			} else {
				// "up to date" would be a lie when nothing answered at all
				warn("no upgrade source could be reached");
			}

			return;
		}

		info(`upgrading ${name} (${row.version ?? "unknown build"})…`);

		let result;

		try {
			result = await upgradeDaemon(name, !!opts.force);
		} catch (err) {
			// the daemon's refusal names every channel it tried; show the table
			// underneath it so the reason is obvious rather than quoted
			const check = await checkDaemonUpgrade(name, false).catch(() => undefined);

			if (check) {
				printOffers(check);
			}

			throw new Bail(err instanceof Error ? err.message : String(err));
		}

		ok(`${name}: ${result.from} → ${result.to} ${pc.dim(`(from the ${result.origin})`)}`);
		info("it exits now; the service manager restarts it on the new build");
	},
});

command({
	path: ["daemon", "remove"],
	desc: "Remove a follower daemon's registration",
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
			throw new Bail(`unknown daemon: ${name}`);
		}

		const rows = await listDaemons();
		const live = rows.find((row) => row.name === name);

		if (live?.online) {
			throw new Bail(`daemon "${name}" is currently connected — stop it first`);
		}

		const owned = Object.entries(cfg.instances)
			.filter(([, inst]) => inst.daemon === name)
			.map(([instName]) => instName);

		if (owned.length > 0) {
			throw new Bail(
				`daemon "${name}" still owns ${owned.join(", ")} — reassign or delete those instances first`,
			);
		}

		delete cfg.daemons[name];
		await saveCluster(cfg);

		ok(`removed daemon registration "${name}"`);
	},
});

command({
	path: ["daemon", "token"],
	desc: "Generate a cluster token for daemon configs",

	handler: async () => {
		const bytes = new Uint8Array(32);

		crypto.getRandomValues(bytes);

		const token = Buffer.from(bytes).toString("base64url");

		console.log(token);
		info(`set as ${pc.cyan("token")} in every daemon's config (primary and followers)`);
	},
});

/** systemd unit name, without the .service suffix systemctl accepts either way. */
export const UNIT_NAME = "mrds-daemon";

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
		? `Environment=MRDS_DAEMON_CONFIG=${configFile}`
		: `Environment=MRDS_ROOT=${process.env.MRDS_ROOT ?? ""}`;

	const lines = [
		"[Unit]",
		"Description=mrds cluster daemon",
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		`ExecStart=${binary} daemon run`,
		"Restart=always",
		"RestartSec=5",
		environment,
		// /run/mrds is the first socket candidate; letting systemd own it means
		// the daemon never falls back to XDG_RUNTIME_DIR or /tmp, so every client
		// on the machine finds it at the same path
		"RuntimeDirectory=mrds",
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
	desc: "Write a systemd unit so the daemon runs 24/7",
	opts: [
		{ flag: "--user", desc: "install as a user service (no root needed)" },
		{ flag: "--config", desc: "daemon config file the unit should point at", value: true },
	],

	handler: async (_args, opts) => {
		// prefer the cluster symlink over a transient build path
		const symlink = "/mnt/shulker/mrds/luna";
		const binary = existsSync(symlink) ? symlink : process.execPath;
		const configFile = (opts.config as string) ?? process.env.MRDS_DAEMON_CONFIG;

		const userScope = !!opts.user;
		const path = userScope
			? join(homedir(), ".config", "systemd", "user", `${UNIT_NAME}.service`)
			: UNIT_PATH;

		const unit = unitFile(binary, userScope ? undefined : userInfo().username, configFile);

		try {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, unit);
		} catch (err) {
			warn(`could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
			info("write it yourself with the following content:");
			console.log(`\n${pc.dim(`# ${path}`)}\n${unit}`);

			return;
		}

		ok(`wrote ${path}`);

		const ctl = userScope ? "systemctl --user" : "sudo systemctl";

		info(`enable + start it with: ${pc.cyan(`${ctl} daemon-reload && ${ctl} enable --now mrds-daemon`)}`);
	},
});
