// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Console accounts, sessions, the audit trail and the console journal, at the
 * terminal.
 *
 * The CLI is not signed in to anything: a shell that can reach the daemon socket
 * is already inside the trust boundary, which is exactly how `env --reveal`
 * treats it. So the actor recorded for a change made here is the OS user, marked
 * `cli:` so a trail never mistakes it for a console account of that name; and the
 * first account is created from here, because a console with no accounts has
 * nobody who could create one.
 */

import { command, Bail, UsageError } from "../framework";
import { pc, ok, info, warn, printTable } from "../ui";
import { accountNames } from "../completers";
import { activeUser } from "../actor";
import {
	addAccessKey,
	addMinecraftIdentity,
	auditTrail,
	createAccount,
	deleteAccount,
	getAccount,
	listAccounts,
	listSessions,
	removeIdentity,
	revokeAccountSessions,
	revokeSession,
	setPassword,
	updateAccount,
	type AccountSummary,
	type IdentityKind,
} from "../../client/core/accounts";
import {
	appendJournal,
	JOURNAL_LEVELS,
	JOURNAL_SOURCES,
	readJournal,
	type JournalLevel,
	type JournalSource,
} from "../../client/core/journal";
import { t } from "../../shared/i18n";

/**
 * Who the audit trail records for a change made from a shell: `root`, unless the
 * console's terminal drawer named the account it is running on behalf of. See
 * `cli/actor.ts` for why the CLI is never asked to sign in.
 */
function cliActor(): string {
	return activeUser();
}

/** Date and time of a timestamp, or a dash for "never". */
function stamp(at: number | null | undefined): string {
	if (!at) {
		return pc.dim("—");
	}

	return new Date(at).toLocaleString("en-GB");
}

/** An account's state as one coloured word: the first thing a listing is read for. */
function paintState(account: AccountSummary): string {
	if (!account.enabled) {
		return pc.dim(t("cli.accounts.stateDisabled"));
	}

	if (account.lockedUntil) {
		return pc.red(t("cli.accounts.stateLocked"));
	}

	if (!account.hasPassword) {
		return pc.yellow(t("cli.accounts.stateNoPassword"));
	}

	if (account.mustChangePassword) {
		return pc.yellow(t("cli.accounts.stateMustChange"));
	}

	return pc.green(t("cli.accounts.stateActive"));
}

/** The identity vocabulary, coloured the same way the console colours it. */
function paintKind(kind: IdentityKind): string {
	switch (kind) {
		case "password":
			return pc.blue(t("cli.accounts.kindPassword"));

		case "accessKey":
			return pc.yellow(t("cli.accounts.kindAccessKey"));

		case "minecraft":
			return pc.green(t("cli.accounts.kindMinecraft"));
	}
}

/**
 * Read a password from the terminal, twice, or take `--password`. Refuses to read
 * from a pipe: a password typed into a non-TTY is a password in someone's shell
 * history or CI log.
 */
async function askPassword(opts: Record<string, unknown>, confirming: boolean): Promise<string> {
	const given = opts.password as string | undefined;

	if (given) {
		return given;
	}

	if (!process.stdin.isTTY) {
		throw new UsageError(t("cli.accounts.passwordNeeded"));
	}

	const { password, isCancel, cancel } = await import("@clack/prompts");

	const first = await password({ message: t("cli.accounts.promptPassword") });

	if (isCancel(first)) {
		cancel(t("cli.accounts.cancelled"));

		throw new Bail(t("cli.accounts.cancelled"));
	}

	if (!confirming) {
		return String(first);
	}

	const again = await password({ message: t("cli.accounts.promptPasswordAgain") });

	if (isCancel(again)) {
		cancel(t("cli.accounts.cancelled"));

		throw new Bail(t("cli.accounts.cancelled"));
	}

	if (String(first) !== String(again)) {
		throw new Bail(t("cli.accounts.passwordMismatch"));
	}

	return String(first);
}

