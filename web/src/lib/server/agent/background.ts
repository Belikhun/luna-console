// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Mèo Béo's background work and triggers.
 *
 * A **background task** is one luna tool call handed off so the agent can keep
 * working; a **trigger** waits for something to happen (a timer, an instance
 * reaching a state, a player's chat line, a join or leave, a line in a log, a
 * cluster event). Either one reports back into the conversation that set it up,
 * as an event the runner delivers: into the run that is going, or as the start
 * of a new run when the conversation is idle (`setNoticeDeliverer`).
 *
 * A task calls the tool through the console's own `/api/mcp` with a bearer of
 * its own, exactly as the agent's subprocess does, so the token's scope and the
 * call log apply unchanged; and it may only run a tool the conversation's mode
 * would run unasked (`runsUnasked`), since nobody approves a background call.
 *
 * Everything lives in this process's memory: a console restart drops pending
 * tasks and armed triggers, which `task_list`/`trigger_list` say. The watcher
 * polls every few seconds and fetches each source once per round, however many
 * triggers read it.
 */

import { agentLaunch } from '$core/agent';
import { loadCluster } from '$core/config';
import { readInstanceLogs } from '$core/logs';
import * as luna from '$core/services/luna';
import { getEvents, listStatuses } from '$lib/server/luna';
import { mcpTool } from '$shared/mcptools';
import type { AgentMode } from '$shared/agent';
import { runsUnasked } from './approval';
import { issueRunBearer } from './bearer';

/** Where a notice goes, captured when the task or trigger was set up. */
export interface DeliveryContext {
	conversationId: string;
	owner: string;
	origin: string;
	machine: string;
	locale: string;
	mode: AgentMode;
}

export interface AgentNotice {
	ctx: DeliveryContext;
	source: 'task' | 'trigger';
	label: string;
	text: string;
}

type Deliverer = (notice: AgentNotice) => Promise<void>;

let deliverer: Deliverer | undefined;

/** Installed by the runner, which alone knows how to reach a conversation. */
export function setNoticeDeliverer(fn: Deliverer): void {
	deliverer = fn;
}

async function deliver(notice: AgentNotice): Promise<void> {
	try {
		await deliverer?.(notice);
	} catch (err) {
		console.error('[agent] could not deliver a notice:', err);
	}
}

/** Background tasks running at once in one conversation. */
export const MAX_TASKS_PER_CONVERSATION = 5;

/** Armed triggers in one conversation. */
export const MAX_TRIGGERS_PER_CONVERSATION = 10;

/** Longest a trigger stays armed, and the default. */
export const MAX_TRIGGER_MINUTES = 24 * 60;
const DEFAULT_TRIGGER_MINUTES = 60;

/** Most times one trigger may fire. */
export const MAX_TRIGGER_FIRES = 50;

/** A repeating trigger reports at most this often; matches in between are collected. */
const REFIRE_COOLDOWN_MS = 30_000;

/** How often the watcher looks. */
const POLL_MS = 5_000;

/** Longest a background call may take before it is given up on. */
const TASK_TIMEOUT_MS = 30 * 60 * 1000;

/** How much of a task's result travels back to the model. */
const RESULT_CHARS = 6_000;

/** Finished tasks stay listed this long. */
const TASK_LINGER_MS = 60 * 60 * 1000;

const LOG_WINDOW = 300;

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function clip(text: string, max: number): string {
	return text.length <= max
		? text
		: `${text.slice(0, max)}\n… [${text.length - max} more characters]`;
}

function seconds(ms: number): string {
	return ms < 90_000
		? `${Math.round(ms / 1000)}s`
		: `${Math.round(ms / 60_000)} min`;
}

//* ===========================================================
//*  Background tasks
//* ===========================================================

export interface TaskView {
	id: string;
	label: string;
	tool: string;
	state: 'running' | 'ok' | 'error' | 'cancelled';
	startedAt: number;
	finishedAt?: number;
}

interface Task extends TaskView {
	ctx: DeliveryContext;
	abort: AbortController;
}

