import { command, Bail, UsageError } from "../framework";
import { pc, Sym, ok, printTable, fmtDuration } from "../ui";
import { instanceNames } from "../completers";
import { loadCluster } from "../../client/core/config";
import * as playerlists from "../../client/core/playerlists";
import type { AccessListKind } from "../../client/core/playerlists";
import * as luna from "../../client/core/services/luna";

/** The list names the access commands accept. */
const LIST_NAMES: AccessListKind[] = ["whitelist", "ops", "bans", "ban-ips"];

/** Bail with the reason the Luna API could not be reached. */
function bailUnavailable(error: string | undefined): never {
	throw new Bail(`LunaCore API unavailable: ${error ?? "unknown error"}`);
}

function parseList(raw: string): AccessListKind {
	if (!LIST_NAMES.includes(raw as AccessListKind)) {
		throw new UsageError(`unknown list "${raw}" — one of: ${LIST_NAMES.join(", ")}`);
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
	desc: "Show an instance's whitelist, operators and bans",
	args: [{ name: "instance", required: true, complete: instanceNames }],

	handler: async (args) => {
		const cfg = await loadCluster();
		const lists = await playerlists.getAccessLists(cfg, args[0]!);

		console.log();
		console.log(
			`  ${pc.bold(lists.instance)} — ${lists.state}, whitelist ` +
				(lists.whitelistEnabled ? pc.green("on") : pc.dim("off")) +
				(lists.enforceWhitelist ? pc.yellow(" (enforced)") : ""),
		);

		console.log(`\n  ${pc.bold("whitelist")} (${lists.whitelist.length})`);
		printTable(lists.whitelist.map((entry) => [entry.name, pc.dim(entry.uuid)]));

		console.log(`\n  ${pc.bold("operators")} (${lists.ops.length})`);
		printTable(lists.ops.map((entry) => [entry.name, `level ${entry.level}`, pc.dim(entry.uuid)]));

		console.log(`\n  ${pc.bold("bans")} (${lists.bans.length})`);
		printTable(
			lists.bans.map((entry) => [
				entry.name,
				entry.reason ?? pc.dim("—"),
				pc.dim(`by ${entry.source}, ${entry.created}`),
			]),
		);

		console.log(`\n  ${pc.bold("ip bans")} (${lists.ipBans.length})`);
		printTable(
			lists.ipBans.map((entry) => [
				entry.ip,
				entry.reason ?? pc.dim("—"),
				pc.dim(`by ${entry.source}, ${entry.created}`),
			]),
		);
		console.log();
	},
});

command({
	path: ["access", "add"],
	desc: "Add a player (or IP) to one of an instance's access lists",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "list", required: true, complete: async () => [...LIST_NAMES] },
		{ name: "target", required: true },
	],
	opts: [
		{ flag: "--reason", desc: "ban reason", value: true },
		{ flag: "--level", desc: "op permission level (1-4)", value: true },
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
			throw new Bail(result.error ?? "the change was not applied");
		}

		ok(`${result.target} added to ${result.list} on ${result.instance} (${result.method})`);
	},
});

command({
	path: ["access", "remove"],
	desc: "Remove a player (or IP) from one of an instance's access lists",
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
			throw new Bail(result.error ?? "the change was not applied");
		}

		ok(`${result.target} removed from ${result.list} on ${result.instance} (${result.method})`);
	},
});

command({
	path: ["access", "whitelist"],
	desc: "Turn an instance's whitelist on or off",
	args: [
		{ name: "instance", required: true, complete: instanceNames },
		{ name: "state", required: true, complete: async () => ["on", "off"] },
	],

	handler: async (args) => {
		const wanted = args[1]!;

		if (wanted !== "on" && wanted !== "off") {
			throw new UsageError(`expected "on" or "off", got "${wanted}"`);
		}

		const cfg = await loadCluster();
		const result = await playerlists.setWhitelistEnabled(cfg, args[0]!, wanted === "on");

		ok(`whitelist ${wanted} on ${result.instance} (${result.method})`);
	},
});

