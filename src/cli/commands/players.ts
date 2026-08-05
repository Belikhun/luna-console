import { command, Bail, UsageError } from "../framework";
import { pc, Sym, ok, printTable, fmtDuration } from "../ui";
import { instanceNames } from "../completers";
import { loadCluster } from "../../client/core/config";
import * as playerlists from "../../client/core/playerlists";
import type { AccessListKind } from "../../client/core/playerlists";
import * as luna from "../../client/core/services/luna";
import { t } from "../../shared/i18n";

/** The list names the access commands accept. */
const LIST_NAMES: AccessListKind[] = ["whitelist", "ops", "bans", "ban-ips"];

/** Bail with the reason the Luna API could not be reached. */
function bailUnavailable(error: string | undefined): never {
	throw new Bail(
		t("cli.net.apiUnavailable", { error: error ?? t("cli.net.unknownError") }),
	);
}

function parseList(raw: string): AccessListKind {
	if (!LIST_NAMES.includes(raw as AccessListKind)) {
		throw new UsageError(
			t("cli.players.unknownList", { name: raw, known: LIST_NAMES.join(", ") }),
		);
	}

	return raw as AccessListKind;
}

function fmtEpoch(millis: number): string {
	if (!millis) {
		return pc.dim("—");
	}

	return new Date(millis).toLocaleString();
}

command({
	path: ["access"],
	desc: t("cli.players.access.desc"),
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lists = await playerlists.getAccessLists(cfg, args[0]!);

		console.log();
		console.log(
			`  ${pc.bold(lists.instance)} · ${lists.state}, ${t("cli.players.access.whitelistLabel")} ` +
				(lists.whitelistEnabled
					? pc.green(t("cli.players.access.on"))
					: pc.dim(t("cli.players.access.off"))) +
				(lists.enforceWhitelist ? pc.yellow(` ${t("cli.players.access.enforced")}`) : ""),
		);

		console.log(`\n  ${pc.bold(t("cli.players.access.whitelist"))} (${lists.whitelist.length})`);
		printTable(lists.whitelist.map((entry) => [entry.name, pc.dim(entry.uuid)]));

		console.log(`\n  ${pc.bold(t("cli.players.access.operators"))} (${lists.ops.length})`);
		printTable(
			lists.ops.map((entry) => [
				entry.name,
				t("cli.players.access.level", { level: entry.level }),
				pc.dim(entry.uuid),
			]),
		);

		console.log(`\n  ${pc.bold(t("cli.players.access.bans"))} (${lists.bans.length})`);
		printTable(
			lists.bans.map((entry) => [
				entry.name,
				entry.reason ?? pc.dim("—"),
				pc.dim(t("cli.players.access.bySource", { source: entry.source, date: entry.created })),
			]),
		);

		console.log(`\n  ${pc.bold(t("cli.players.access.ipBans"))} (${lists.ipBans.length})`);
		printTable(
			lists.ipBans.map((entry) => [
				entry.ip,
				entry.reason ?? pc.dim("—"),
				pc.dim(t("cli.players.access.bySource", { source: entry.source, date: entry.created })),
			]),
		);
		console.log();
	},
});

command({
	path: ["access", "add"],
	desc: t("cli.players.accessAdd.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "list", required: true, complete: async () => [...LIST_NAMES] },
		{ name: "target", required: true },
	],
	opts: [
		{ flag: "--reason", desc: t("cli.players.accessAdd.optReason"), value: true },
		{ flag: "--level", desc: t("cli.players.accessAdd.optLevel"), value: true },
	],

	handler: async (args, opts) => {
		const cfg = await loadCluster();
		const list = parseList(args[1]!);

		const result = await playerlists.applyAccessChange(cfg, args[0]!, {
			list,
			action: "add",
			target: args[2]!,
			reason: (opts.reason as string) ?? "",
			level: opts.level ? Number(opts.level) : undefined,
			actor: "cli",
		});

		if (!result.ok) {
			throw new Bail(result.error ?? t("cli.players.notApplied"));
		}

		ok(
			t("cli.players.accessAdd.done", {
				target: result.target,
				list: result.list,
				instance: result.instance,
				method: result.method,
			}),
		);
	},
});