const tasks = new Map<string, Task>();

/** Call a luna tool through `/api/mcp` as the agent's token, the way the subprocess does. */
async function callTool(ctx: DeliveryContext, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: boolean; text: string }> {
	const launch = await agentLaunch(ctx.owner);
	const grant = issueRunBearer(launch.token.id, {
		label: ctx.owner,
		account: ctx.owner,
		conversation: ctx.conversationId,
		via: 'meo-beo-task'
	});

	try {
		const response = await fetch(`${ctx.origin}/api/mcp`, {
			method: 'POST',
			headers: {
				'authorization': `Bearer ${grant.bearer}`,
				'content-type': 'application/json',
				'accept': 'application/json'
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
			signal: AbortSignal.any([signal, AbortSignal.timeout(TASK_TIMEOUT_MS)])
		});

		const reply = await response.json().catch(() => null) as { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } } | null;

		if (!reply || reply.error) {
			return { ok: false, text: reply?.error?.message ?? `the console answered HTTP ${response.status}` };
		}

		const text = (reply.result?.content ?? []).map((part) => part.text ?? '').join('\n');

		return { ok: reply.result?.isError !== true, text };
	} finally {
		grant.revoke();
	}
}

/**
 * Hand one luna tool call to the background. Resolves at once with the task;
 * its outcome arrives in the conversation later. Refused when the mode would
 * have asked the operator for the same call, since nobody approves it here.
 */
export function startTask(ctx: DeliveryContext, tool: string, args: Record<string, unknown>, label: string): TaskView {
	if (!mcpTool(tool)) {
		throw new Error(`there is no luna tool named "${tool}"`);
	}

	if (!runsUnasked(tool, ctx.mode)) {
		throw new Error(`${tool} needs the operator's approval in ${ctx.mode} mode, so it cannot run in the background; call it directly instead`);
	}

	const running = [...tasks.values()].filter((task) => task.ctx.conversationId === ctx.conversationId && task.state === 'running');

	if (running.length >= MAX_TASKS_PER_CONVERSATION) {
		throw new Error(`${running.length} background tasks are already running here; wait for one to finish`);
	}

	const task: Task = {
		id: newId('task'),
		label: label || tool,
		tool,
		state: 'running',
		startedAt: Date.now(),
		ctx,
		abort: new AbortController()
	};

	tasks.set(task.id, task);

	void (async () => {
		let outcome: { ok: boolean; text: string };

		try {
			outcome = await callTool(ctx, tool, args, task.abort.signal);
		} catch (err) {
			outcome = { ok: false, text: (err as Error).message };
		}

		if (task.state === 'cancelled') {
			return;
		}

		task.state = outcome.ok ? 'ok' : 'error';
		task.finishedAt = Date.now();

		await deliver({
			ctx,
			source: 'task',
			label: task.label,
			text: `Background task ${task.id} ("${task.label}", ${tool}) ${outcome.ok ? 'finished' : 'failed'} after ${seconds(task.finishedAt - task.startedAt)}.\n\n${clip(outcome.text || '(no output)', RESULT_CHARS)}`
		});
	})();

	return view(task);
}

function view(task: Task): TaskView {
	const { id, label, tool, state, startedAt, finishedAt } = task;

	return { id, label, tool, state, startedAt, ...(finishedAt ? { finishedAt } : {}) };
}

function prune(): void {
	const now = Date.now();

	for (const [id, task] of tasks) {
		if (task.finishedAt && now - task.finishedAt > TASK_LINGER_MS) {
			tasks.delete(id);
		}
	}
}

/** This conversation's tasks, running first. */
export function listTasks(conversationId: string): TaskView[] {
	prune();

	return [...tasks.values()]
		.filter((task) => task.ctx.conversationId === conversationId)
		.sort((left, right) => Number(right.state === 'running') - Number(left.state === 'running') || right.startedAt - left.startedAt)
		.map(view);
}

/**
 * Stop waiting for a task: its result will not be reported. The tool call
 * itself may still finish on the cluster; a running job is not undone.
 */
