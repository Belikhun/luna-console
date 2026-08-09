// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Console accounts: who may sign in to the luna console, what credentials they
 * sign in with, which sessions are open, and what was done to those accounts.
 *
 * The model is IAM's, minus authorization: an **account** is the identity, and
 * its **identities** are the separate credentials attached to it; a console
 * password, an access key for scripts, a linked Minecraft profile. Every account
 * can do everything in this phase, so nothing here decides what an account may
 * touch, only whether the person at the keyboard is the account they claim.
 *
 * Two stores, deliberately:
 *
 * - `accounts.json` is cluster state; accounts, their identities and the audit
 *   trail. It is primary-owned and mirrored to followers like every other state
 *   file, so a follower's write forwards up instead of being clobbered.
 * - `sessions.json` is the primary's own runtime state and is **not** mirrored.
 *   The console only ever runs beside the primary, so a follower could not
 *   validate a session token if it had one; copying live credentials onto
 *   machines that cannot use them buys nothing.
 *
 * No secret is ever stored in the clear. A password is argon2id-hashed; an
 * access key's secret and a session's token are 256-bit random values, so a
 * SHA-256 digest is all their lookups need. Neither the store nor the audit
 * trail ever holds a value a listing could leak.
 */

import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { MIN_PASSWORD_LENGTH, USERNAME_PATTERN } from "../shared/accountrules";
import { t } from "../shared/i18n";
import { notifySave, statePath } from "./config";

const ACCOUNTS_FILE = "accounts.json";
const SESSIONS_FILE = "sessions.json";

/** What an account may sign in with. */
export type IdentityKind = "password" | "accessKey" | "minecraft";

// the create form validates against these as the operator types, so they live in
// shared/ where a component can reach them; re-exported here because everything
// account-shaped is read off this module
export { MIN_PASSWORD_LENGTH, USERNAME_PATTERN };

/**
 * The identity a client that reached the daemon socket directly acts as.
 *
 * The CLI does not sign in: the socket's file permissions are the check, and a
 * shell that can open it can already do everything the daemon can. So its changes
 * are recorded against `root`, meaning "the machine itself" rather than a person,
 * and the name is **reserved** so no console account can be created under it. A
 * trail where `root` might be either the shell or somebody's chosen username would
 * be worse than no trail.
 */
export const ROOT_ACTOR = "root";

/** Usernames the store refuses, because they mean something else in the trail. */
const RESERVED_USERNAMES = new Set([ROOT_ACTOR, "system", "daemon"]);

/** How long a session stays valid without being renewed. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * How stale a session's `lastSeenAt` may get before a read persists it. Every
 * request resolves a session, and writing the store each time would rewrite the
 * file (and wake the sync watcher) on every page load.
 */
export const SESSION_TOUCH_MS = 5 * 60 * 1000;

/** Consecutive failed sign-ins before an account is locked out. */
export const MAX_SIGNIN_FAILURES = 8;

/** How long that lockout lasts. */
export const LOCKOUT_MS = 15 * 60 * 1000;

/** Audit entries kept per store, oldest dropped first. */
export const MAX_AUDIT = 2_000;

/**
 * One credential attached to an account.
 *
 * `secretHash` covers `password` and `accessKey`; a Minecraft identity has no
 * secret of its own, because the proxy authenticated that player already and
 * this only records the link.
 */
export interface ConsoleIdentity {
	id: string;
	kind: IdentityKind;
	/** What this credential is for, in the operator's own words */
	label: string;
	createdAt: number;
	lastUsedAt?: number;
	/** Kept but refused; how a leaked access key is retired without losing its trail */
	disabled?: boolean;
	/** argon2id for a password, SHA-256 for an access key; never leaves the daemon */
	secretHash?: string;
	/** The linked player's UUID, for a `minecraft` identity */
	uuid?: string;
	/** The linked player's name at the time of linking; UUIDs are unreadable */
	playerName?: string;
}

export interface ConsoleAccount {
	/** Stable id; the username can be renamed, this cannot */
	id: string;
	username: string;
	displayName?: string;
	email?: string;
	description?: string;
	/** A disabled account keeps everything and is refused at sign-in */
	enabled: boolean;
	createdAt: number;
	/** Username of whoever created it, or the bootstrap that had no actor */
	createdBy?: string;
	lastSignInAt?: number;
	/** Set by an administrator's password reset; the console asks on next sign-in */
	mustChangePassword?: boolean;
	/** Consecutive failures since the last success; the lockout counter */
	failedAttempts?: number;
	/** Epoch millis the lockout expires at, when one is in force */
	lockedUntil?: number;
	identities: ConsoleIdentity[];
}

