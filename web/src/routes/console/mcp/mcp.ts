// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Shapes and vocabulary shared by the MCP screens: a token's state, an audit
 * action's tone and a call's outcome are read on the list, on the detail screen
 * and in the menus, so each mapping lives here once.
 */

import { t } from '$lib/i18n.svelte';
import type { Series, SeriesStyle } from '$lib/components/chart';

import { isMcpRefusal, mcpTool, type McpToolGroup } from '$shared/mcptools';
import type { McpAuditEntry, McpCallRecord, McpTokenSummary } from '$core/mcp';

export type TokenRow = McpTokenSummary;

/** An audit entry with a row key; the trail has no ids of its own. */
export type McpAuditRow = McpAuditEntry & { key: string };

/** A call record with a row key; two calls can land in the same millisecond. */
export type CallRow = McpCallRecord & { key: string };

export function keyMcpAudit(entries: McpAuditEntry[]): McpAuditRow[] {
	return entries.map((entry, index) => ({ ...entry, key: `${entry.t}:${entry.action}:${index}` }));
}

/** Keys rows from `offset` on, so a page appended after them never rekeys the rows already shown. */
export function keyCalls(calls: McpCallRecord[], offset = 0): CallRow[] {
	return calls.map((call, index) => ({ ...call, key: `${call.t}:${call.token}:${offset + index}` }));
}

/** How a call ended: it ran, the token or the account it acts for turned it away, or it ran and went wrong. */
export type CallOutcome = 'ok' | 'refused' | 'failed';

export function callOutcome(call: McpCallRecord): CallOutcome {
	if (call.ok) {
		return 'ok';
	}

	return isMcpRefusal(call.error)
		? 'refused'
		: 'failed';
}

/** The outcome as a StatusBadge state and its words. */
export function callBadge(call: McpCallRecord): { state: string; label: string } {
	const outcome = callOutcome(call);

	if (outcome === 'ok') {
		return { state: 'ok', label: t('web.mcp.outcomeOk') };
	}

	return outcome === 'refused'
		? { state: 'warning', label: t('web.mcp.outcomeRefused') }
		: { state: 'failed', label: t('web.mcp.outcomeFailed') };
}

/** A shell on a server or on the host. */
export const CALL_SHELL_GROUPS: readonly McpToolGroup[] = ['shell', 'host-shell'];

/** The group a call's tool belongs to; null for a tool this build no longer has. */
export function callGroup(call: McpCallRecord): McpToolGroup | null {
	return mcpTool(call.tool)?.group ?? null;
}

/** Whether a call's tool changes something rather than only reading. */
export function callChangesState(call: McpCallRecord): boolean {
	return mcpTool(call.tool)?.annotations.destructiveHint === true;
}

/** The arguments as an object, or null when they were not recorded or were cut short. */
export function callArgs(call: McpCallRecord): Record<string, unknown> | null {
	if (!call.args) {
		return null;
	}

	try {
		const parsed: unknown = JSON.parse(call.args);

		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}

/** The instance a call named, read from its tool's instance argument. */
export function callInstance(call: McpCallRecord): string | null {
	const name = mcpTool(call.tool)?.instanceArg;

	if (!name) {
		return null;
	}

	const value = callArgs(call)?.[name];

	return typeof value === 'string' && value
		? value
		: null;
}

/** Where an instance a call named is shown; luna has no screen of its own for one. */
export function callInstanceHref(_name: string): string | null {
	return null;
}

/** The console account a call acted as; luna records none. */
export function callAccount(_call: McpCallRecord): string | undefined {
	return undefined;
}

/** Who a call was made for: what the client reported, else the console account it acted as. */
export function callCaller(call: McpCallRecord): string {
	return behalfLabel(call) || callAccount(call) || '';
}

/** The arguments laid out for reading; the recorded text when it is not whole JSON. */
export function prettyArgs(args: string): string {
	try {
		return JSON.stringify(JSON.parse(args), null, 2);
	} catch {
		return args;
	}
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Bar widths a call histogram picks from, the request histogram's own: whole minutes, hours or days. */
const CALL_STEPS = [MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS, 15 * MINUTE_MS, 30 * MINUTE_MS, HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS, DAY_MS];

const CALL_OUTCOMES: readonly CallOutcome[] = ['ok', 'refused', 'failed'];

/** The histogram's parts in the kit's status colours. */
export function callStyles(): Record<string, SeriesStyle> {
	return {
		ok: { label: t('web.mcp.outcomeOk'), color: 'var(--chart-good)' },
		refused: { label: t('web.mcp.outcomeRefused'), color: 'var(--chart-warning)' },
		failed: { label: t('web.mcp.outcomeFailed'), color: 'var(--chart-critical)' }
	};
}

/** The bar a moment falls in; bars of an hour and longer start from local midnight, so a day bar is a calendar day. */
function slotOf(at: number, step: number): number {
	if (step < HOUR_MS) {
		return Math.floor(at / step) * step;
	}

	const midnight = new Date(at).setHours(0, 0, 0, 0);

	return midnight + Math.floor((at - midnight) / step) * step;
}

/**
 * Calls counted per bar and split by outcome, for a `StackedBars`: the
 * narrowest bar that keeps the span to 300 of them, as the request histogram
 * draws, every bar present (0 where nothing was called).
 */
export function callSeries(calls: readonly CallRow[], from: number, to: number): Series[] {
	const span = Math.max(1, to - from);
	const step = CALL_STEPS.find((candidate) => span / candidate <= 300) ?? DAY_MS;
	const start = slotOf(from, step);
	const slots: number[] = [];

	for (let at = start; at < to; at = step >= DAY_MS ? slotOf(at + step + HOUR_MS, step) : slotOf(at + step, step)) {
		slots.push(at);
	}

	const counts = new Map<CallOutcome, Map<number, number>>(CALL_OUTCOMES.map((outcome) => [outcome, new Map()]));

	for (const call of calls) {
		if (call.t < start || call.t >= to) {
			continue;
		}

		const slot = slotOf(call.t, step);
		const part = counts.get(callOutcome(call))!;

		part.set(slot, (part.get(slot) ?? 0) + 1);
	}

	return CALL_OUTCOMES.map((outcome) => ({
		key: outcome,
		unit: 'count' as const,
		points: slots.map((at): [number, number | null] => [at, counts.get(outcome)!.get(at) ?? 0])
	}));
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