export function cancelTask(conversationId: string, id: string): boolean {
	const task = tasks.get(id);

	if (!task || task.ctx.conversationId !== conversationId || task.state !== 'running') {
		return false;
	}

	task.state = 'cancelled';
	task.finishedAt = Date.now();
	task.abort.abort();

	return true;
}

//* ===========================================================
//*  Triggers
//* ===========================================================

export type TriggerSpec =
	| { kind: 'timer'; afterSeconds: number }
	| { kind: 'instance_state'; instance: string; state: string }
	| { kind: 'player_chat'; player?: string; contains?: string; server?: string }
	| { kind: 'player_join'; player?: string; server?: string }
	| { kind: 'player_leave'; player?: string; server?: string }
	| { kind: 'log_match'; instance: string; contains: string }
	| { kind: 'cluster_event'; instance?: string; contains?: string; eventKind?: 'state' | 'action' | 'error' };

export const TRIGGER_KINDS = ['timer', 'instance_state', 'player_chat', 'player_join', 'player_leave', 'log_match', 'cluster_event'] as const;

export const INSTANCE_STATES = ['running', 'stopped', 'starting', 'stopping', 'paused', 'crashed', 'any'] as const;

export interface TriggerView {
	id: string;
	label: string;
	kind: TriggerSpec['kind'];
	spec: TriggerSpec;
	note: string;
	createdAt: number;
	expiresAt: number;
	fired: number;
	maxFires: number;
}

interface Trigger extends TriggerView {
	ctx: DeliveryContext;
	lastFiredAt: number;
	/** What happened since the last report, waiting out the cooldown */
	pending: string[];
	/** Source position: the newest chat id, event time, log line or state seen */
	cursor: {
		chatId?: number;
		eventAt?: number;
		logLine?: string;
		state?: string;
		players?: Map<string, string>;
		checked?: boolean;
	};
}

const triggers = new Map<string, Trigger>();
let timer: ReturnType<typeof setInterval> | undefined;

function lower(value: string | undefined): string {
	return (value ?? '').trim().toLowerCase();
}

/** Check a spec before it is armed, naming what is wrong in words the model can act on. */
function validate(spec: TriggerSpec): void {
	switch (spec.kind) {
		case 'timer':
			if (!Number.isFinite(spec.afterSeconds) || spec.afterSeconds < 10 || spec.afterSeconds > MAX_TRIGGER_MINUTES * 60) {
				throw new Error(`afterSeconds must be between 10 and ${MAX_TRIGGER_MINUTES * 60}`);
			}

			return;

		case 'instance_state':
			if (!spec.instance) {
				throw new Error('instance_state needs an instance');
			}

			if (!(INSTANCE_STATES as readonly string[]).includes(spec.state)) {
				throw new Error(`state is one of ${INSTANCE_STATES.join(', ')}`);
			}

			return;

		case 'log_match':
			if (!spec.instance || !spec.contains?.trim()) {
				throw new Error('log_match needs an instance and the text to look for (contains)');
			}

			return;

		default:
			return;
	}
}

/** Where each source stands right now, so a trigger only reports what happens after it is armed. */
async function baseline(trigger: Trigger): Promise<void> {
	const spec = trigger.spec;

	if (spec.kind === 'player_chat') {
		const page = await luna.serverChat({ limit: 1, type: 'chat' });

		trigger.cursor.chatId = page.ok && page.data ? (page.data.entries[0]?.id ?? 0) : 0;
	} else if (spec.kind === 'cluster_event') {
		trigger.cursor.eventAt = Date.now();
	} else if (spec.kind === 'player_join' || spec.kind === 'player_leave') {
		const list = await luna.players();

		trigger.cursor.players = new Map((list.ok && list.data ? list.data.players : []).map((player) => [player.uuid, `${player.username}|${player.server}`]));
	} else if (spec.kind === 'log_match') {
		const cfg = await loadCluster();
		const logs = await readInstanceLogs(cfg, spec.instance, LOG_WINDOW).catch(() => null);
		const lines = (logs?.content ?? '').split('\n').filter(Boolean);

		trigger.cursor.logLine = lines.at(-1) ?? '';
	}
}