command({
	path: ["net", "registered"],
	desc: "The player directory: everyone the network has ever recorded",
	opts: [
		{ flag: "--search", desc: "filter by name or uuid", value: true },
		{ flag: "--limit", desc: "rows to show (default 25)", value: true },
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
			player.online ? `${Sym.ok} ${pc.green("online")}` : `${Sym.off} ${pc.dim("offline")}`,
			pc.bold(player.username),
			player.online ? player.server : pc.dim(player.lastServer || "—"),
			player.online ? pc.dim("now") : fmtEpoch(player.lastSeenAtEpochMillis),
			fmtDuration(player.totalPlayMillis),
			String(player.sessionCount),
		]);

		console.log();
		printTable(rows, { head: ["state", "player", "backend", "last seen", "playtime", "sessions"] });
		console.log(pc.dim(`\n  ${result.data.total} player(s) in the directory\n`));
	},
});

command({
	path: ["net", "player"],
	desc: "One player's profile: identity, playtime, permissions, moderation",
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
			`  ${player.online ? pc.green(`online on ${player.server}`) : pc.dim("offline")}` +
				` — ${player.onlineMode ? "premium" : "offline-mode"} account`,
		);
		console.log();

		printTable([
			["first seen", fmtEpoch(player.firstSeenAtEpochMillis)],
			["last seen", player.online ? "now" : fmtEpoch(player.lastSeenAtEpochMillis)],
			["playtime", fmtDuration(player.totalPlayMillis)],
			["sessions", String(player.sessionCount)],
			["chat messages", String(player.chatTotal)],
			["commands", String(player.commandTotal)],
			["moderation entries", String(player.moderationTotal)],
			[
				"permission group",
				player.permissions.available
					? player.permissions.primaryGroupDisplay || player.permissions.primaryGroup || pc.dim("—")
					: pc.dim("luckperms unavailable"),
			],
			["last address", player.lastAddress || pc.dim("—")],
			["client", player.lastClientVersion || pc.dim("—")],
		]);

		if (player.playtimeByServer.length > 0) {
			console.log(`\n  ${pc.bold("playtime by backend")}`);
			printTable(
				player.playtimeByServer.map((entry) => [
					entry.server || "unknown",
					fmtDuration(entry.playMillis),
					pc.dim(`${entry.stints} session(s)`),
				]),
			);
		}

		console.log();
	},
});

command({
	path: ["net", "skin"],
	desc: "Change or reset a player's skin through SkinsRestorer",
	args: [{ name: "player", required: true }],
	opts: [
		{ flag: "--name", desc: "mirror this Mojang account's skin", value: true },
		{ flag: "--url", desc: "generate from a public image URL (via MineSkin)", value: true },
		{ flag: "--variant", desc: "classic or slim (with --url)", value: true },
		{ flag: "--reset", desc: "drop the stored skin" },
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
			throw new UsageError("pass one of --name, --url or --reset");
		}

		const result = await luna.setSkin(player, change);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		if (change.mode === "reset") {
			ok(`${player}'s stored skin dropped — their own skin applies again`);
			return;
		}

		ok(`${player}'s skin changed${result.data.applied ? "" : " (stored; applies on next login)"}`);
	},
});

command({
	path: ["net", "auth"],
	desc: "A player's authentication state, as luna-auth holds it",
	args: [{ name: "player", required: true }],

	handler: async (args) => {
		const result = await luna.authAccount(args[0]!);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const account = result.data;
		const password = !account.registered
			? pc.dim("none — not registered")
			: account.temporaryPassword
				? pc.yellow(`temporary, expires ${fmtEpoch(account.temporaryPasswordUntilEpochMillis)}`)
				: "set by the player";

		console.log();
		console.log(`  ${pc.bold(account.username)} ${pc.dim(account.uuid)}`);
		printTable([
			["password", password],
			["signed in", account.authenticated ? `${Sym.ok} yes` : pc.dim("no")],
			[
				"account lock",
				account.locked
					? pc.red(`locked until ${fmtEpoch(account.lockedUntilEpochMillis)}`)
					: pc.dim("not locked"),
			],
			["failed attempts", String(account.failedAttempts)],
			["last login", fmtEpoch(account.lastLoginAtEpochMillis)],
			["last address", account.lastIp || pc.dim("—")],
			[
				"resumable session",
				account.session.hasSession
					? `until ${fmtEpoch(account.session.expiresAtEpochMillis)}`
					: pc.dim("none"),
			],
		]);
		console.log();
	},
});