/** Everything the audit trail records. */
export type AuditAction =
	| "account.create"
	| "account.update"
	| "account.delete"
	| "account.enable"
	| "account.disable"
	| "password.set"
	| "identity.add"
	| "identity.remove"
	| "signin.ok"
	| "signin.failed"
	| "signin.locked"
	| "signout"
	| "session.revoke";

/**
 * One recorded action. Values are deliberately absent, exactly as the
 * environment trail: this says a password was set, never what it was set to, so
 * the audit is not itself somewhere credentials accumulate.
 */
export interface AuditEntry {
	/** Epoch millis */
	t: number;
	action: AuditAction;
	/** Username the action was performed on, when it names one account */
	account?: string;
	/** Username that performed it; absent for an unauthenticated attempt */
	actor?: string;
	/** Client address, for the sign-in actions where it is the useful fact */
	ip?: string;
	/** Short, non-secret note; which field changed, which identity, why a refusal */
	detail?: string;
}

export interface AccountStore {
	accounts: ConsoleAccount[];
	audit: AuditEntry[];
}

export interface ConsoleSession {
	id: string;
	/** The account's id, not its username: a rename must not orphan a session */
	account: string;
	/** SHA-256 of the bearer token; the token itself exists only in the cookie */
	tokenHash: string;
	createdAt: number;
	lastSeenAt: number;
	expiresAt: number;
	ip?: string;
	agent?: string;
}

export interface SessionStore {
	sessions: ConsoleSession[];
}

/**
 * An account as every listing sees it: the identities are described, never
 * carried. Nothing on this shape can leak a credential, which is what makes it
 * safe to hand to a route, a table or a CLI command.
 */
export interface AccountSummary {
	id: string;
	username: string;
	displayName: string;
	email: string;
	description: string;
	enabled: boolean;
	createdAt: number;
	createdBy: string | null;
	lastSignInAt: number | null;
	mustChangePassword: boolean;
	/** Locked out by failed sign-ins, and until when */
	lockedUntil: number | null;
	failedAttempts: number;
	/** True once a console password exists; an account without one cannot sign in */
	hasPassword: boolean;
	identities: IdentitySummary[];
	/** Open, unexpired sessions for this account */
	activeSessions: number;
}

export interface IdentitySummary {
	id: string;
	kind: IdentityKind;
	label: string;
	createdAt: number;
	lastUsedAt: number | null;
	disabled: boolean;
	/** `minecraft` only */
	uuid: string | null;
	playerName: string | null;
}

/** A session as a listing sees it, with the account's name resolved. */
export interface SessionSummary {
	id: string;
	account: string;
	username: string;
	createdAt: number;
	lastSeenAt: number;
	expiresAt: number;
	ip: string | null;
	agent: string | null;
	/** True for the session that asked; the one a revoke-all should keep */
	current: boolean;
}

/** What a sign-in hands back. The token is the only copy that will ever exist. */
export interface SignInResult {
	token: string;
	expiresAt: number;
	account: AccountSummary;
}

/** A freshly minted access key. The secret is returned once and never stored. */
export interface AccessKeyResult {
	identity: IdentitySummary;
	/** `<keyId>.<secret>`; what a script sends as its bearer token */
	secret: string;
}

/** Where the caller is, for the audit trail. Both fields are optional. */
export interface ClientMeta {
	ip?: string;
	agent?: string;
}

function accountsPath(): string {
	return statePath(ACCOUNTS_FILE);
}

function sessionsPath(): string {
	return statePath(SESSIONS_FILE);
}

/** Read the account store, treating a missing file as an empty cluster. */
export async function loadAccounts(): Promise<AccountStore> {
	if (!existsSync(accountsPath())) {
		return { accounts: [], audit: [] };
	}

	const store: AccountStore = await Bun.file(accountsPath()).json();

	store.accounts ??= [];
	store.audit ??= [];

	for (const account of store.accounts) {
		account.identities ??= [];
	}

	return store;
}

/**
 * Write the account store back, username-sorted to keep diffs small, and
 * announce the save so a follower's write reaches the primary.
 */
export async function saveAccounts(store: AccountStore): Promise<void> {
	const sorted: AccountStore = {
		accounts: [...store.accounts].sort((left, right) => left.username.localeCompare(right.username)),
		audit: store.audit.slice(-MAX_AUDIT),
	};

	await Bun.write(accountsPath(), JSON.stringify(sorted, null, "\t") + "\n");

	await notifySave("accounts", sorted);
}