/**
 * Arm a trigger. It reports into the conversation each time it fires (up to
 * `maxFires`), and once more if it expires first, so a wait never goes silent.
 */
export async function createTrigger(
	ctx: DeliveryContext,
	spec: TriggerSpec,
	opts: { label?: string; note?: string; maxFires?: number; expiresInMinutes?: number }
): Promise<TriggerView> {
	validate(spec);

	const armed = [...triggers.values()].filter((trigger) => trigger.ctx.conversationId === ctx.conversationId);

	if (armed.length >= MAX_TRIGGERS_PER_CONVERSATION) {
		throw new Error(`${armed.length} triggers are already armed here; cancel one first`);
	}

	const now = Date.now();
	const minutes = Math.min(MAX_TRIGGER_MINUTES, Math.max(1, Math.round(opts.expiresInMinutes ?? DEFAULT_TRIGGER_MINUTES)));
	const timerEnd = spec.kind === 'timer'
		? now + spec.afterSeconds * 1000 + 60_000
		: 0;

	const trigger: Trigger = {
		id: newId('trg'),
		label: opts.label?.trim() || spec.kind,
		kind: spec.kind,
		spec,
		note: opts.note?.trim() ?? '',
		createdAt: now,
		expiresAt: Math.max(now + minutes * 60_000, timerEnd),
		fired: 0,
		maxFires: Math.min(MAX_TRIGGER_FIRES, Math.max(1, Math.round(opts.maxFires ?? 1))),
		ctx,
		lastFiredAt: 0,
		pending: [],
		cursor: {}
	};

	await baseline(trigger);
	triggers.set(trigger.id, trigger);
	ensureWatcher();

	return triggerView(trigger);
}

function triggerView(trigger: Trigger): TriggerView {
	const { id, label, kind, spec, note, createdAt, expiresAt, fired, maxFires } = trigger;

	return { id, label, kind, spec, note, createdAt, expiresAt, fired, maxFires };
}

/** This conversation's armed triggers. */
export function listTriggers(conversationId: string): TriggerView[] {
	return [...triggers.values()]
		.filter((trigger) => trigger.ctx.conversationId === conversationId)
		.map(triggerView);
}

/** Disarm a trigger; nothing more is reported from it. */
export function cancelTrigger(conversationId: string, id: string): boolean {
	const trigger = triggers.get(id);

	if (!trigger || trigger.ctx.conversationId !== conversationId) {
		return false;
	}

	triggers.delete(id);

	return true;
}

/** Disarm everything a conversation set up, when the conversation goes away. */
export function forgetConversation(conversationId: string): void {
	for (const [id, trigger] of triggers) {
		if (trigger.ctx.conversationId === conversationId) {
			triggers.delete(id);
		}
	}

	for (const task of tasks.values()) {
		if (task.ctx.conversationId === conversationId && task.state === 'running') {
			task.state = 'cancelled';
			task.abort.abort();
		}
	}
}

function ensureWatcher(): void {
	if (timer || triggers.size === 0) {
		return;
	}

	timer = setInterval(() => {
		void round().catch((err) => console.error('[agent] trigger round failed:', err));
	}, POLL_MS);
}

/** One read of every source some trigger needs, shared by all of them. */
interface Sources {
	states?: Map<string, string>;
	chat?: luna.ServerChatEntry[];
	players?: luna.LunaPlayer[];
	events?: Array<{ t: number; instance: string; kind: string; message: string }>;
	logs: Map<string, string[]>;
}