command({
	path: ["net", "password"],
	desc: "Reset a player's password, or issue a temporary one",
	args: [{ name: "player", required: true }],
	opts: [
		{ flag: "--reset", desc: "clear the password — the player must /register again" },
		{ flag: "--temporary", desc: "issue a temporary password, generated unless --password is given" },
		{ flag: "--password", desc: "the password to set (with --temporary)", value: true },
		{ flag: "--minutes", desc: "how long a temporary password lasts (default 1440)", value: true },
		{ flag: "--unlock", desc: "clear a lockout from failed attempts" },
		{ flag: "--logout", desc: "end the current authenticated session" },
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
			throw new UsageError("pass one of --reset, --temporary, --unlock or --logout");
		}

		const result = await luna.setAuth(player, change);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		if (change.action === "temporary") {
			// the plaintext exists only in this response — print it plainly, since
			// there is nowhere else it can be read from afterwards
			ok(`temporary password for ${player}: ${pc.bold(result.data.password ?? "")}`);
			console.log(
				`  ${pc.dim(`expires ${fmtEpoch(result.data.temporaryPasswordUntilEpochMillis)} — only its hash is stored`)}`,
			);
			return;
		}

		ok(result.data.message || `${change.action} applied to ${player}`);
	},
});

command({
	path: ["perms", "groups"],
	desc: "LuckPerms groups across the network, heaviest weight first",

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
		printTable(rows, { head: ["group", "weight", "prefix", "inherits", "nodes", "members"] });
		console.log();
	},
});

command({
	path: ["perms", "group"],
	desc: "One LuckPerms group: meta, nodes and members",
	args: [{ name: "group", required: true }],

	handler: async (args) => {
		const result = await luna.permissionGroup(args[0]!);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const group = result.data;

		console.log();
		console.log(
			`  ${pc.bold(group.name)} — weight ${group.weight}` +
				(group.displayName && group.displayName !== group.name ? ` (${group.displayName})` : ""),
		);

		if (group.prefix || group.suffix) {
			console.log(`  prefix ${group.prefix || pc.dim("—")} · suffix ${group.suffix || pc.dim("—")}`);
		}

		if (group.parents.length > 0) {
			console.log(`  inherits: ${group.parents.join(", ")}`);
		}

		console.log(`\n  ${pc.bold("nodes")} (${group.nodes.length})`);
		printTable(
			group.nodes.map((node) => [
				node.key,
				node.value ? pc.green("true") : pc.red("false"),
				node.contexts.map((pair) => `${pair.key}=${pair.value}`).join(", ") || pc.dim("global"),
			]),
		);

		console.log(`\n  ${pc.bold("members")} (${group.members.length})`);
		printTable(group.members.map((member) => [member.username || pc.dim("?"), pc.dim(member.uuid)]));
		console.log();
	},
});

command({
	path: ["perms", "user"],
	desc: "One player's LuckPerms data: groups and direct nodes",
	args: [{ name: "player", required: true }],

	handler: async (args) => {
		const result = await luna.permissionUser(args[0]!);

		if (!result.ok || !result.data) {
			bailUnavailable(result.error);
		}

		const user = result.data;

		console.log();
		console.log(`  ${pc.bold(user.username || args[0]!)} ${pc.dim(user.uuid)}`);
		console.log(`  primary group: ${pc.bold(user.primaryGroup)} · groups: ${user.groups.join(", ") || pc.dim("—")}`);

		console.log(`\n  ${pc.bold("direct nodes")} (${user.nodes.length})`);
		printTable(
			user.nodes.map((node) => [
				node.key,
				node.value ? pc.green("true") : pc.red("false"),
				node.contexts.map((pair) => `${pair.key}=${pair.value}`).join(", ") || pc.dim("global"),
			]),
		);
		console.log();
	},
});