command({
	path: ["accounts"],
	desc: t("cli.accounts.list.desc"),

	handler: async () => {
		const accounts = await listAccounts();

		if (accounts.length === 0) {
			console.log();
			warn(t("cli.accounts.list.none"));
			info(t("cli.accounts.list.createHint", { command: pc.cyan("luna account add <username>") }));
			console.log();

			return;
		}

		const rows = accounts.map((account) => [
			pc.bold(account.username),
			paintState(account),
			account.displayName || pc.dim("—"),
			String(account.identities.length),
			String(account.activeSessions),
			stamp(account.lastSignInAt),
		]);

		console.log();
		printTable(rows, {
			head: [
				t("cli.head.username"),
				t("cli.head.state"),
				t("cli.accounts.head.displayName"),
				t("cli.accounts.head.identities"),
				t("cli.accounts.head.sessions"),
				t("cli.accounts.head.lastSignIn"),
			],
		});
		console.log();
	},
});

command({
	path: ["account", "show"],
	desc: t("cli.accounts.show.desc"),
	args: [{ name: "username", required: true, complete: accountNames }],

	handler: async (args) => {
		const name = args[0]!;
		const account = await getAccount(name);

		if (!account) {
			throw new Bail(t("core.accounts.unknown", { name }));
		}

		console.log();
		info(`${pc.bold(account.username)} ${paintState(account)}`);
		printTable(
			[
				[t("cli.accounts.field.id"), pc.dim(account.id)],
				[t("cli.accounts.field.displayName"), account.displayName || pc.dim("—")],
				[t("cli.accounts.field.email"), account.email || pc.dim("—")],
				[t("cli.accounts.field.description"), account.description || pc.dim("—")],
				[t("cli.accounts.field.created"), `${stamp(account.createdAt)} ${pc.dim(account.createdBy ?? "")}`],
				[t("cli.accounts.field.lastSignIn"), stamp(account.lastSignInAt)],
				[t("cli.accounts.field.failedAttempts"), String(account.failedAttempts)],
				[t("cli.accounts.field.lockedUntil"), stamp(account.lockedUntil)],
				[t("cli.accounts.field.sessions"), String(account.activeSessions)],
			],
			{ head: [t("cli.head.field"), t("cli.head.value")] },
		);

		console.log();
		info(t("cli.accounts.show.identities", { count: account.identities.length }));

		if (account.identities.length === 0) {
			warn(t("cli.accounts.show.noIdentities"));
		} else {
			printTable(
				account.identities.map((identity) => [
					pc.dim(identity.id),
					paintKind(identity.kind),
					identity.label,
					identity.disabled ? pc.red(t("cli.accounts.disabled")) : pc.green(t("cli.accounts.enabled")),
					stamp(identity.createdAt),
					stamp(identity.lastUsedAt),
				]),
				{
					head: [
						t("cli.head.id"),
						t("cli.accounts.head.kind"),
						t("cli.head.label"),
						t("cli.head.state"),
						t("cli.head.created"),
						t("cli.accounts.head.lastUsed"),
					],
				},
			);
		}

		console.log();
	},
});