async function readSources(armed: Trigger[]): Promise<Sources> {
	const kinds = new Set(armed.map((trigger) => trigger.kind));
	const sources: Sources = { logs: new Map() };

	if (kinds.has('instance_state')) {
		const data = await listStatuses().catch(() => null);

		if (data) {
			sources.states = new Map(data.instances.map((row) => {
				const state = row.paused === true
					? 'paused'
					: String(row.state ?? 'unknown');

				return [String(row.name), state];
			}));
		}
	}

	if (kinds.has('player_chat')) {
		const page = await luna.serverChat({ limit: 50, type: 'chat' }).catch(() => null);

		if (page?.ok && page.data) {
			sources.chat = page.data.entries;
		}
	}

	if (kinds.has('player_join') || kinds.has('player_leave')) {
		const list = await luna.players().catch(() => null);

		if (list?.ok && list.data) {
			sources.players = list.data.players;
		}
	}

	if (kinds.has('cluster_event')) {
		sources.events = await getEvents().catch(() => []);
	}

	const logInstances = new Set(armed.flatMap((trigger) => trigger.spec.kind === 'log_match' ? [trigger.spec.instance] : []));

	if (logInstances.size > 0) {
		const cfg = await loadCluster();

		for (const instance of logInstances) {
			const logs = await readInstanceLogs(cfg, instance, LOG_WINDOW).catch(() => null);

			if (logs) {
				sources.logs.set(instance, logs.content.split('\n').filter(Boolean));
			}
		}
	}

	return sources;
}

/** What a trigger saw happen this round, as lines for the report; empty when nothing matched. */
function observe(trigger: Trigger, sources: Sources, now: number): string[] {
	const spec = trigger.spec;
	const cursor = trigger.cursor;

	switch (spec.kind) {
		case 'timer':
			return now >= trigger.createdAt + spec.afterSeconds * 1000 && trigger.fired === 0 && trigger.pending.length === 0
				? [`${spec.afterSeconds}s have passed.`]
				: [];

		case 'instance_state': {
			const state = sources.states?.get(spec.instance);

			if (state === undefined) {
				return [];
			}

			const previous = cursor.state;
			const first = !cursor.checked;

			cursor.state = state;
			cursor.checked = true;

			const matches = spec.state === 'any'
				? !first && previous !== state
				: state === spec.state && (first || previous !== state);

			return matches
				? [`${spec.instance} is ${state}${previous && previous !== state ? ` (was ${previous})` : ''}.`]
				: [];
		}

		case 'player_chat': {
			if (!sources.chat) {
				return [];
			}

			const fresh = sources.chat.filter((entry) => entry.id > (cursor.chatId ?? 0)).sort((left, right) => left.id - right.id);

			if (fresh.length > 0) {
				cursor.chatId = fresh.at(-1)!.id;
			}

			return fresh
				.filter((entry) => !spec.player || lower(entry.username) === lower(spec.player))
				.filter((entry) => !spec.server || lower(entry.server) === lower(spec.server))
				.filter((entry) => !spec.contains || lower(entry.content).includes(lower(spec.contains)))
				.map((entry) => `[${new Date(entry.atEpochMillis).toISOString()}] ${entry.username} on ${entry.server}: ${entry.content}`);
		}

		case 'player_join':
		case 'player_leave': {
			if (!sources.players) {
				return [];
			}

			const before = cursor.players ?? new Map<string, string>();
			const now = new Map(sources.players.map((player) => [player.uuid, `${player.username}|${player.server}`]));
			const lines: string[] = [];

			cursor.players = now;

			const changed = spec.kind === 'player_join'
				? [...now].filter(([uuid]) => !before.has(uuid))
				: [...before].filter(([uuid]) => !now.has(uuid));

			for (const [, who] of changed) {
				const [name = '', server = ''] = who.split('|');

				if (spec.player && lower(name) !== lower(spec.player)) {
					continue;
				}

				if (spec.server && lower(server) !== lower(spec.server)) {
					continue;
				}

				lines.push(spec.kind === 'player_join'
					? `${name} joined (on ${server}).`
					: `${name} left (was on ${server}).`);
			}

			return lines;
		}

		case 'log_match': {
			const lines = sources.logs.get(spec.instance);

			if (!lines) {
				return [];
			}

			const marker = cursor.logLine ?? '';
			const at = marker ? lines.lastIndexOf(marker) : -1;
			const fresh = at >= 0
				? lines.slice(at + 1)
				: lines;

			cursor.logLine = lines.at(-1) ?? marker;

			return fresh
				.filter((line) => lower(line).includes(lower(spec.contains)))
				.slice(-10)
				.map((line) => `${spec.instance}: ${line}`);
		}

		case 'cluster_event': {
			if (!sources.events) {
				return [];
			}

			const fresh = sources.events.filter((event) => event.t > (cursor.eventAt ?? 0));

			if (fresh.length > 0) {
				cursor.eventAt = Math.max(...fresh.map((event) => event.t));
			}

			return fresh
				.filter((event) => !spec.instance || lower(event.instance) === lower(spec.instance))
				.filter((event) => !spec.eventKind || event.kind === spec.eventKind)
				.filter((event) => !spec.contains || lower(event.message).includes(lower(spec.contains)))
				.map((event) => `[${new Date(event.t).toISOString()}] ${event.instance} ${event.kind}: ${event.message}`);
		}
	}
}