command({
	path: ["access", "remove"],
	desc: t("cli.players.accessRemove.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "list", required: true, complete: async () => [...LIST_NAMES] },
		{ name: "target", required: true },
	],

	handler: async (args) => {
		const cfg = await loadCluster();
		const list = parseList(args[1]!);

		const result = await playerlists.applyAccessChange(cfg, args[0]!, {
			list,
			action: "remove",
			target: args[2]!,
			actor: "cli",
		});

		if (!result.ok) {
			throw new Bail(result.error ?? t("cli.players.notApplied"));
		}

		ok(
			t("cli.players.accessRemove.done", {
				target: result.target,
				list: result.list,
				instance: result.instance,
				method: result.method,
			}),
		);
	},
});

command({
	path: ["access", "whitelist"],
	desc: t("cli.players.whitelist.desc"),
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "state", required: true, complete: async () => ["on", "off"] },
	],

	handler: async (args) => {
		const wanted = args[1]!;

		if (wanted !== "on" && wanted !== "off") {
			throw new UsageError(t("cli.players.whitelist.badState", { value: wanted }));
		}

		const cfg = await loadCluster();
		const result = await playerlists.setWhitelistEnabled(cfg, args[0]!, wanted === "on");

		ok(
			t("cli.players.whitelist.done", {
				state: wanted,
				instance: result.instance,
				method: result.method,
			}),
		);
	},
});

command({
	path: ["net", "registered"],
	desc: t("cli.players.registered.desc"),
	opts: [
		{ flag: "--search", desc: t("cli.players.registered.optSearch"), value: true },
		{ flag: "--limit", desc: t("cli.players.registered.optLimit"), value: true },
	],

	handler: async (_args, opts) => {
		const result = await luna.registeredPlayers({
			search: (opts.search as string) ?? undefined,
			limit: opts.limit ? Number(opts.limit) : 25,
			sort: "lastSeen",
		});

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const rows = result.data.players.map((player) => [
			player.online
				? `${Sym.ok} ${pc.green(t("cli.net.statusOnline"))}`
				: `${Sym.off} ${pc.dim(t("cli.net.statusOffline"))}`,
			pc.bold(player.username),
			player.online ? player.server : pc.dim(player.lastServer || "—"),
			player.online ? pc.dim(t("cli.players.now")) : fmtEpoch(player.lastSeenAtEpochMillis),
			fmtDuration(player.totalPlayMillis),
			String(player.sessionCount),
		]);

		console.log();
		printTable(rows, {
			head: [
				t("cli.head.state"),
				t("cli.head.player"),
				t("cli.head.backend"),
				t("cli.head.lastSeen"),
				t("cli.head.playtime"),
				t("cli.head.sessions"),
			],
		});
		console.log(pc.dim(`\n  ${t("cli.players.registered.total", { count: result.data.total })}\n`));
	},
});

