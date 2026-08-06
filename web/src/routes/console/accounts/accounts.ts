// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Shapes and vocabulary shared by the Accounts screens.
 *
 * The row types mirror the masked summaries `core/accounts` returns, and the two
 * painters below are the reason this module exists: an account's state and an
 * audit action are read on the list, on the detail screen and in the account menu,
 * and three copies of the same mapping is how they end up disagreeing.
 */

import { t } from '$lib/i18n.svelte';

import type { AccountSummary, AuditEntry, IdentitySummary, SessionSummary } from '$core/accounts';

export type AccountRow = AccountSummary;
export type SessionRow = SessionSummary;
export type IdentityRow = IdentitySummary;

/**
 * An audit entry with a row key. The trail is append-only and has no id of its
 * own; two entries can share a timestamp, an action and a subject (a bulk disable
 * writes several in the same millisecond), so the position in the returned trail
 * is what makes a row addressable.
 */
export type AuditRow = AuditEntry & { key: string };

/** Key an audit trail for table use, in the order the daemon returned it. */
export function keyAudit(entries: AuditEntry[]): AuditRow[] {
	return entries.map((entry, index) => ({ ...entry, key: `${entry.t}:${entry.action}:${index}` }));
}

/**
 * The one word an account's state reduces to, as a StatusBadge state.
 *
 * The order is the order the facts matter in: disabled beats locked, because a
 * disabled account's lockout is irrelevant; and "no password" outranks "must
 * change", because an account with no password has nothing to change.
 */
export function accountState(account: AccountRow): string {
	if (!account.enabled) {
		return 'stopped';
	}

	if (account.lockedUntil) {
		return 'failed';
	}

	if (!account.hasPassword || account.mustChangePassword) {
		return 'warning';
	}

	return 'ok';
}

/** The label beside that state; same precedence. */
export function stateLabel(account: AccountRow): string {
	if (!account.enabled) {
		return t('web.accounts.disabled');
	}

	if (account.lockedUntil) {
		return t('web.accounts.locked');
	}

	if (!account.hasPassword) {
		return t('web.accounts.noPassword');
	}

	if (account.mustChangePassword) {
		return t('web.accounts.mustChange');
	}

	return t('web.accounts.active');
}

/** A StatusBadge state for one audit action; refusals red, sign-ins green. */
export function auditTone(action: string): string {
	if (action === 'signin.failed' || action === 'signin.locked') {
		return 'failed';
	}

	if (action === 'signin.ok') {
		return 'ok';
	}

	if (action === 'account.delete' || action === 'account.disable' || action === 'identity.remove') {
		return 'warning';
	}

	return 'info';
}

/** The identity vocabulary: one icon and one label per kind, everywhere. */
export function identityIcon(kind: IdentityRow['kind']): string {
	if (kind === 'password') {
		return 'key';
	}

	if (kind === 'accessKey') {
		return 'terminal';
	}

	return 'cube';
}

/** Human name of an identity kind. */
export function identityLabel(kind: IdentityRow['kind']): string {
	if (kind === 'password') {
		return t('web.accounts.kindPassword');
	}

	if (kind === 'accessKey') {
		return t('web.accounts.kindAccessKey');
	}

	return t('web.accounts.kindMinecraft');
}
