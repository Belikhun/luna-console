// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Types and the row builder for `PermissionsPolicies.svelte`, the
 * "Permissions policies" panel an account and a group both show.
 */

import type { AccountPermissions, GroupSummary, InlineView, PolicySummary } from '$core/iam';
import type { PolicyKind } from '$lib/iam';
import type { AttachedDocument } from '$shared/iam/grammar';
import { policyToYaml } from '$shared/iam/yaml';

/** Whose policies the panel shows. */
export type PermissionsSubject =
	| { kind: 'account'; username: string; id: string }
	| { kind: 'group'; name: string };

/** One policy as the panel lists it. */
export interface PermissionRow {
	/** unique per row: the same policy can arrive directly and through a group */
	key: string;
	name: string;
	kind: PolicyKind;
	/** the group it arrives through, or null when it is attached directly */
	via: string | null;
	description: string;
	/** the document, when the panel has it */
	yaml: string | null;
	/** the inline document itself, for an inline policy held directly */
	inline: InlineView | null;
}

/**
 * A managed or built-in policy's row. The catalog is only readable with
 * `iam:ListPolicies`; without it, the account's own effective documents still
 * say which kind each policy is.
 */
function managedRow(name: string, via: string | null, catalog: PolicySummary[], effective: AttachedDocument[] = []): PermissionRow {
	const known = catalog.find((policy) => policy.name.toLowerCase() === name.toLowerCase());
	const source = effective.find((entry) => entry.source.kind !== 'inline' && entry.source.name.toLowerCase() === name.toLowerCase())?.source;
	const builtin = known
		? known.builtin
		: source?.kind === 'builtin';

	return {
		key: `${via ?? ''}:managed:${name}`,
		name,
		kind: builtin ? 'builtin' : 'managed',
		via,
		description: known?.description ?? '',
		yaml: known?.yaml ?? null,
		inline: null
	};
}

function inlineRow(inline: InlineView, via: string | null, direct: boolean): PermissionRow {
	return {
		key: `${via ?? ''}:inline:${inline.name}`,
		name: inline.name,
		kind: 'inline',
		via,
		description: '',
		yaml: inline.yaml,
		inline: direct ? inline : null
	};
}

/**
 * Every policy that reaches an account, as AWS's user screen lists them:
 * attached directly, written inline on it, and everything each of its groups
 * carries, with the group named as the way it arrives.
 */
export function accountPermissionRows(
	permissions: AccountPermissions,
	catalog: PolicySummary[],
	groups: GroupSummary[]
): PermissionRow[] {
	const rows: PermissionRow[] = [
		...permissions.policies.map((name) => managedRow(name, null, catalog, permissions.effective)),
		...permissions.inline.map((inline) => inlineRow(inline, null, true))
	];

	for (const membership of permissions.groups) {
		const group = groups.find((entry) => entry.name === membership.name);

		for (const name of membership.policies) {
			rows.push(managedRow(name, membership.name, catalog, permissions.effective));
		}

		for (const name of membership.inline) {
			const view = group?.inline.find((inline) => inline.name === name);
			const document = permissions.effective.find(
				(entry) => entry.source.kind === 'inline' && entry.source.group === membership.name && entry.source.name === name
			)?.document;

			rows.push(
				view
					? inlineRow(view, membership.name, false)
					: {
							key: `${membership.name}:inline:${name}`,
							name,
							kind: 'inline',
							via: membership.name,
							description: '',
							yaml: document
								? policyToYaml(document)
								: null,
							inline: null
						}
			);
		}
	}

	return rows;
}

/** A group's policies: the ones attached to it and the ones written on it. */
export function groupPermissionRows(group: GroupSummary, catalog: PolicySummary[]): PermissionRow[] {
	return [
		...group.policies.map((name) => managedRow(name, null, catalog)),
		...group.inline.map((inline) => inlineRow(inline, null, true))
	];
}