command({
	path: ["net", "player"],
	desc: t("cli.players.player.desc"),
	args: [{ name: "player", required: true }],

	handler: async (args) => {
		const result = await luna.registeredPlayer(args[0]!);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const player = result.data;

		console.log();
		console.log(`  ${pc.bold(player.username)} ${pc.dim(player.uuid)}`);
		console.log(
			`  ${
				player.online
					? pc.green(t("cli.players.player.onlineOn", { server: player.server }))
					: pc.dim(t("cli.net.statusOffline"))
			}` +
				` · ${player.onlineMode ? t("cli.players.player.premium") : t("cli.players.player.offlineMode")}`,
		);
		console.log();

		printTable([
			[t("cli.players.player.firstSeen"), fmtEpoch(player.firstSeenAtEpochMillis)],
			[
				t("cli.head.lastSeen"),
				player.online ? t("cli.players.now") : fmtEpoch(player.lastSeenAtEpochMillis),
			],
			[t("cli.head.playtime"), fmtDuration(player.totalPlayMillis)],
			[t("cli.head.sessions"), String(player.sessionCount)],
			[t("cli.players.player.chatMessages"), String(player.chatTotal)],
			[t("cli.players.player.commands"), String(player.commandTotal)],
			[t("cli.players.player.moderationEntries"), String(player.moderationTotal)],
			[
				t("cli.players.player.permissionGroup"),
				player.permissions.available
					? player.permissions.primaryGroupDisplay || player.permissions.primaryGroup || pc.dim("—")
					: pc.dim(t("cli.players.player.luckpermsUnavailable")),
			],
			[t("cli.players.player.lastAddress"), player.lastAddress || pc.dim("—")],
			[t("cli.players.player.client"), player.lastClientVersion || pc.dim("—")],
		]);

		if (player.playtimeByServer.length > 0) {
			console.log(`\n  ${pc.bold(t("cli.players.player.playtimeByBackend"))}`);
			printTable(
				player.playtimeByServer.map((entry) => [
					entry.server || t("cli.players.player.unknownServer"),
					fmtDuration(entry.playMillis),
					pc.dim(t("cli.players.player.stints", { count: entry.stints })),
				]),
			);
		}

		console.log();
	},
});

command({
	path: ["net", "skin"],
	desc: t("cli.players.skin.desc"),
	args: [{ name: "player", required: true }],
	opts: [
		{ flag: "--name", desc: t("cli.players.skin.optName"), value: true },
		{ flag: "--url", desc: t("cli.players.skin.optUrl"), value: true },
		{ flag: "--variant", desc: t("cli.players.skin.optVariant"), value: true },
		{ flag: "--reset", desc: t("cli.players.skin.optReset") },
	],

	handler: async (args, opts) => {
		const player = args[0]!;

		let change;

		if (opts.reset) {
			change = { mode: "reset" as const, actor: "cli" };
		} else if (opts.name) {
			change = { mode: "name" as const, skin: String(opts.name), actor: "cli" };
		} else if (opts.url) {
			change = {
				mode: "url" as const,
				url: String(opts.url),
				variant: opts.variant ? String(opts.variant) : undefined,
				actor: "cli",
			};
		} else {
			throw new UsageError(t("cli.players.skin.pickOne"));
		}

		const result = await luna.setSkin(player, change);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		if (change.mode === "reset") {
			ok(t("cli.players.skin.resetDone", { player }));
			return;
		}

		ok(
			t("cli.players.skin.changed", { player }) +
				(result.data.applied ? "" : ` ${t("cli.players.skin.storedNote")}`),
		);
	},
});

command({
	path: ["net", "auth"],
	desc: t("cli.players.auth.desc"),
	args: [{ name: "player", required: true }],

	handler: async (args) => {
		const result = await luna.authAccount(args[0]!);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const account = result.data;
		const password = !account.registered
			? pc.dim(t("cli.players.auth.notRegistered"))
			: account.temporaryPassword
				? pc.yellow(
						t("cli.players.auth.temporary", {
							date: fmtEpoch(account.temporaryPasswordUntilEpochMillis),
						}),
					)
				: t("cli.players.auth.setByPlayer");

		console.log();
		console.log(`  ${pc.bold(account.username)} ${pc.dim(account.uuid)}`);
		printTable([
			[t("cli.players.auth.password"), password],
			[
				t("cli.players.auth.signedIn"),
				account.authenticated ? `${Sym.ok} ${t("cli.players.auth.yes")}` : pc.dim(t("cli.players.auth.no")),
			],
			[
				t("cli.players.auth.accountLock"),
				account.locked
					? pc.red(t("cli.players.auth.lockedUntil", { date: fmtEpoch(account.lockedUntilEpochMillis) }))
					: pc.dim(t("cli.players.auth.notLocked")),
			],
			[t("cli.players.auth.failedAttempts"), String(account.failedAttempts)],
			[t("cli.players.auth.lastLogin"), fmtEpoch(account.lastLoginAtEpochMillis)],
			[t("cli.players.player.lastAddress"), account.lastIp || pc.dim("—")],
			[
				t("cli.players.auth.resumableSession"),
				account.session.hasSession
					? t("cli.players.auth.until", { date: fmtEpoch(account.session.expiresAtEpochMillis) })
					: pc.dim(t("cli.common.none")),
			],
		]);
		console.log();
	},
});

