// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Shapes and vocabulary shared by the access management screens and the
 * components they are built from: a policy row, a group row, the audit trail's
 * row key, where each object lives, and the words a policy's type, use and
 * audit action are shown in, so every list, detail screen and menu agrees.
 */

import { t } from '$lib/i18n.svelte';
import { Notify } from '$lib/notifications.svelte';

import type { GroupSummary, IamAuditEntry, PolicySummary } from '$core/iam';

export type PolicyRow = PolicySummary;
export type GroupRow = GroupSummary;

/** An audit entry with a row key; the trail has no ids of its own. */
export type IamAuditRow = IamAuditEntry & { key: string };

/** How a policy is held: one of luna's own, one an operator wrote, or a document on one principal. */
export type PolicyKind = 'builtin' | 'managed' | 'inline';

/**
 * `IAM_NAME_PATTERN` from core, repeated here because a component cannot
 * value-import `$core` (it reaches the daemon socket); keep the two identical.
 */
export const IAM_NAME = /^[A-Za-z0-9][A-Za-z0-9+=,.@_-]{0,127}$/;

/** The icon a policy kind wears beside its name; the cube is AWS's managed-policy mark. */
export const POLICY_KIND_ICONS: Record<PolicyKind, string> = {
	builtin: 'cube',
	managed: 'fileCode',
	inline: 'fileLines'
};

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

/** A policy's screen. */
export function policyHref(name: string): string {
	return `/console/iam/policies/${encodeURIComponent(name)}`;
}

/** A group's screen. */
export function groupHref(name: string): string {
	return `/console/iam/groups/${encodeURIComponent(name)}`;
}

/** The accounts screen is keyed by id; a username alone reaches it as a search. */
export function accountSearchHref(username: string): string {
	return `/console/accounts?q=${encodeURIComponent(username)}`;
}

/** An account's screen when its id is known, else the search for its name. */
export function accountHref(username: string, id?: string | null): string {
	return id
		? `/console/accounts/${encodeURIComponent(id)}`
		: accountSearchHref(username);
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

/** The kind a policy is held as. */
export function policyKind(policy: PolicyRow): PolicyKind {
	return policy.builtin
		? 'builtin'
		: 'managed';
}

/** The words for a policy kind, AWS's: "Built-in", "Customer managed", "Inline". */
export function policyKindLabel(kind: PolicyKind): string {
	if (kind === 'builtin') {
		return t('web.iamList.typeBuiltin');
	}

	if (kind === 'inline') {
		return t('web.iamList.typeInline');
	}

	return t('web.iamList.typeManaged');
}

/** "Permissions policy (3)" or "None": what the policy list's "Used as" column says. */
export function usedAsLabel(policy: PolicyRow): string {
	const count = attachedCount(policy);

	return count > 0
		? t('web.iamList.usedAsPermissions', { count })
		: t('web.iamList.usedAsNone');
}

/** The resource id of a policy, group or account, as the resource store keys it. */
export function iamResourceId(type: 'policy' | 'group' | 'account', name: string): string {
	return `luna:${type}/${name}`;
}

/**
 * Run one verb over several targets and report the outcome once: every target
 * is tried, the failures are collected with their reasons, and the caller gets
 * the tally to word as it likes.
 */
export async function runEach<T>(
	targets: T[],
	run: (target: T) => Promise<unknown>,
	label: (target: T) => string
): Promise<{ done: number; failed: string[] }> {
	const failed: string[] = [];

	for (const target of targets) {
		try {
			await run(target);
		} catch (err) {
			failed.push(`${label(target)}: ${(err as Error).message}`);
		}
	}

	return { done: targets.length - failed.length, failed };
}

/**
 * Report what `runEach` did as one notification: the success line when nothing
 * failed, the failure line when nothing worked, and a tally with the reasons in
 * between.
 */
export function notifyEach(outcome: { done: number; failed: string[] }, success: string, failure: string): void {
	if (outcome.failed.length === 0) {
		Notify.success(success);

		return;
	}

	if (outcome.done === 0) {
		Notify.error(failure, { detail: outcome.failed.join('\n') });

		return;
	}

	Notify.warning(t('web.iamList.partial', { done: outcome.done, failed: outcome.failed.length }), {
		detail: outcome.failed.join('\n')
	});
}