function describe(spec: TriggerSpec): string {
	switch (spec.kind) {
		case 'timer':
			return `a ${spec.afterSeconds}s timer`;

		case 'instance_state':
			return `${spec.instance} becoming ${spec.state}`;

		case 'player_chat':
			return `chat${spec.player ? ` from ${spec.player}` : ''}${spec.server ? ` on ${spec.server}` : ''}${spec.contains ? ` containing "${spec.contains}"` : ''}`;

		case 'player_join':
		case 'player_leave':
			return `${spec.player ?? 'a player'} ${spec.kind === 'player_join' ? 'joining' : 'leaving'}${spec.server ? ` ${spec.server}` : ''}`;

		case 'log_match':
			return `"${spec.contains}" in ${spec.instance}'s log`;

		case 'cluster_event':
			return `a cluster event${spec.instance ? ` on ${spec.instance}` : ''}${spec.contains ? ` containing "${spec.contains}"` : ''}`;
	}
}

async function round(): Promise<void> {
	const armed = [...triggers.values()];

	if (armed.length === 0) {
		clearInterval(timer);
		timer = undefined;

		return;
	}

	const sources = await readSources(armed);
	const now = Date.now();

	for (const trigger of armed) {
		if (!triggers.has(trigger.id)) {
			continue;
		}

		trigger.pending.push(...observe(trigger, sources, now));

		const due = trigger.pending.length > 0 && now - trigger.lastFiredAt >= REFIRE_COOLDOWN_MS;

		if (due) {
			trigger.fired += 1;
			trigger.lastFiredAt = now;

			const lines = trigger.pending.splice(0);
			const last = trigger.fired >= trigger.maxFires;

			if (last) {
				triggers.delete(trigger.id);
			}

			const header = `Trigger ${trigger.id} ("${trigger.label}", waiting for ${describe(trigger.spec)}) fired${trigger.maxFires > 1 ? ` (${trigger.fired} of ${trigger.maxFires})` : ''}.`;
			const shown = lines.slice(-20);
			const more = lines.length > shown.length ? `\n(${lines.length - shown.length} earlier matches left out)` : '';
			const note = trigger.note ? `\n\nWhen you set it, you planned: ${trigger.note}` : '';
			const tail = last ? '' : `\n\nIt stays armed for ${trigger.maxFires - trigger.fired} more.`;

			await deliver({ ctx: trigger.ctx, source: 'trigger', label: trigger.label, text: `${header}\n\n${shown.join('\n')}${more}${note}${tail}` });

			continue;
		}

		if (now >= trigger.expiresAt) {
			triggers.delete(trigger.id);

			await deliver({
				ctx: trigger.ctx,
				source: 'trigger',
				label: trigger.label,
				text: `Trigger ${trigger.id} ("${trigger.label}", waiting for ${describe(trigger.spec)}) expired after ${seconds(now - trigger.createdAt)}${trigger.fired ? ` having fired ${trigger.fired} time(s)` : ' without firing'}.${trigger.note ? `\n\nYou had planned: ${trigger.note}` : ''}`
			});
		}
	}
}
