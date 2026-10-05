// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Shapes and vocabulary shared by the MCP screens: a token's state, an audit
 * action's tone and a call's outcome are read on the list, on the detail screen
 * and in the menus, so each mapping lives here once.
 */

import { t } from '$lib/i18n.svelte';

import type { McpAuditEntry, McpCallRecord, McpTokenSummary } from '$core/mcp';

export type TokenRow = McpTokenSummary;

/** An audit entry with a row key; the trail has no ids of its own. */
export type McpAuditRow = McpAuditEntry & { key: string };

/** A call record with a row key; two calls can land in the same millisecond. */
export type CallRow = McpCallRecord & { key: string };

export function keyMcpAudit(entries: McpAuditEntry[]): McpAuditRow[] {
	return entries.map((entry, index) => ({ ...entry, key: `${entry.t}:${entry.action}:${index}` }));
}

export function keyCalls(calls: McpCallRecord[]): CallRow[] {
	return calls.map((call, index) => ({ ...call, key: `${call.t}:${call.token}:${index}` }));
}

/** A token's state as a StatusBadge state; disabled outranks expired. */
export function tokenState(token: TokenRow): string {
	if (!token.enabled) {
		return 'stopped';
	}

	if (token.expired) {
		return 'failed';
	}

	return 'ok';
}

export function tokenStateLabel(token: TokenRow): string {
	if (!token.enabled) {
		return t('web.mcp.disabled');
	}

	if (token.expired) {
		return t('web.mcp.expired');
	}

	return t('web.mcp.active');
}

/** A StatusBadge state for an audit action. */
export function mcpAuditTone(action: string): string {
	if (action === 'token.remove' || action === 'token.disable' || action === 'knowledge.remove') {
		return 'warning';
	}

	if (action === 'token.rotate') {
		return 'info';
	}

	if (action === 'token.create' || action === 'token.enable') {
		return 'ok';
	}

	return 'info';
}

/** Who a call was made for, as one line; the client's own claim, shown as such. */
export function behalfLabel(call: McpCallRecord): string {
	const behalf = call.onBehalfOf;

	if (!behalf) {
		return '';
	}

	if (typeof behalf.label === 'string' && behalf.label) {
		return behalf.label;
	}

	return Object.entries(behalf)
		.map(([key, value]) => `${key}=${String(value)}`)
		.join(' ');
}

/** The scope's groups as one readable line. */
export function scopeSummary(token: TokenRow): string {
	const groups = token.scope.groups.map((group) => t(`web.mcp.group.${group}`));
	const extras: string[] = [];

	if (token.scope.allow.length > 0) {
		extras.push(`+${token.scope.allow.length}`);
	}

	if (token.scope.deny.length > 0) {
		extras.push(`−${token.scope.deny.length}`);
	}

	const base = groups.length > 0
		? groups.join(', ')
		: t('web.mcp.noGroups');

	return extras.length > 0
		? `${base} (${extras.join(' ')})`
		: base;
}

/** The client config snippet shown beside a fresh bearer. */
export function clientSnippet(origin: string, bearer: string): string {
	const config = {
		mcpServers: {
			luna: {
				type: 'http',
				url: `${origin}/api/mcp`,
				headers: { Authorization: `Bearer ${bearer}` }
			}
		}
	};

	return JSON.stringify(config, null, 2);
}