command({
	path: ["account", "add"],
	desc: t("cli.accounts.add.desc"),
	args: [{ name: "username", required: true }],
	opts: [
		{ flag: "--password", desc: t("cli.accounts.add.optPassword"), value: true },
		{ flag: "--display", desc: t("cli.accounts.add.optDisplay"), value: true },
		{ flag: "--email", desc: t("cli.accounts.add.optEmail"), value: true },
		{ flag: "--description", desc: t("cli.accounts.add.optDescription"), value: true },
		{ flag: "--must-change", desc: t("cli.accounts.add.optMustChange") },
		{ flag: "--disabled", desc: t("cli.accounts.add.optDisabled") },
		{ flag: "--no-password", desc: t("cli.accounts.add.optNoPassword") },
	],

	handler: async (args, opts) => {
		const username = args[0]!;
		const withPassword = !opts["no-password"];
		const password = withPassword ? await askPassword(opts, true) : undefined;

		const account = await createAccount(
			{
				username,
				password,
				displayName: opts.display as string | undefined,
				email: opts.email as string | undefined,
				description: opts.description as string | undefined,
				mustChangePassword: !!opts["must-change"],
				disabled: !!opts.disabled,
				allowWeakPassword: true,
			},
			cliActor(),
		);

		await appendJournal({
			source: "cli",
			message: `console account ${account.username} created`,
			actor: cliActor(),
		});

		ok(t("cli.accounts.add.created", { name: pc.bold(account.username) }));

		if (!withPassword) {
			warn(t("cli.accounts.add.noPasswordNote", { name: account.username }));
		}
	},
});

command({
	path: ["account", "password"],
	desc: t("cli.accounts.password.desc"),
	args: [{ name: "username", required: true, complete: accountNames }],
	opts: [
		{ flag: "--password", desc: t("cli.accounts.password.optPassword"), value: true },
		{ flag: "--reset", desc: t("cli.accounts.password.optReset") },
	],

	handler: async (args, opts) => {
		const name = args[0]!;
		const password = await askPassword(opts, true);

		await setPassword(name, password, {
			actor: cliActor(),
			reset: !!opts.reset,
			allowWeak: true,
		});

		await appendJournal({
			source: "cli",
			message: `console password set for ${name}`,
			actor: cliActor(),
		});

		ok(t("cli.accounts.password.set", { name: pc.bold(name) }));

		if (opts.reset) {
			info(t("cli.accounts.password.mustChangeNote"));
		}
	},
});

command({
	path: ["account", "enable"],
	desc: t("cli.accounts.enable.desc"),
	args: [{ name: "username", required: true, complete: accountNames }],

	handler: async (args) => {
		const name = args[0]!;

		await updateAccount(name, { enabled: true, unlock: true }, cliActor());

		ok(t("cli.accounts.enable.done", { name: pc.bold(name) }));
	},
});

command({
	path: ["account", "disable"],
	desc: t("cli.accounts.disable.desc"),
	args: [{ name: "username", required: true, complete: accountNames }],

	handler: async (args) => {
		const name = args[0]!;

		await updateAccount(name, { enabled: false }, cliActor());

		await appendJournal({
			source: "cli",
			level: "warn",
			message: `console account ${name} disabled`,
			actor: cliActor(),
		});

		ok(t("cli.accounts.disable.done", { name: pc.bold(name) }));
	},
});

command({
	path: ["account", "unlock"],
	desc: t("cli.accounts.unlock.desc"),
	args: [{ name: "username", required: true, complete: accountNames }],

	handler: async (args) => {
		const name = args[0]!;

		await updateAccount(name, { unlock: true }, cliActor());

		ok(t("cli.accounts.unlock.done", { name: pc.bold(name) }));
	},
});

command({
	path: ["account", "remove"],
	desc: t("cli.accounts.remove.desc"),
	args: [{ name: "username", required: true, complete: accountNames }],
	opts: [{ flag: "--yes", desc: t("cli.accounts.remove.optYes") }],

	handler: async (args, opts) => {
		const name = args[0]!;
		const account = await getAccount(name);

		if (!account) {
			throw new Bail(t("core.accounts.unknown", { name }));
		}

		if (!opts.yes) {
			const { confirm, isCancel } = await import("@clack/prompts");
			const answer = await confirm({
				message: t("cli.accounts.remove.confirm", {
					name: account.username,
					sessions: account.activeSessions,
				}),
				initialValue: false,
			});

			if (isCancel(answer) || !answer) {
				throw new Bail(t("cli.accounts.cancelled"));
			}
		}

		await deleteAccount(account.id, cliActor());

		await appendJournal({
			source: "cli",
			level: "warn",
			message: `console account ${account.username} deleted`,
			actor: cliActor(),
		});

		ok(t("cli.accounts.remove.done", { name: pc.bold(account.username) }));
	},
});