command({
	path: ["net", "vault"],
	desc: t("cli.players.vault.desc"),
	args: [{ name: "player", required: true }],
	opts: [{ flag: "--limit", desc: t("cli.players.vault.optLimit"), value: true }],

	handler: async (args, opts) => {
		const player = args[0]!;
		const limit = opts.limit ? Number(opts.limit) : 10;

		const [account, history] = await Promise.all([
			luna.vaultAccount(player),
			luna.vaultTransactions(player, 0, Math.max(1, limit)),
		]);

		if (!account.ok || !account.data) {
			bailUnavailable(account.error);
		}

		const wallet = account.data;

		console.log();
		console.log(`  ${pc.bold(wallet.username)} ${pc.dim(wallet.uuid)}`);
		printTable([
			[t("cli.players.vault.balance"), pc.bold(wallet.balanceFormatted)],
			[
				t("cli.players.vault.rank"),
				wallet.rank
					? `#${wallet.rank} ${pc.dim(t("cli.players.vault.of", { count: wallet.accountCount }))}`
					: pc.dim(t("cli.players.vault.noAccount")),
			],
			[t("cli.players.vault.transactions"), String(wallet.summary.transactionCount)],
			[t("cli.players.vault.totalReceived"), wallet.summary.receivedFormatted],
			[t("cli.players.vault.totalSpent"), wallet.summary.sentFormatted],
			[t("cli.players.vault.lastTransaction"), fmtEpoch(wallet.summary.lastAtEpochMillis)],
		]);

		if (!history.ok || !history.data || history.data.entries.length === 0) {
			console.log();
			return;
		}

		console.log();
		printTable(
			history.data.entries.map((entry) => [
				pc.dim(fmtEpoch(entry.atEpochMillis)),
				entry.direction === "in"
					? pc.green(`+${entry.amountFormatted}`)
					: entry.direction === "out"
						? pc.yellow(`-${entry.amountFormatted}`)
						: pc.dim(`±${entry.amountFormatted}`),
				entry.system ? pc.dim(t("cli.players.vault.system")) : entry.counterpartyName || pc.dim("—"),
				pc.dim(entry.source || "—"),
				entry.details || "",
			]),
			{
				head: [
					t("cli.head.when"),
					t("cli.head.amount"),
					t("cli.head.counterparty"),
					t("cli.head.source"),
					t("cli.head.details"),
				],
			},
		);
		console.log(
			`  ${pc.dim(t("cli.players.vault.showing", { count: history.data.entries.length, total: history.data.totalCount }))}`,
		);
		console.log();
	},
});

command({
	path: ["net", "password"],
	desc: t("cli.players.password.desc"),
	args: [{ name: "player", required: true }],
	opts: [
		{ flag: "--reset", desc: t("cli.players.password.optReset") },
		{ flag: "--temporary", desc: t("cli.players.password.optTemporary") },
		{ flag: "--password", desc: t("cli.players.password.optPassword"), value: true },
		{ flag: "--minutes", desc: t("cli.players.password.optMinutes"), value: true },
		{ flag: "--unlock", desc: t("cli.players.password.optUnlock") },
		{ flag: "--logout", desc: t("cli.players.password.optLogout") },
	],

	handler: async (args, opts) => {
		const player = args[0]!;

		let change;

		if (opts.reset) {
			change = { action: "reset" as const, actor: "cli" };
		} else if (opts.temporary) {
			change = {
				action: "temporary" as const,
				password: opts.password ? String(opts.password) : undefined,
				expiresInMinutes: opts.minutes ? Number(opts.minutes) : undefined,
				actor: "cli",
			};
		} else if (opts.unlock) {
			change = { action: "unlock" as const, actor: "cli" };
		} else if (opts.logout) {
			change = { action: "logout" as const, actor: "cli" };
		} else {
			throw new UsageError(t("cli.players.password.pickOne"));
		}

		const result = await luna.setAuth(player, change);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		if (change.action === "temporary") {
			// the plaintext exists only in this response; print it plainly, since
			// there is nowhere else it can be read from afterwards
			ok(
				t("cli.players.password.temporaryFor", {
					player,
					password: pc.bold(result.data.password ?? ""),
				}),
			);
			console.log(
				`  ${pc.dim(
					t("cli.players.password.expiresNote", {
						date: fmtEpoch(result.data.temporaryPasswordUntilEpochMillis),
					}),
				)}`,
			);
			return;
		}

		ok(result.data.message || t("cli.players.password.applied", { action: change.action, player }));
	},
});

