import { command, Bail } from "../framework";
import { pc, Sym, ok, warn, info, printTable, fmtBytes, fmtDuration } from "../ui";
import { instanceNames } from "../completers";
import * as luna from "../../core/services/luna";

/** Coloured label for a backend's Luna-reported status. */
function statusBadge(status: string): string {
	switch (status) {
		case "ONLINE":
			return `${Sym.ok} ${pc.green("online")}`;

		case "MAINT":
			return `${Sym.warn} ${pc.yellow("maint")}`;

		default:
			return `${Sym.off} ${pc.dim("offline")}`;
	}
}

/** Colour a TPS reading by how far it has fallen behind 20. */
function tps(value: number): string {
	const text = value.toFixed(2);

	if (value <= 0) {
		return pc.dim("—");
	}

	if (value >= 19) {
		return pc.green(text);
	}

	return value >= 15 ? pc.yellow(text) : pc.red(text);
}

/** Colour the health verdict the proxy computes for the whole network. */
function health(value: string): string {
	switch (value) {
		case "healthy":
			return pc.green(value);

		case "degraded":
			return pc.yellow(value);

		default:
			return pc.red(value);
	}
}

/** Bail with the reason the Luna API could not be reached. */
function bailUnavailable(error: string | undefined): never {
	throw new Bail(`LunaCore API unavailable: ${error ?? "unknown error"}`);
}

command({
	path: ["net", "status"],
	desc: "Network telemetry from LunaCore on the proxy (TPS, CPU, RAM, players)",

	handler: async () => {
		const result = await luna.dashboard();

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const snapshot = result.data;

		const rows = snapshot.backends.map((backend) => [
			statusBadge(backend.status),
			pc.bold(backend.id),
			tps(backend.metrics.tps),
			backend.metrics.processCpuUsagePercent > 0
				? `${backend.metrics.processCpuUsagePercent.toFixed(1)}%`
				: pc.dim("—"),
			backend.metrics.ramMaxBytes > 0
				? `${fmtBytes(backend.metrics.ramUsedBytes)} / ${fmtBytes(backend.metrics.ramMaxBytes)}`
				: pc.dim("—"),
			backend.metrics.maxPlayers > 0
				? `${backend.metrics.onlinePlayers}/${backend.metrics.maxPlayers}`
				: pc.dim("—"),
			backend.metrics.uptimeMillis > 0 ? fmtDuration(backend.metrics.uptimeMillis) : pc.dim("—"),
			backend.metrics.heartbeatLatencyMillis > 0
				? `${backend.metrics.heartbeatLatencyMillis}ms`
				: pc.dim("—"),
		]);

		console.log();
		printTable(rows, {
			head: ["state", "backend", "tps", "cpu", "memory", "players", "uptime", "beat"],
		});

		const summary = snapshot.summary;

		console.log(
			pc.dim(
				`\n  network ${health(snapshot.overallHealth)}${pc.dim("")} — ` +
					`${snapshot.counts.online}/${snapshot.counts.total} backends up, ` +
					`${summary.onlinePlayers} players, avg tps ${summary.averageTps.toFixed(2)}, ` +
					`avg cpu ${summary.averageCpu.toFixed(1)}%, ` +
					`ram ${fmtBytes(summary.totalRamUsedBytes)} / ${fmtBytes(summary.totalRamMaxBytes)}\n`,
			),
		);
	},
});

command({
	path: ["net", "players"],
	desc: "Players connected to the network, with session times",
	opts: [{ flag: "--server", desc: "only this backend", value: true, complete: instanceNames }],

	handler: async (_args, opts) => {
		const result = await luna.players(opts.server as string | undefined);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const list = result.data;

		if (!list.players.length) {
			info("nobody is connected");

			return;
		}

		const rows = list.players.map((player) => [
			pc.bold(player.username),
			player.server || pc.dim("(connecting)"),
			fmtDuration(player.sessionMillis),
			`${player.pingMillis}ms`,
			pc.dim(player.remoteAddress),
			pc.dim(player.uuid),
		]);

		console.log();
		printTable(rows, { head: ["player", "server", "session", "ping", "address", "uuid"] });

		const byServer = Object.entries(list.byServer)
			.map(([server, count]) => `${server} ${count}`)
			.sort()
			.join(", ");

		console.log(pc.dim(`\n  ${list.onlineCount} online — ${byServer}\n`));
	},
});

command({
	path: ["net", "history"],
	desc: "Recent join, leave and server-switch activity",
	args: [{ name: "limit" }],

	handler: async (args) => {
		const limit = Number(args[0] ?? 25);
		const result = await luna.playerHistory(Number.isFinite(limit) ? limit : 25);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const activity = result.data.activity;

		if (!activity.length) {
			info("no activity recorded since the proxy started");

			return;
		}

		const rows = activity.map((entry) => {
			const when = new Date(entry.atEpochMillis).toLocaleTimeString();

			const what =
				entry.type === "join"
					? pc.green("joined")
					: entry.type === "leave"
						? pc.red("left")
						: pc.cyan("switched");

			const where =
				entry.type === "switch"
					? `${pc.dim(entry.previousServer)} ${Sym.arrow} ${entry.server}`
					: entry.server || pc.dim("—");

			return [
				pc.dim(when),
				what,
				pc.bold(entry.username),
				where,
				entry.sessionMillis > 0 ? pc.dim(fmtDuration(entry.sessionMillis)) : pc.dim("—"),
			];
		});

		console.log();
		printTable(rows, { head: ["time", "event", "player", "server", "session"] });
		console.log();
	},
});

command({
	path: ["net", "cmd"],
	desc: "Run a command on the proxy console and print its reply",
	args: [{ name: "command", required: true, variadic: true }],

	handler: async (args) => {
		const result = await luna.runCommand(args.join(" "));

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		for (const line of result.data.output) {
			console.log(`  ${line}`);
		}

		if (!result.data.output.length) {
			info(result.data.handled ? "command ran with no output" : "no such command on the proxy");

			return;
		}

		if (!result.data.handled) {
			warn("the proxy did not recognise that command");
		}
	},
});

command({
	path: ["net", "say"],
	desc: "Broadcast a MiniMessage-formatted message to players",
	args: [{ name: "message", required: true, variadic: true }],
	opts: [{ flag: "--server", desc: "only this backend", value: true, complete: instanceNames }],

	handler: async (args, opts) => {
		const result = await luna.broadcast(args.join(" "), opts.server as string | undefined);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		ok(
			`delivered to ${result.data.reached} player(s)` +
				(result.data.server ? ` on ${result.data.server}` : ""),
		);
	},
});

command({
	path: ["net", "kick"],
	desc: "Disconnect a player from the network",
	args: [{ name: "player", required: true }],
	opts: [{ flag: "--reason", desc: "message shown to the player", value: true }],

	handler: async (args, opts) => {
		const result = await luna.kick(args[0]!, (opts.reason as string) ?? "");

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		ok(`kicked ${pc.bold(result.data.username)}`);
	},
});

command({
	path: ["net", "move"],
	desc: "Move a player to another backend",
	args: [
		{ name: "player", required: true },
		{ name: "server", required: true, complete: instanceNames },
	],

	handler: async (args) => {
		const result = await luna.transfer(args[0]!, args[1]!);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const transfer = result.data;

		if (!transfer.successful) {
			warn(
				`${transfer.username} was not moved to ${transfer.server}: ` +
					`${transfer.status}${transfer.reason ? ` — ${transfer.reason}` : ""}`,
			);

			return;
		}

		ok(`moved ${pc.bold(transfer.username)} to ${pc.bold(transfer.server)}`);
	},
});
