// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * One adapter per catalog tool (`$shared/mcptools`), each a thin call into the
 * `$core` bridge, exactly as an API route would make it; so a tool naming a
 * follower-owned instance is routed to that follower like any console click.
 *
 * Adapters shape what the model reads: trimmed rows, no IP addresses, no secret
 * values, nothing a chat log should not hold. Scope and argument checks happen
 * before an adapter runs (`protocol.ts`), so an adapter only ever sees arguments
 * that passed the tool's schema for a token allowed to call it.
 */

import { loadCluster, loadLock, managedInstances } from '$core/config';
import { getStatus, sendCommand } from '$core/instances';
import type { ClusterConfig } from '$core/types';
import { readInstanceLogs } from '$core/logs';
import { instancePluginReport } from '$core/pluginstate';
import { listBackups } from '$core/backups';
import { loadSchedules } from '$core/schedule';
import { readJournal } from '$core/journal';
import type { JournalLevel } from '$core/journal';
import { loadEnv, saveEnv, setVariable, unsetVariable, BUILTIN_SECRETS } from '$core/environment';
import { readServerProperties } from '$core/services/settings';
import { startInstanceTracked, stopInstanceTracked, restartInstanceTracked } from '$core/lifecycle';
import {
	createKnowledge,
	knowledgeFor,
	removeKnowledge,
	searchMemories,
	updateKnowledge
} from '$core/mcp';
import type { KnowledgeItem, McpPrincipal } from '$core/mcp';
import * as luna from '$core/services/luna';
import { listStatuses, getEvents, pushEvent, markTransition, clearTransition } from '$lib/server/luna';
import type { ClusterEvent } from '$lib/server/luna';
import { listDaemons, daemonDetail } from '$client/daemon';
import { startJob, watchJob } from '$lib/server/jobs';
import type { JobView } from '$lib/jobs';
import { scopeCoversInstance } from '$shared/mcptools';

/** What an adapter is handed besides its arguments. */
export interface ToolContext {
	principal: McpPrincipal;
	/** `mcp:<token name>`, the actor every change made over MCP is recorded as */
	actor: string;
}

export type ToolArgs = Record<string, unknown>;

export type ToolHandler = (args: ToolArgs, ctx: ToolContext) => Promise<unknown>;

/** How long a lifecycle tool waits for the instance to settle before answering. */
const LIFECYCLE_WAIT_MS = 3 * 60 * 1000;

/** A failure the model should read as-is, rather than as an internal error. */
export class ToolError extends Error {}

function str(args: ToolArgs, key: string): string {
	return String(args[key] ?? '');
}

function optStr(args: ToolArgs, key: string): string | undefined {
	const value = args[key];

	return typeof value === 'string' && value !== ''
		? value
		: undefined;
}

function num(args: ToolArgs, key: string, fallback: number): number {
	const value = args[key];

	return typeof value === 'number'
		? value
		: fallback;
}

/** Load the registry and refuse a name it does not manage. */
async function requireInstance(name: string): Promise<ClusterConfig> {
	const cfg = await loadCluster();

	if (!managedInstances(cfg)[name]) {
		throw new ToolError(`unknown instance "${name}"; call cluster_status for the list`);
	}

	return cfg;
}

/** Drop rows naming an instance the token may not see. */
function visibleRows<T>(ctx: ToolContext, rows: T[], nameOf: (row: T) => string): T[] {
	return rows.filter((row) => scopeCoversInstance(ctx.principal.scope, nameOf(row)));
}

/** Wait for a job to settle, or give up and say it is still going. */
function awaitJob(job: JobView, timeoutMs: number): Promise<JobView> {
	return new Promise((resolve) => {
		let unsubscribe: () => void = () => {};

		const timer = setTimeout(() => {
			unsubscribe();
			resolve(job);
		}, timeoutMs);

		unsubscribe = watchJob(job.id, (view) => {
			job = view;

			if (view.state === 'running') {
				return;
			}

			clearTimeout(timer);
			queueMicrotask(() => unsubscribe());
			resolve(view);
		});
	});
}

const LIFECYCLE = {
	start: startInstanceTracked,
	stop: stopInstanceTracked,
	restart: restartInstanceTracked
} as const;

/**
 * Start, stop or restart as a console job, so the transition shows on every open
 * console exactly as a click would, then wait for it to settle.
 */