command({
	path: ["account", "key"],
	desc: t("cli.accounts.key.desc"),
	args: [
		{ name: "username", required: true, complete: accountNames },
		{ name: "label" },
	],

	handler: async (args) => {
		const name = args[0]!;
		const label = args[1] ?? "";
		const created = await addAccessKey(name, label, cliActor());

		ok(t("cli.accounts.key.created", { name: pc.bold(name), label: created.identity.label }));
		console.log();
		console.log(`  ${pc.bold(created.secret)}`);
		console.log();
		warn(t("cli.accounts.key.onceOnly"));
	},
});

command({
	path: ["account", "link"],
	desc: t("cli.accounts.link.desc"),
	args: [
		{ name: "username", required: true, complete: accountNames },
		{ name: "uuid", required: true },
		{ name: "player" },
	],

	handler: async (args) => {
		const name = args[0]!;
		const uuid = args[1]!;
		const identity = await addMinecraftIdentity(name, uuid, args[2] ?? "", cliActor());

		ok(t("cli.accounts.link.done", { name: pc.bold(name), player: identity.label }));
	},
});

command({
	path: ["account", "unlink"],
	desc: t("cli.accounts.unlink.desc"),
	args: [
		{ name: "username", required: true, complete: accountNames },
		{ name: "identity", required: true },
	],

	handler: async (args) => {
		const name = args[0]!;

		await removeIdentity(name, args[1]!, cliActor());

		ok(t("cli.accounts.unlink.done", { id: args[1]!, name: pc.bold(name) }));
	},
});

command({
	path: ["sessions"],
	desc: t("cli.accounts.sessions.desc"),
	opts: [
		{ flag: "--account", desc: t("cli.accounts.sessions.optAccount"), value: true, complete: accountNames },
	],

	handler: async (_args, opts) => {
		const sessions = await listSessions({ account: opts.account as string | undefined });

		if (sessions.length === 0) {
			console.log();
			info(t("cli.accounts.sessions.none"));
			console.log();

			return;
		}

		console.log();
		printTable(
			sessions.map((session) => [
				pc.dim(session.id),
				pc.bold(session.username),
				session.ip ?? pc.dim("—"),
				stamp(session.createdAt),
				stamp(session.lastSeenAt),
				stamp(session.expiresAt),
			]),
			{
				head: [
					t("cli.head.id"),
					t("cli.head.username"),
					t("cli.accounts.head.address"),
					t("cli.accounts.head.opened"),
					t("cli.accounts.head.lastSeen"),
					t("cli.accounts.head.expires"),
				],
			},
		);
		console.log();
	},
});

command({
	path: ["sessions", "revoke"],
	desc: t("cli.accounts.revoke.desc"),
	args: [{ name: "session" }],
	opts: [
		{ flag: "--account", desc: t("cli.accounts.revoke.optAccount"), value: true, complete: accountNames },
	],

	handler: async (args, opts) => {
		const account = opts.account as string | undefined;
		const session = args[0];

		if (!session && !account) {
			throw new UsageError(t("cli.accounts.revoke.needTarget"));
		}

		if (account) {
			const closed = await revokeAccountSessions(account, { actor: cliActor() });

			await appendJournal({
				source: "cli",
				message: `${closed} console session(s) revoked for ${account}`,
				actor: cliActor(),
			});

			ok(t("cli.accounts.revoke.doneAccount", { count: closed, name: pc.bold(account) }));

			return;
		}

		if (!(await revokeSession(session!, cliActor()))) {
			throw new Bail(t("cli.accounts.revoke.unknown", { id: session! }));
		}

		ok(t("cli.accounts.revoke.doneOne", { id: session! }));
	},
});

