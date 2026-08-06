// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/accounts.
 *
 * Every function here is an RPC: verifying a password, minting a session and
 * reading the store all happen inside the daemon, and only the masked summaries
 * come back. The raw store has no bridge on purpose; there is no client-side
 * function that could ever hold a password hash.
 */

import type * as core from "../../core/accounts";

import { call } from "../rpc";

export {
	LOCKOUT_MS,
	MAX_AUDIT,
	MAX_SIGNIN_FAILURES,
	MIN_PASSWORD_LENGTH,
	SESSION_TTL_MS,
	USERNAME_PATTERN,
} from "../../core/accounts";
// the pure rules the create forms validate against; a component imports them from
// $shared directly, since it cannot import this module at all
export { isPassword, isUsername } from "../../shared/accountrules";
export type {
	AccessKeyResult,
	AccountPatch,
	AccountSummary,
	AuditAction,
	AuditEntry,
	ClientMeta,
	CreateAccountInput,
	IdentityKind,
	IdentitySummary,
	ResolvedSession,
	SessionSummary,
	SignInResult,
} from "../../core/accounts";

export const listAccounts = call("accounts.list") as typeof core.listAccounts;
export const getAccount = call("accounts.get") as typeof core.getAccount;
export const createAccount = call("accounts.create") as typeof core.createAccount;
export const updateAccount = call("accounts.update") as typeof core.updateAccount;
export const deleteAccount = call("accounts.delete") as typeof core.deleteAccount;
export const setPassword = call("accounts.setPassword") as typeof core.setPassword;
export const addAccessKey = call("accounts.addAccessKey") as typeof core.addAccessKey;
export const addMinecraftIdentity = call("accounts.addMinecraft") as typeof core.addMinecraftIdentity;
export const removeIdentity = call("accounts.removeIdentity") as typeof core.removeIdentity;
export const setIdentityDisabled = call(
	"accounts.setIdentityDisabled",
) as typeof core.setIdentityDisabled;
export const auditTrail = call("accounts.audit") as typeof core.auditTrail;
export const bootstrapNeeded = call("accounts.bootstrapNeeded") as typeof core.bootstrapNeeded;
export const bootstrapAccount = call("accounts.bootstrap") as typeof core.bootstrapAccount;
export const signIn = call("accounts.signIn") as typeof core.signIn;
export const signOut = call("accounts.signOut") as typeof core.signOut;
export const resolveSession = call("accounts.resolveSession") as typeof core.resolveSession;
export const resolveAccessKey = call("accounts.resolveAccessKey") as typeof core.resolveAccessKey;
export const listSessions = call("accounts.listSessions") as typeof core.listSessions;
export const revokeSession = call("accounts.revokeSession") as typeof core.revokeSession;
export const revokeAccountSessions = call(
	"accounts.revokeAccountSessions",
) as typeof core.revokeAccountSessions;