command({
	path: ["perms", "groups"],
	desc: t("cli.players.permsGroups.desc"),

	handler: async () => {
		const result = await luna.permissionGroups();

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const rows = result.data.groups.map((group) => [
			pc.bold(group.name),
			String(group.weight),
			group.prefix || pc.dim("—"),
			group.parents.join(", ") || pc.dim("—"),
			String(group.nodeCount),
			String(group.memberCount),
		]);

		console.log();
		printTable(rows, {
			head: [
				t("cli.head.group"),
				t("cli.head.weight"),
				t("cli.head.prefix"),
				t("cli.head.inherits"),
				t("cli.head.nodes"),
				t("cli.head.members"),
			],
		});
		console.log();
	},
});

command({
	path: ["perms", "group"],
	desc: t("cli.players.permsGroup.desc"),
	args: [{ name: "group", required: true }],

	handler: async (args) => {
		const result = await luna.permissionGroup(args[0]!);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const group = result.data;

		console.log();
		console.log(
			`  ${pc.bold(group.name)} · ${t("cli.players.permsGroup.weight", { weight: group.weight })}` +
				(group.displayName && group.displayName !== group.name ? ` (${group.displayName})` : ""),
		);

		if (group.prefix || group.suffix) {
			console.log(
				`  ${t("cli.head.prefix")} ${group.prefix || pc.dim("—")} · ${t("cli.players.permsGroup.suffix")} ${group.suffix || pc.dim("—")}`,
			);
		}

		if (group.parents.length > 0) {
			console.log(`  ${t("cli.players.permsGroup.inherits", { names: group.parents.join(", ") })}`);
		}

		console.log(`\n  ${pc.bold(t("cli.head.nodes"))} (${group.nodes.length})`);
		printTable(
			group.nodes.map((node) => [
				node.key,
				node.value ? pc.green("true") : pc.red("false"),
				node.contexts.map((pair) => `${pair.key}=${pair.value}`).join(", ") ||
					pc.dim(t("cli.players.permsGroup.global")),
			]),
		);

		console.log(`\n  ${pc.bold(t("cli.head.members"))} (${group.members.length})`);
		printTable(group.members.map((member) => [member.username || pc.dim("?"), pc.dim(member.uuid)]));
		console.log();
	},
});

command({
	path: ["perms", "user"],
	desc: t("cli.players.permsUser.desc"),
	args: [{ name: "player", required: true }],

	handler: async (args) => {
		const result = await luna.permissionUser(args[0]!);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const user = result.data;

		console.log();
		console.log(`  ${pc.bold(user.username || args[0]!)} ${pc.dim(user.uuid)}`);
		console.log(
			`  ${t("cli.players.permsUser.primaryGroup", { group: pc.bold(user.primaryGroup) })} · ${t("cli.players.permsUser.groups", { names: user.groups.join(", ") || "—" })}`,
		);

		console.log(`\n  ${pc.bold(t("cli.players.permsUser.directNodes"))} (${user.nodes.length})`);
		printTable(
			user.nodes.map((node) => [
				node.key,
				node.value ? pc.green("true") : pc.red("false"),
				node.contexts.map((pair) => `${pair.key}=${pair.value}`).join(", ") ||
					pc.dim(t("cli.players.permsGroup.global")),
			]),
		);
		console.log();
	},
});