command({
	path: ["audit"],
	desc: t("cli.accounts.audit.desc"),
	opts: [
		{ flag: "--account", desc: t("cli.accounts.audit.optAccount"), value: true, complete: accountNames },
		{ flag: "--limit", desc: t("cli.accounts.audit.optLimit"), value: true },
	],

	handler: async (_args, opts) => {
		const limit = Number(opts.limit ?? 50);
		const entries = await auditTrail({
			account: opts.account as string | undefined,
			limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
		});

		if (entries.length === 0) {
			console.log();
			info(t("cli.accounts.audit.none"));
			console.log();

			return;
		}

		console.log();
		printTable(
			entries.map((entry) => [
				stamp(entry.t),
				entry.action.startsWith("signin.failed") || entry.action === "signin.locked"
					? pc.red(entry.action)
					: entry.action === "signin.ok"
						? pc.green(entry.action)
						: entry.action,
				entry.account ?? pc.dim("—"),
				entry.actor ?? pc.dim("—"),
				entry.ip ?? pc.dim("—"),
				pc.dim(entry.detail ?? ""),
			]),
			{
				head: [
					t("cli.head.when"),
					t("cli.accounts.head.action"),
					t("cli.accounts.head.account"),
					t("cli.accounts.head.actor"),
					t("cli.accounts.head.address"),
					t("cli.head.detail"),
				],
			},
		);
		console.log();
	},
});

command({
	path: ["logs"],
	desc: t("cli.accounts.logs.desc"),
	opts: [
		{
			flag: "--source",
			desc: t("cli.accounts.logs.optSource"),
			value: true,
			complete: async () => [...JOURNAL_SOURCES],
		},
		{
			flag: "--level",
			desc: t("cli.accounts.logs.optLevel"),
			value: true,
			complete: async () => [...JOURNAL_LEVELS],
		},
		{ flag: "--limit", desc: t("cli.accounts.logs.optLimit"), value: true },
		{ flag: "--search", desc: t("cli.accounts.logs.optSearch"), value: true },
	],

	handler: async (_args, opts) => {
		const source = opts.source as JournalSource | undefined;
		const level = opts.level as JournalLevel | undefined;

		if (source && !JOURNAL_SOURCES.includes(source)) {
			throw new UsageError(
				t("cli.accounts.logs.badSource", { source, known: JOURNAL_SOURCES.join(", ") }),
			);
		}

		if (level && !JOURNAL_LEVELS.includes(level)) {
			throw new UsageError(
				t("cli.accounts.logs.badLevel", { level, known: JOURNAL_LEVELS.join(", ") }),
			);
		}

		const limit = Number(opts.limit ?? 100);
		const page = await readJournal({
			limit: Number.isFinite(limit) && limit > 0 ? limit : 100,
			sources: source ? [source] : undefined,
			minLevel: level,
			search: opts.search as string | undefined,
		});

		if (page.entries.length === 0) {
			console.log();
			info(t("cli.accounts.logs.none"));
			console.log();

			return;
		}

		console.log();

		// oldest first: a log is read downwards, unlike a table of objects
		for (const entry of [...page.entries].reverse()) {
			const level =
				entry.level === "error"
					? pc.red(entry.level)
					: entry.level === "warn"
						? pc.yellow(entry.level)
						: entry.level === "debug"
							? pc.dim(entry.level)
							: pc.blue(entry.level);

			const actor = entry.actor ? pc.dim(` (${entry.actor})`) : "";

			console.log(
				`${pc.dim(new Date(entry.t).toLocaleString("en-GB"))} ${level} ${pc.cyan(entry.source)} ${entry.message}${actor}`,
			);

			if (entry.detail) {
				console.log(`  ${pc.dim(entry.detail)}`);
			}
		}

		console.log();

		if (page.truncated) {
			info(t("cli.accounts.logs.truncated", { count: page.entries.length }));
		}
	},
});