async function lifecycle(action: keyof typeof LIFECYCLE, args: ToolArgs, ctx: ToolContext): Promise<unknown> {
	const name = str(args, 'instance');
	const cfg = await requireInstance(name);
	const run = LIFECYCLE[action];

	if (action === 'start') {
		clearTransition(name);
	} else {
		markTransition(name, action === 'stop' ? 'stopping' : 'restarting');
	}

	pushEvent(name, 'action', `${action} requested by ${ctx.actor}`);

	const job = startJob(`instance-${action}`, name, `${action} ${name}`, async (reporter) => {
		try {
			const result = await run(cfg, name, reporter);

			pushEvent(name, 'action', `${action} finished`);

			return result;
		} catch (err) {
			pushEvent(name, 'error', `${action} failed: ${err instanceof Error ? err.message : String(err)}`);

			throw err;
		} finally {
			clearTransition(name);
		}
	});

	const settled = await awaitJob(job, LIFECYCLE_WAIT_MS);

	if (settled.state === 'failed') {
		throw new ToolError(`${action} of ${name} failed: ${settled.error ?? 'unknown error'}`);
	}

	if (settled.state === 'running') {
		return {
			instance: name,
			action,
			state: 'still running',
			job: settled.id,
			note: 'check instance_status shortly'
		};
	}

	return { instance: name, action, state: 'done', result: settled.result };
}

/** The columns of a status row a model needs; the rest is console chrome. */
function statusSummary(row: Record<string, unknown>): Record<string, unknown> {
	return {
		name: row.name,
		state: row.state,
		software: row.software,
		mcVersion: row.mcVersion,
		players: row.players,
		tps: row.tps,
		cpu: row.cpu,
		memoryMb: row.rssMb,
		heapUsedMb: row.heapUsedMb,
		heapMaxMb: row.heapMaxMb,
		uptimeMs: row.uptimeMs,
		machine: row.daemon ?? 'primary',
		address: row.address
	};
}

function eventLine(event: ClusterEvent): Record<string, unknown> {
	return { at: new Date(event.t).toISOString(), instance: event.instance, kind: event.kind, message: event.message };
}