/** Read the session store, dropping anything already expired. */
export async function loadSessions(): Promise<SessionStore> {
	if (!existsSync(sessionsPath())) {
		return { sessions: [] };
	}

	const store: SessionStore = await Bun.file(sessionsPath()).json();
	const now = Date.now();

	return { sessions: (store.sessions ?? []).filter((session) => session.expiresAt > now) };
}

/**
 * Write the session store. Deliberately **not** announced through `notifySave`:
 * sessions are the primary's own runtime state, and the console that mints them
 * never runs anywhere else.
 */
export async function saveSessions(store: SessionStore): Promise<void> {
	await Bun.write(sessionsPath(), JSON.stringify({ sessions: store.sessions }, null, "\t") + "\n");
}

/** 128 bits of id, prefixed so a stray value says what it is. */
function newId(prefix: string): string {
	return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** SHA-256 hex. Only ever applied to values that are already 256-bit random. */
function digest(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

/**
 * Compare two hex digests without leaking where they diverge. The token arrives
 * from the client, so the lookup is an attacker-controlled comparison.
 */
function sameDigest(left: string, right: string): boolean {
	if (left.length !== right.length) {
		return false;
	}

	let diff = 0;

	for (let i = 0; i < left.length; i++) {
		diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	}

	return diff === 0;
}

/**
 * A hash to verify against when the username does not exist. Without it a miss
 * returns in microseconds and a hit takes argon2's full cost, which is enough to
 * enumerate accounts from the outside. Computed once, lazily, because building it
 * costs the same as one real verification.
 */
let decoyHash: string | undefined;

async function burnVerification(password: string): Promise<void> {
	decoyHash ??= await Bun.password.hash(randomBytes(16).toString("hex"), {
		algorithm: "argon2id",
	});

	try {
		await Bun.password.verify(password, decoyHash);
	} catch {
		// the point was the elapsed time, not the answer
	}
}

/** Append to the audit trail, dropping the oldest past the cap. */
export function recordAudit(store: AccountStore, entry: Omit<AuditEntry, "t">): void {
	store.audit.push({ t: Date.now(), ...entry });

	if (store.audit.length > MAX_AUDIT) {
		store.audit.splice(0, store.audit.length - MAX_AUDIT);
	}
}

/** Find an account by id or (case-insensitively) by username. */
export function findAccount(store: AccountStore, idOrName: string): ConsoleAccount | undefined {
	const wanted = idOrName.toLowerCase();

	return store.accounts.find(
		(account) => account.id === idOrName || account.username.toLowerCase() === wanted,
	);
}

/** Find an account by id or username, or reject with a message naming it. */
export function requireAccount(store: AccountStore, idOrName: string): ConsoleAccount {
	const account = findAccount(store, idOrName);

	if (!account) {
		throw new Error(t("core.accounts.unknown", { name: idOrName }));
	}

	return account;
}

function identitySummary(identity: ConsoleIdentity): IdentitySummary {
	return {
		id: identity.id,
		kind: identity.kind,
		label: identity.label,
		createdAt: identity.createdAt,
		lastUsedAt: identity.lastUsedAt ?? null,
		disabled: !!identity.disabled,
		uuid: identity.uuid ?? null,
		playerName: identity.playerName ?? null,
	};
}

/** Whether an account's lockout is still in force. */
export function isLocked(account: ConsoleAccount, now = Date.now()): boolean {
	return !!account.lockedUntil && account.lockedUntil > now;
}

/**
 * The masked view of one account. `sessions` is passed in rather than loaded so
 * a listing counts every account's sessions from a single read.
 */
export function summarize(account: ConsoleAccount, sessions: ConsoleSession[] = []): AccountSummary {
	const now = Date.now();

	return {
		id: account.id,
		username: account.username,
		displayName: account.displayName ?? "",
		email: account.email ?? "",
		description: account.description ?? "",
		enabled: account.enabled,
		createdAt: account.createdAt,
		createdBy: account.createdBy ?? null,
		lastSignInAt: account.lastSignInAt ?? null,
		mustChangePassword: !!account.mustChangePassword,
		lockedUntil: isLocked(account, now) ? account.lockedUntil! : null,
		failedAttempts: account.failedAttempts ?? 0,
		hasPassword: account.identities.some(
			(identity) => identity.kind === "password" && !identity.disabled,
		),
		identities: account.identities.map(identitySummary),
		activeSessions: sessions.filter(
			(session) => session.account === account.id && session.expiresAt > now,
		).length,
	};
}

/** Every account, masked, with its open-session count; the Accounts screen's rows. */
export async function listAccounts(): Promise<AccountSummary[]> {
	const store = await loadAccounts();
	const { sessions } = await loadSessions();

	return store.accounts
		.map((account) => summarize(account, sessions))
		.sort((left, right) => left.username.localeCompare(right.username));
}

/** One account, masked, or undefined when no account goes by that id or name. */
export async function getAccount(idOrName: string): Promise<AccountSummary | undefined> {
	const store = await loadAccounts();
	const account = findAccount(store, idOrName);

	if (!account) {
		return undefined;
	}

	const { sessions } = await loadSessions();

	return summarize(account, sessions);
}

/**
 * The audit trail, newest first, optionally narrowed to one account (by username
 * or id, matching either the subject or the actor).
 */
export async function auditTrail(
	opts: { account?: string; limit?: number } = {},
): Promise<AuditEntry[]> {
	const store = await loadAccounts();
	let entries = [...store.audit].reverse();

	if (opts.account) {
		const account = findAccount(store, opts.account);
		const name = (account?.username ?? opts.account).toLowerCase();

		entries = entries.filter(
			(entry) => entry.account?.toLowerCase() === name || entry.actor?.toLowerCase() === name,
		);
	}

	return opts.limit ? entries.slice(0, opts.limit) : entries;
}

function assertUsername(store: AccountStore, username: string, exceptId?: string): void {
	if (!USERNAME_PATTERN.test(username)) {
		throw new Error(t("core.accounts.badUsername"));
	}

	if (RESERVED_USERNAMES.has(username.toLowerCase())) {
		throw new Error(t("core.accounts.reservedUsername", { name: username }));
	}

	const clash = store.accounts.find(
		(account) =>
			account.id !== exceptId && account.username.toLowerCase() === username.toLowerCase(),
	);

	if (clash) {
		throw new Error(t("core.accounts.usernameTaken", { name: username }));
	}
}

/**
 * Hold a new password to the length rule, unless the caller opted out.
 *
 * The opt-out exists for the CLI, and the reasoning is the same one that leaves
 * the CLI ungated entirely: a shell that can open the daemon socket can already
 * do everything the daemon can, so a length rule there protects nothing it could
 * not simply edit around. The console keeps the rule, because that is the surface
 * a password actually defends.
 */
function assertPassword(password: string, allowWeak?: boolean): void {
	if (allowWeak) {
		return;
	}

	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(t("core.accounts.passwordTooShort", { min: MIN_PASSWORD_LENGTH }));
	}
}

export interface CreateAccountInput {
	username: string;
	/** Optional: an account can exist before it has a way in */
	password?: string;
	displayName?: string;
	email?: string;
	description?: string;
	mustChangePassword?: boolean;
	/** Created disabled, for an account being prepared ahead of its owner */
	disabled?: boolean;
	/** Skip the length rule; the CLI sets this, the console never does */
	allowWeakPassword?: boolean;
}

/**
 * Create an account, optionally with its console password. The actor is recorded
 * in the trail and as the account's creator; leave it out only for a bootstrap,
 * where by definition nobody is signed in yet.
 */
export async function createAccount(
	input: CreateAccountInput,
	actor?: string,
): Promise<AccountSummary> {
	const store = await loadAccounts();

	assertUsername(store, input.username);

	if (input.password !== undefined) {
		assertPassword(input.password, input.allowWeakPassword);
	}

	const account: ConsoleAccount = {
		id: newId("acc"),
		username: input.username,
		displayName: input.displayName || undefined,
		email: input.email || undefined,
		description: input.description || undefined,
		enabled: !input.disabled,
		createdAt: Date.now(),
		createdBy: actor,
		mustChangePassword: input.mustChangePassword || undefined,
		identities: [],
	};

	if (input.password !== undefined) {
		account.identities.push({
			id: newId("id"),
			kind: "password",
			label: t("core.accounts.consolePassword"),
			createdAt: Date.now(),
			secretHash: await Bun.password.hash(input.password, { algorithm: "argon2id" }),
		});
	}

	store.accounts.push(account);

	recordAudit(store, {
		action: "account.create",
		account: account.username,
		actor,
		detail: input.password !== undefined ? t("core.accounts.withPassword") : undefined,
	});

	await saveAccounts(store);

	return summarize(account);
}

/**
 * The first account, created while nobody can be signed in. Refuses outright
 * once any account exists, which is what stops the first-run form from being a
 * way in on a cluster that already has operators.
 */
export async function bootstrapAccount(
	input: { username: string; password: string },
	meta: ClientMeta = {},
): Promise<AccountSummary> {
	const store = await loadAccounts();

	if (store.accounts.length > 0) {
		throw new Error(t("core.accounts.bootstrapDone"));
	}

	assertPassword(input.password);

	const created = await createAccount(
		{ username: input.username, password: input.password },
		undefined,
	);

	// a second load: createAccount saved its own copy, and this note belongs after it
	const fresh = await loadAccounts();

	recordAudit(fresh, {
		action: "account.update",
		account: created.username,
		ip: meta.ip,
		detail: t("core.accounts.bootstrapNote"),
	});

	await saveAccounts(fresh);

	return created;
}

/** True while the console has no accounts at all, so the first-run form applies. */
export async function bootstrapNeeded(): Promise<boolean> {
	const store = await loadAccounts();

	return store.accounts.length === 0;
}

export interface AccountPatch {
	username?: string;
	displayName?: string;
	email?: string;
	description?: string;
	enabled?: boolean;
	mustChangePassword?: boolean;
	/** Clear a lockout without waiting it out */
	unlock?: boolean;
}

/**
 * Change an account's own fields. Only the keys present are touched, so a form
 * that renders three fields cannot blank the fourth.
 */
export async function updateAccount(
	idOrName: string,
	patch: AccountPatch,
	actor?: string,
): Promise<AccountSummary> {
	const store = await loadAccounts();
	const account = requireAccount(store, idOrName);
	const changed: string[] = [];

	if (patch.username !== undefined && patch.username !== account.username) {
		assertUsername(store, patch.username, account.id);
		changed.push("username");
		account.username = patch.username;
	}

	if (patch.displayName !== undefined) {
		account.displayName = patch.displayName || undefined;
		changed.push("displayName");
	}

	if (patch.email !== undefined) {
		account.email = patch.email || undefined;
		changed.push("email");
	}

	if (patch.description !== undefined) {
		account.description = patch.description || undefined;
		changed.push("description");
	}

	if (patch.mustChangePassword !== undefined) {
		account.mustChangePassword = patch.mustChangePassword || undefined;
		changed.push("mustChangePassword");
	}

	if (patch.unlock) {
		account.lockedUntil = undefined;
		account.failedAttempts = 0;
		changed.push("unlock");
	}

	// enabling and disabling get their own audit actions: "someone was locked out
	// of the console" is the question a trail is read for, and it should not be
	// buried in a list of edited fields
	if (patch.enabled !== undefined && patch.enabled !== account.enabled) {
		account.enabled = patch.enabled;

		recordAudit(store, {
			action: patch.enabled ? "account.enable" : "account.disable",
			account: account.username,
			actor,
		});
	}

	if (changed.length > 0) {
		recordAudit(store, {
			action: "account.update",
			account: account.username,
			actor,
			detail: changed.join(", "),
		});
	}

	await saveAccounts(store);

	// a disabled account keeps no way in; its open sessions go with it
	if (patch.enabled === false) {
		await revokeAccountSessions(account.id);
	}

	const { sessions } = await loadSessions();

	return summarize(account, sessions);
}

/**
 * Delete an account and every session it holds. Refuses to remove the last
 * enabled account: an empty store puts the console back into first-run, which
 * would let anyone who can reach it claim the cluster.
 */
export async function deleteAccount(idOrName: string, actor?: string): Promise<void> {
	const store = await loadAccounts();
	const account = requireAccount(store, idOrName);

	const others = store.accounts.filter(
		(other) => other.id !== account.id && other.enabled && other.identities.length > 0,
	);

	if (others.length === 0) {
		throw new Error(t("core.accounts.lastAccount", { name: account.username }));
	}

	store.accounts = store.accounts.filter((other) => other.id !== account.id);

	recordAudit(store, { action: "account.delete", account: account.username, actor });

	await saveAccounts(store);
	await revokeAccountSessions(account.id);
}

/**
 * Set an account's console password, replacing whatever password identity it had.
 * `current` is required when the account is changing its own password, and
 * omitted for an administrator's reset; a reset also sets `mustChangePassword`,
 * so the owner is asked for a new one on their next sign-in.
 */
export async function setPassword(
	idOrName: string,
	password: string,
	opts: {
		current?: string;
		actor?: string;
		reset?: boolean;
		/** Skip the length rule; the CLI sets this, the console never does */
		allowWeak?: boolean;
	} = {},
): Promise<void> {
	const store = await loadAccounts();
	const account = requireAccount(store, idOrName);

	assertPassword(password, opts.allowWeak);

	if (opts.current !== undefined) {
		const existing = account.identities.find((identity) => identity.kind === "password");

		if (!existing?.secretHash || !(await Bun.password.verify(opts.current, existing.secretHash))) {
			throw new Error(t("core.accounts.currentWrong"));
		}
	}

	account.identities = account.identities.filter((identity) => identity.kind !== "password");

	account.identities.unshift({
		id: newId("id"),
		kind: "password",
		label: t("core.accounts.consolePassword"),
		createdAt: Date.now(),
		secretHash: await Bun.password.hash(password, { algorithm: "argon2id" }),
	});

	account.mustChangePassword = opts.reset ? true : undefined;
	account.failedAttempts = 0;
	account.lockedUntil = undefined;

	recordAudit(store, {
		action: "password.set",
		account: account.username,
		actor: opts.actor,
		detail: opts.reset ? t("core.accounts.resetByAdmin") : t("core.accounts.changedByOwner"),
	});

	await saveAccounts(store);
}

/**
 * Mint an access key for an account. The secret is returned once, here, and only
 * its digest is kept; there is no path that can show it again, which is the whole
 * point of the shape.
 */
export async function addAccessKey(
	idOrName: string,
	label: string,
	actor?: string,
): Promise<AccessKeyResult> {
	const store = await loadAccounts();
	const account = requireAccount(store, idOrName);

	const id = newId("key");
	const secret = randomBytes(32).toString("base64url");
	const identity: ConsoleIdentity = {
		id,
		kind: "accessKey",
		label: label || t("core.accounts.accessKey"),
		createdAt: Date.now(),
		secretHash: digest(secret),
	};

	account.identities.push(identity);

	recordAudit(store, {
		action: "identity.add",
		account: account.username,
		actor,
		detail: `accessKey ${identity.label}`,
	});

	await saveAccounts(store);

	return { identity: identitySummary(identity), secret: `${id}.${secret}` };
}

/**
 * Link a Minecraft profile to an account. It carries no secret: the proxy
 * authenticated that player, so the link is a record, not a credential.
 */
export async function addMinecraftIdentity(
	idOrName: string,
	uuid: string,
	playerName: string,
	actor?: string,
): Promise<IdentitySummary> {
	const store = await loadAccounts();
	const account = requireAccount(store, idOrName);

	if (!/^[0-9a-fA-F-]{32,36}$/.test(uuid)) {
		throw new Error(t("core.accounts.badUuid", { uuid }));
	}

	const clash = store.accounts.find((other) =>
		other.identities.some((identity) => identity.kind === "minecraft" && identity.uuid === uuid),
	);

	if (clash) {
		throw new Error(t("core.accounts.uuidTaken", { uuid, name: clash.username }));
	}

	const identity: ConsoleIdentity = {
		id: newId("mc"),
		kind: "minecraft",
		label: playerName || uuid,
		createdAt: Date.now(),
		uuid,
		playerName: playerName || undefined,
	};

	account.identities.push(identity);

	recordAudit(store, {
		action: "identity.add",
		account: account.username,
		actor,
		detail: `minecraft ${identity.label}`,
	});

	await saveAccounts(store);

	return identitySummary(identity);
}

/** Remove one identity from an account. */
export async function removeIdentity(
	idOrName: string,
	identityId: string,
	actor?: string,
): Promise<void> {
	const store = await loadAccounts();
	const account = requireAccount(store, idOrName);
	const identity = account.identities.find((entry) => entry.id === identityId);

	if (!identity) {
		throw new Error(t("core.accounts.unknownIdentity", { id: identityId }));
	}

	account.identities = account.identities.filter((entry) => entry.id !== identityId);

	recordAudit(store, {
		action: "identity.remove",
		account: account.username,
		actor,
		detail: `${identity.kind} ${identity.label}`,
	});

	await saveAccounts(store);
}

/** Enable or disable one identity, keeping it (and its trail) in place. */
export async function setIdentityDisabled(
	idOrName: string,
	identityId: string,
	disabled: boolean,
	actor?: string,
): Promise<void> {
	const store = await loadAccounts();
	const account = requireAccount(store, idOrName);
	const identity = account.identities.find((entry) => entry.id === identityId);

	if (!identity) {
		throw new Error(t("core.accounts.unknownIdentity", { id: identityId }));
	}

	identity.disabled = disabled || undefined;

	recordAudit(store, {
		action: "account.update",
		account: account.username,
		actor,
		detail: `${identity.kind} ${identity.label} ${disabled ? "disabled" : "enabled"}`,
	});

	await saveAccounts(store);
}

/**
 * Verify a username and password and open a session.
 *
 * Every refusal is recorded and every refusal reads the same to the caller: a
 * disabled account, a wrong password and a username that does not exist are one
 * message, because telling them apart is how an account list gets enumerated.
 */
export async function signIn(
	username: string,
	password: string,
	meta: ClientMeta = {},
): Promise<SignInResult> {
	const store = await loadAccounts();
	const account = findAccount(store, username);
	const now = Date.now();

	if (!account) {
		await burnVerification(password);

		recordAudit(store, {
			action: "signin.failed",
			account: username,
			ip: meta.ip,
			detail: t("core.accounts.noSuchAccount"),
		});
		await saveAccounts(store);

		throw new Error(t("core.accounts.signInRefused"));
	}

	if (isLocked(account, now)) {
		recordAudit(store, {
			action: "signin.locked",
			account: account.username,
			ip: meta.ip,
		});
		await saveAccounts(store);

		throw new Error(t("core.accounts.lockedOut"));
	}

	const identity = account.identities.find(
		(entry) => entry.kind === "password" && !entry.disabled,
	);
	const okay =
		account.enabled &&
		!!identity?.secretHash &&
		(await Bun.password.verify(password, identity.secretHash));

	if (!okay) {
		if (!identity?.secretHash) {
			await burnVerification(password);
		}

		account.failedAttempts = (account.failedAttempts ?? 0) + 1;

		if (account.failedAttempts >= MAX_SIGNIN_FAILURES) {
			account.lockedUntil = now + LOCKOUT_MS;
		}

		recordAudit(store, {
			action: "signin.failed",
			account: account.username,
			ip: meta.ip,
			detail: !account.enabled
				? t("core.accounts.accountDisabled")
				: !identity
					? t("core.accounts.noPassword")
					: t("core.accounts.wrongPassword"),
		});
		await saveAccounts(store);

		throw new Error(t("core.accounts.signInRefused"));
	}

	account.failedAttempts = 0;
	account.lockedUntil = undefined;
	account.lastSignInAt = now;
	identity.lastUsedAt = now;

	recordAudit(store, { action: "signin.ok", account: account.username, ip: meta.ip });

	await saveAccounts(store);

	const token = randomBytes(32).toString("base64url");
	const sessions = await loadSessions();

	sessions.sessions.push({
		id: newId("sess"),
		account: account.id,
		tokenHash: digest(token),
		createdAt: now,
		lastSeenAt: now,
		expiresAt: now + SESSION_TTL_MS,
		ip: meta.ip,
		agent: meta.agent,
	});

	await saveSessions(sessions);

	return {
		token,
		expiresAt: now + SESSION_TTL_MS,
		account: summarize(account, sessions.sessions),
	};
}

/** The account and session a bearer token resolves to, or null. */
export interface ResolvedSession {
	account: AccountSummary;
	session: SessionSummary;
}

/**
 * Resolve a session token; the check every console request runs.
 *
 * `lastSeenAt` is only persisted once it is `SESSION_TOUCH_MS` stale, so the
 * store is not rewritten (and the follower sync not woken) on every page load.
 */
export async function resolveSession(token: string): Promise<ResolvedSession | null> {
	if (!token) {
		return null;
	}

	const hash = digest(token);
	const sessions = await loadSessions();
	const session = sessions.sessions.find((entry) => sameDigest(entry.tokenHash, hash));

	if (!session) {
		return null;
	}

	const store = await loadAccounts();
	const account = store.accounts.find((entry) => entry.id === session.account);

	if (!account || !account.enabled) {
		return null;
	}

	const now = Date.now();

	if (now - session.lastSeenAt > SESSION_TOUCH_MS) {
		session.lastSeenAt = now;

		await saveSessions(sessions);
	}

	return {
		account: summarize(account, sessions.sessions),
		session: sessionSummary(session, account.username, true),
	};
}

/**
 * Resolve an access key presented as `<keyId>.<secret>`. Machine callers use
 * this instead of a session: there is no cookie, and no session is opened.
 */
export async function resolveAccessKey(bearer: string): Promise<AccountSummary | null> {
	const split = bearer.indexOf(".");

	if (split <= 0) {
		return null;
	}

	const keyId = bearer.slice(0, split);
	const hash = digest(bearer.slice(split + 1));
	const store = await loadAccounts();

	for (const account of store.accounts) {
		const identity = account.identities.find(
			(entry) => entry.kind === "accessKey" && entry.id === keyId && !entry.disabled,
		);

		if (!identity?.secretHash || !sameDigest(identity.secretHash, hash)) {
			continue;
		}

		if (!account.enabled) {
			return null;
		}

		identity.lastUsedAt = Date.now();

		await saveAccounts(store);

		return summarize(account);
	}

	return null;
}

function sessionSummary(
	session: ConsoleSession,
	username: string,
	current: boolean,
): SessionSummary {
	return {
		id: session.id,
		account: session.account,
		username,
		createdAt: session.createdAt,
		lastSeenAt: session.lastSeenAt,
		expiresAt: session.expiresAt,
		ip: session.ip ?? null,
		agent: session.agent ?? null,
		current,
	};
}

/**
 * Open sessions, newest first, optionally for one account. `currentToken` marks
 * the caller's own session, which is what a "revoke every other session" verb
 * needs to leave alone.
 */
export async function listSessions(
	opts: { account?: string; currentToken?: string } = {},
): Promise<SessionSummary[]> {
	const store = await loadAccounts();
	const { sessions } = await loadSessions();
	const names = new Map(store.accounts.map((account) => [account.id, account.username]));
	const currentHash = opts.currentToken ? digest(opts.currentToken) : undefined;

	let wanted = sessions;

	if (opts.account) {
		const account = findAccount(store, opts.account);

		wanted = account ? sessions.filter((session) => session.account === account.id) : [];
	}

	return wanted
		.map((session) =>
			sessionSummary(
				session,
				names.get(session.account) ?? session.account,
				!!currentHash && sameDigest(session.tokenHash, currentHash),
			),
		)
		.sort((left, right) => right.lastSeenAt - left.lastSeenAt);
}

/** Close one session by id. Returns false when no session goes by that id. */
export async function revokeSession(sessionId: string, actor?: string): Promise<boolean> {
	const sessions = await loadSessions();
	const session = sessions.sessions.find((entry) => entry.id === sessionId);

	if (!session) {
		return false;
	}

	sessions.sessions = sessions.sessions.filter((entry) => entry.id !== sessionId);

	await saveSessions(sessions);

	const store = await loadAccounts();
	const account = store.accounts.find((entry) => entry.id === session.account);

	recordAudit(store, {
		action: "session.revoke",
		account: account?.username,
		actor,
		ip: session.ip,
	});

	await saveAccounts(store);

	return true;
}

/** Close every session an account holds. Returns how many were closed. */
export async function revokeAccountSessions(
	idOrName: string,
	opts: { keepToken?: string; actor?: string } = {},
): Promise<number> {
	const store = await loadAccounts();
	const account = findAccount(store, idOrName);

	if (!account) {
		return 0;
	}

	const sessions = await loadSessions();
	const keepHash = opts.keepToken ? digest(opts.keepToken) : undefined;
	const before = sessions.sessions.length;

	sessions.sessions = sessions.sessions.filter(
		(session) =>
			session.account !== account.id ||
			(!!keepHash && sameDigest(session.tokenHash, keepHash)),
	);

	const closed = before - sessions.sessions.length;

	if (closed === 0) {
		return 0;
	}

	await saveSessions(sessions);

	recordAudit(store, {
		action: "session.revoke",
		account: account.username,
		actor: opts.actor,
		detail: t("core.accounts.sessionsClosed", { count: closed }),
	});

	await saveAccounts(store);

	return closed;
}

/** End the session a token belongs to. Returns false when it was already gone. */
export async function signOut(token: string): Promise<boolean> {
	if (!token) {
		return false;
	}

	const hash = digest(token);
	const sessions = await loadSessions();
	const session = sessions.sessions.find((entry) => sameDigest(entry.tokenHash, hash));

	if (!session) {
		return false;
	}

	sessions.sessions = sessions.sessions.filter((entry) => entry.id !== session.id);

	await saveSessions(sessions);

	const store = await loadAccounts();
	const account = store.accounts.find((entry) => entry.id === session.account);

	recordAudit(store, {
		action: "signout",
		account: account?.username,
		actor: account?.username,
		ip: session.ip,
	});

	await saveAccounts(store);

	return true;
}
