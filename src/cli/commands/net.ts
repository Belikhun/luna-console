import { command, Bail } from "../framework";
import { pc, Sym, ok, warn, info, printTable, fmtBytes, fmtDuration } from "../ui";
import { instanceNames } from "../completers";
import * as luna from "../../client/core/services/luna";
import { t } from "../../shared/i18n";

/** Coloured label for a backend's Luna-reported status. */
function statusBadge(status: string): string {
	switch (status) {
		case "ONLINE":
			return `${Sym.ok} ${pc.green(t("cli.net.statusOnline"))}`;

		case "MAINT":
			return `${Sym.warn} ${pc.yellow(t("cli.net.statusMaint"))}`;

		default:
			return `${Sym.off} ${pc.dim(t("cli.net.statusOffline"))}`;
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
	const text =
		value === "healthy"
			? t("cli.net.healthHealthy")
			: value === "degraded"
				? t("cli.net.healthDegraded")
				: value;

	switch (value) {
		case "healthy":
			return pc.green(text);

		case "degraded":
			return pc.yellow(text);

		default:
			return pc.red(text);
	}
}

/** Bail with the reason the Luna API could not be reached. */
function bailUnavailable(error: string | undefined): never {
	throw new Bail(
		t("cli.net.apiUnavailable", { error: error ?? t("cli.net.unknownError") }),
	);
}

command({
	path: ["net", "status"],
	desc: t("cli.net.status.desc"),

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
			head: [
				t("cli.head.state"),
				t("cli.head.backend"),
				"tps",
				"cpu",
				t("cli.head.memory"),
				t("cli.head.players"),
				t("cli.head.uptime"),
				t("cli.head.beat"),
			],
		});

		const summary = snapshot.summary;

		console.log(
			pc.dim(
				`\n  ${t("cli.net.status.summary", {
					health: health(snapshot.overallHealth),
					online: snapshot.counts.online,
					total: snapshot.counts.total,
					players: summary.onlinePlayers,
					tps: summary.averageTps.toFixed(2),
					cpu: summary.averageCpu.toFixed(1),
					ramUsed: fmtBytes(summary.totalRamUsedBytes),
					ramMax: fmtBytes(summary.totalRamMaxBytes),
				})}\n`,
			),
		);
	},
});

command({
	path: ["net", "players"],
	desc: t("cli.net.players.desc"),
	opts: [{ flag: "--server", desc: t("cli.net.optServer"), value: true, complete: instanceNames }],

	handler: async (_args, opts) => {
		const result = await luna.players(opts.server as string | undefined);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const list = result.data;

		if (!list.players.length) {
			info(t("cli.net.players.empty"));

			return;
		}

		const rows = list.players.map((player) => [
			pc.bold(player.username),
			player.server || pc.dim(t("cli.net.players.connecting")),
			fmtDuration(player.sessionMillis),
			`${player.pingMillis}ms`,
			pc.dim(player.remoteAddress),
			pc.dim(player.uuid),
		]);

		console.log();
		printTable(rows, {
			head: [
				t("cli.head.player"),
				t("cli.head.server"),
				t("cli.head.session"),
				"ping",
				t("cli.head.address"),
				"uuid",
			],
		});

		const byServer = Object.entries(list.byServer)
			.map(([server, count]) => `${server} ${count}`)
			.sort()
			.join(", ");

		console.log(
			pc.dim(`\n  ${t("cli.net.players.online", { count: list.onlineCount })} · ${byServer}\n`),
		);
	},
});

command({
	path: ["net", "history"],
	desc: t("cli.net.history.desc"),
	args: [{ name: "limit" }],

	handler: async (args) => {
		const limit = Number(args[0] ?? 25);
		const result = await luna.playerHistory(Number.isFinite(limit) ? limit : 25);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const activity = result.data.activity;

		if (!activity.length) {
			info(t("cli.net.history.empty"));

			return;
		}

		const rows = activity.map((entry) => {
			const when = new Date(entry.atEpochMillis).toLocaleTimeString();

			const what =
				entry.type === "join"
					? pc.green(t("cli.net.history.joined"))
					: entry.type === "leave"
						? pc.red(t("cli.net.history.left"))
						: pc.cyan(t("cli.net.history.switched"));

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
		printTable(rows, {
			head: [
				t("cli.head.time"),
				t("cli.head.event"),
				t("cli.head.player"),
				t("cli.head.server"),
				t("cli.head.session"),
			],
		});
		console.log();
	},
});

command({
	path: ["net", "cmd"],
	desc: t("cli.net.cmd.desc"),
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
			info(
				result.data.handled ? t("cli.net.cmd.noOutput") : t("cli.net.cmd.noSuchCommand"),
			);

			return;
		}

		if (!result.data.handled) {
			warn(t("cli.net.cmd.notRecognised"));
		}
	},
});

command({
	path: ["net", "say"],
	desc: t("cli.net.say.desc"),
	args: [{ name: "message", required: true, variadic: true }],
	opts: [{ flag: "--server", desc: t("cli.net.optServer"), value: true, complete: instanceNames }],

	handler: async (args, opts) => {
		const result = await luna.broadcast(args.join(" "), opts.server as string | undefined);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		ok(
			t("cli.net.say.delivered", { count: result.data.reached }) +
				(result.data.server
					? ` ${t("cli.net.say.onServer", { server: result.data.server })}`
					: ""),
		);
	},
});

command({
	path: ["net", "kick"],
	desc: t("cli.net.kick.desc"),
	args: [{ name: "player", required: true }],
	opts: [{ flag: "--reason", desc: t("cli.net.kick.optReason"), value: true }],

	handler: async (args, opts) => {
		const result = await luna.kick(args[0]!, (opts.reason as string) ?? "");

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		ok(t("cli.net.kick.done", { player: pc.bold(result.data.username) }));
	},
});

command({
	path: ["net", "move"],
	desc: t("cli.net.move.desc"),
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
				t("cli.net.move.failed", {
					player: transfer.username,
					server: transfer.server,
					status: `${transfer.status}${transfer.reason ? ` (${transfer.reason})` : ""}`,
				}),
			);

			return;
		}

		ok(
			t("cli.net.move.done", {
				player: pc.bold(transfer.username),
				server: pc.bold(transfer.server),
			}),
		);
	},
});