function knowledgeView(item: KnowledgeItem): Record<string, unknown> {
	return {
		id: item.id,
		title: item.title,
		description: item.description || undefined,
		body: item.body,
		tags: item.tags,
		scope: item.scope.kind,
		updatedAt: new Date(item.updatedAt).toISOString()
	};
}

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
	// -- observe ---------------------------------------------------------------
	async cluster_status(_args, ctx) {
		const data = await listStatuses();
		const instances = visibleRows(ctx, data.instances, (row) => String(row.name)).map(statusSummary);

		return {
			instances,
			externals: data.externals.map((row) => ({ name: row.name, state: row.state, address: row.address })),
			problem: data.lunaProblem ?? undefined
		};
	},

	async instance_status(args) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);

		return await getStatus(cfg, name);
	},

	async instance_logs(args) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);
		const search = optStr(args, 'search')?.toLowerCase();
		const wanted = num(args, 'lines', 100);

		// a search reads a wider window so a filter has something to filter
		const logs = await readInstanceLogs(cfg, name, search ? Math.max(wanted * 10, 2000) : wanted);
		let lines = logs.content.split('\n');

		if (search) {
			lines = lines.filter((line) => line.toLowerCase().includes(search));
		}

		return { instance: name, lines: lines.slice(-wanted).join('\n') };
	},

	async players_online(args, ctx) {
		const server = optStr(args, 'instance');
		const result = await luna.players(server);

		if (!result.ok || !result.data) {
			throw new ToolError(`the proxy did not answer: ${result.error ?? 'unavailable'}`);
		}

		const visible = visibleRows(ctx, result.data.players, (player) => player.server);
		const players = visible.map((player) => ({
			username: player.username,
			uuid: player.uuid,
			server: player.server,
			pingMs: player.pingMillis,
			sessionMinutes: Math.round(player.sessionMillis / 60_000),
			clientVersion: player.clientVersion
		}));

		return { onlineCount: players.length, byServer: result.data.byServer, players };
	},

	async player_lookup(args) {
		const result = await luna.registeredPlayer(str(args, 'player'));

		if (!result.ok || !result.data) {
			const reason = result.status === 404
				? `no player named "${str(args, 'player')}" has been seen on the network`
				: `the proxy did not answer: ${result.error ?? 'unavailable'}`;

			throw new ToolError(reason);
		}

		const player = result.data;

		return {
			username: player.username,
			uuid: player.uuid,
			online: player.online,
			server: player.server || undefined,
			firstSeen: new Date(player.firstSeenAtEpochMillis).toISOString(),
			lastSeen: new Date(player.lastSeenAtEpochMillis).toISOString(),
			lastServer: player.lastServer,
			totalPlayHours: Math.round(player.totalPlayMillis / 36_000) / 100,
			sessions: player.sessionCount,
			playtimeByServer: player.playtimeByServer,
			lastClientVersion: player.lastClientVersion,
			moderationEntries: player.moderationTotal
		};
	},

	async fleet_status() {
		const rows = await listDaemons();

		return rows.map((row) => ({
			name: row.name,
			mode: row.mode,
			state: row.state,
			quarantine: row.quarantine ?? undefined,
			version: row.version,
			outdated: row.outdated,
			latencyMs: row.latencyMs,
			uptimeMs: row.uptimeMs,
			instances: row.instances,
			health: row.health
				? {
						cpuPct: Math.round(row.health.cpuPct),
						cpuCores: row.health.cpuCores,
						memUsedMb: row.health.memUsedMb,
						memTotalMb: row.health.memTotalMb,
						diskUsedGb: Math.round(row.health.diskUsedBytes / 1e9),
						diskTotalGb: Math.round(row.health.diskTotalBytes / 1e9),
						load1: row.health.load1
					}
				: null,
			failingChecks: row.checks.filter((check) => check.ok === false)
		}));
	},

	async daemon_detail(args) {
		const detail = await daemonDetail(str(args, 'daemon'));

		if (!detail) {
			throw new ToolError(`no daemon named "${str(args, 'daemon')}"; call fleet_status for the list`);
		}

		return detail;
	},

	async cluster_events(args, ctx) {
		const instance = optStr(args, 'instance');
		const events = await getEvents(instance);
		// daemon events (`daemon:<name>`) name a machine, not an instance, so the
		// instance allowlist has nothing to say about them
		const visible = events.filter(
			(event) => event.instance.startsWith('daemon:') || scopeCoversInstance(ctx.principal.scope, event.instance)
		);

		return visible.slice(0, num(args, 'limit', 30)).map(eventLine);
	},

	async plugins_list(args) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);
		const lock = await loadLock();
		const report = await instancePluginReport(cfg, lock, name);

		return {
			instance: name,
			plugins: report.rows.map((row) => ({
				name: row.displayName || row.plugin,
				version: row.version,
				source: row.source,
				state: row.state,
				disabled: row.disabled || undefined,
				pinned: row.pinned || undefined,
				warnings: row.warnings || undefined,
				errors: row.errors || undefined
			})),
			unmanaged: report.unmanaged.map((row) => row.file)
		};
	},

	async backups_list(args) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);

		return await listBackups(cfg, name);
	},

	async schedules_list(_args, ctx) {
		const store = await loadSchedules();

		// a wildcard target cannot be judged against an allowlist, so a limited token
		// sees only the schedules naming its instances outright
		const schedules = store.schedules.filter((entry) =>
			entry.instances.every((target) => scopeCoversInstance(ctx.principal.scope, target))
		);

		return schedules.map((entry) => ({
			name: entry.name,
			description: entry.description,
			enabled: entry.enabled,
			action: entry.action,
			instances: entry.instances,
			trigger: entry.trigger,
			nextRun: entry.nextRun,
			lastRunAt: entry.lastRunAt,
			runs: entry.runs
		}));
	},

	async console_journal(args) {
		const page = await readJournal({
			limit: num(args, 'limit', 50),
			search: optStr(args, 'search'),
			minLevel: optStr(args, 'level') as JournalLevel | undefined
		});

		return page.entries.map((entry) => ({
			at: new Date(entry.t).toISOString(),
			level: entry.level,
			source: entry.source,
			message: entry.message,
			actor: entry.actor
		}));
	},

	// -- control ---------------------------------------------------------------
	async instance_start(args, ctx) {
		return await lifecycle('start', args, ctx);
	},

	async instance_stop(args, ctx) {
		return await lifecycle('stop', args, ctx);
	},

	async instance_restart(args, ctx) {
		return await lifecycle('restart', args, ctx);
	},

	async instance_command(args, ctx) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);
		const command = str(args, 'command').replace(/^\//, '').trim();

		if (!command || /[\r\n]/.test(command)) {
			throw new ToolError('the command must be a single non-empty line');
		}

		const sent = await sendCommand(cfg, name, command);

		if (!sent) {
			throw new ToolError(`${name} is not running, so there is no console to type into`);
		}

		pushEvent(name, 'action', `console command by ${ctx.actor}: ${command}`);

		return { instance: name, sent: command, note: 'read instance_logs for the output' };
	},

	async broadcast(args, ctx) {
		const server = optStr(args, 'instance');

		if (server && !scopeCoversInstance(ctx.principal.scope, server)) {
			throw new ToolError(`this token may not reach ${server}`);
		}

		if (!server && ctx.principal.scope.instances !== null) {
			throw new ToolError('this token is limited to some instances, so it may only broadcast to one of them');
		}

		const result = await luna.broadcast(str(args, 'message'), server);

		if (!result.ok || !result.data) {
			throw new ToolError(`the proxy did not answer: ${result.error ?? 'unavailable'}`);
		}

		return result.data;
	},

	// -- config ----------------------------------------------------------------
	async env_list(args, ctx) {
		const store = await loadEnv();
		const instance = optStr(args, 'instance');
		const secret = (name: string) => !!store.variables[name]?.secret || BUILTIN_SECRETS.has(name);
		const shown = (name: string, value: string) => (secret(name) ? '••••••' : value);

		if (instance) {
			if (!scopeCoversInstance(ctx.principal.scope, instance)) {
				throw new ToolError(`this token may not reach ${instance}`);
			}

			const values = store.instances[instance] ?? {};

			return Object.entries(values).map(([name, value]) => ({
				name,
				value: shown(name, value),
				scope: 'instance',
				instance
			}));
		}

		const rows: Array<Record<string, unknown>> = [];

		for (const [name, def] of Object.entries(store.variables)) {
			rows.push({
				name,
				value: shown(name, def.value),
				scope: 'global',
				description: def.description,
				secret: secret(name) || undefined
			});
		}

		for (const [machine, values] of Object.entries(store.machines)) {
			for (const [name, value] of Object.entries(values)) {
				rows.push({ name, value: shown(name, value), scope: 'machine', machine: machine || 'primary' });
			}
		}

		for (const [owner, values] of Object.entries(store.instances)) {
			if (!scopeCoversInstance(ctx.principal.scope, owner)) {
				continue;
			}

			for (const [name, value] of Object.entries(values)) {
				rows.push({ name, value: shown(name, value), scope: 'instance', instance: owner });
			}
		}

		return rows;
	},

	async env_set(args, ctx) {
		const name = str(args, 'name');
		const instance = optStr(args, 'instance');
		const store = await loadEnv();

		if (store.variables[name]?.secret || BUILTIN_SECRETS.has(name)) {
			throw new ToolError(`${name} is a secret; secrets can only be changed from the console`);
		}

		if (instance) {
			await requireInstance(instance);
		} else if (ctx.principal.scope.instances !== null) {
			throw new ToolError('this token is limited to some instances, so it may only set instance-scoped variables');
		}

		setVariable(store, name, str(args, 'value'), instance ? { instance } : {});

		await saveEnv(store);

		const scope = instance
			? `instance ${instance}`
			: 'global';

		return { name, scope, note: 'takes effect on the next start of the affected instances' };
	},

	async env_unset(args, ctx) {
		const name = str(args, 'name');
		const instance = optStr(args, 'instance');
		const store = await loadEnv();

		if (store.variables[name]?.secret || BUILTIN_SECRETS.has(name)) {
			throw new ToolError(`${name} is a secret; secrets can only be changed from the console`);
		}

		if (!instance && ctx.principal.scope.instances !== null) {
			throw new ToolError('this token is limited to some instances, so it may only unset instance-scoped variables');
		}

		const removed = unsetVariable(store, name, instance ? { instance } : {});

		if (!removed) {
			throw new ToolError(`${name} is not set at that scope`);
		}

		await saveEnv(store);

		return { name, removed: true };
	},

	async settings_get(args) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);

		return await readServerProperties(cfg, name);
	},

	// -- knowledge -------------------------------------------------------------
	async memory_search(args, ctx) {
		const hits = await searchMemories(ctx.principal.id, str(args, 'query'), num(args, 'limit', 8));

		return hits.map((hit) => ({ ...knowledgeView(hit.item), editable: hit.item.scope.kind === 'token' }));
	},

	async skill_list(_args, ctx) {
		const skills = await knowledgeFor(ctx.principal.id, 'skill');

		return skills.map((skill) => ({ name: skill.title, description: skill.description }));
	},

	async skill_get(args, ctx) {
		const skills = await knowledgeFor(ctx.principal.id, 'skill');
		const skill = skills.find((entry) => entry.title === str(args, 'name'));

		if (!skill) {
			throw new ToolError(`no skill named "${str(args, 'name')}"; call skill_list for the list`);
		}

		return { name: skill.title, description: skill.description, body: skill.body };
	},

	async context_get(_args, ctx) {
		const items = await knowledgeFor(ctx.principal.id, 'context');

		return items.map(knowledgeView);
	},

	// -- knowledge-write -------------------------------------------------------
	async memory_save(args, ctx) {
		const item = await createKnowledge(
			{
				kind: 'memory',
				scope: { kind: 'token', token: ctx.principal.id },
				title: str(args, 'title'),
				body: str(args, 'body'),
				tags: Array.isArray(args.tags) ? (args.tags as string[]) : []
			},
			ctx.actor
		);

		return { id: item.id, saved: true };
	},

	async memory_update(args, ctx) {
		const item = await updateKnowledge(
			str(args, 'id'),
			{
				title: optStr(args, 'title'),
				body: optStr(args, 'body'),
				tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined
			},
			ctx.actor,
			ctx.principal.id
		);

		return { id: item.id, updated: true };
	},

	async memory_forget(args, ctx) {
		const item = await removeKnowledge(str(args, 'id'), ctx.actor, ctx.principal.id);

		return { id: item.id, forgotten: true };
	}
};
