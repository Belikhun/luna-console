// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Shapes and vocabulary shared by the Permissions screens: a policy row, a
 * group row, the audit trail's row key, and the painters an action's label and
 * tone go through, so the list, the detail screens and the menus agree.
 */

import { t } from '$lib/i18n.svelte';

import type { GroupSummary, IamAuditEntry, PolicySummary } from '$core/iam';

export type PolicyRow = PolicySummary;
export type GroupRow = GroupSummary;

/** An audit entry with a row key; the trail has no ids of its own. */
export type IamAuditRow = IamAuditEntry & { key: string };

/**
 * `IAM_NAME_PATTERN` from core, repeated here because a component cannot
 * value-import `$core` (it reaches the daemon socket); keep the two identical.
 */
export const IAM_NAME = /^[A-Za-z0-9][A-Za-z0-9+=,.@_-]{0,127}$/;

/** Key an audit trail for table use, in the order the daemon returned it. */
export function keyIamAudit(entries: IamAuditEntry[]): IamAuditRow[] {
	return entries.map((entry, index) => ({ ...entry, key: `${entry.t}:${entry.action}:${index}` }));
}

/** The label of an audit action; `policy.create` reads `web.iam.audit.policy_create`. */
export function iamAuditLabel(action: string): string {
	return t(`web.iam.audit.${action.replace(/\./g, '_')}`);
}

/** A StatusBadge state for an audit action; removals amber, additions green. */
export function iamAuditTone(action: string): string {
	if (action.endsWith('.delete') || action === 'detach' || action === 'group.members.remove') {
		return 'warning';
	}

	if (action.endsWith('.create') || action === 'attach' || action === 'group.members.add' || action === 'seed') {
		return 'ok';
	}

	return 'info';
}

export function policyHref(name: string): string {
	return `/console/iam/policies/${encodeURIComponent(name)}`;
}

export function groupHref(name: string): string {
	return `/console/iam/groups/${encodeURIComponent(name)}`;
}

/** The accounts screen is keyed by id; a username reaches it as a search. */
export function accountSearchHref(username: string): string {
	return `/console/accounts?q=${encodeURIComponent(username)}`;
}

/** How many principals a policy is attached to, accounts and groups together. */
export function attachedCount(policy: PolicyRow): number {
	return policy.attachedTo.accounts.length + policy.attachedTo.groups.length;
}

/** Why a policy cannot be deleted right now, or an empty string when it can. */
export function policyDeleteReason(policy: PolicyRow): string {
	if (policy.builtin) {
		return t('web.iam.builtinNoDelete');
	}

	const count = attachedCount(policy);

	if (count > 0) {
		return t('web.iam.attachedNoDelete', { count });
	}

	return '';
}

/** The kind a policy is shown as: built-in or managed. */
export function policyKindLabel(policy: PolicyRow): string {
	return policy.builtin
		? t('web.iam.builtin')
		: t('web.iam.managed');
}
