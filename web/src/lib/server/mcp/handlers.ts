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
import { startJob } from '$lib/server/jobs';
import { awaitJob } from './jobs';
import type { JobView } from '$lib/jobs';
import { lunaShellRefusal, scopeCoversInstance } from '$shared/mcptools';
import { browseInstance, readInstanceFile, writeInstanceFile, MAX_EDIT_BYTES } from '$core/configfiles';
import {
	copyInstancePath,
	deleteInstancePath,
	findInstanceFiles,
	makeInstanceDir,
	moveInstancePath,
	statInstancePath
} from '$core/instancefiles';
import { runHostCommand } from '$core/hostshell';
import { cliBinary, root } from '$lib/server/luna';
import { ToolError } from './errors';
import type { ToolArgs, ToolContext, ToolHandler } from './errors';
import { ADDON_HANDLERS } from './addons';
import { NETWORK_HANDLERS } from './network';
import { PACK_HANDLERS } from './packs';
import { MODPACK_HANDLERS } from './modpacks';

export { ToolError } from './errors';
export type { ToolArgs, ToolContext, ToolHandler } from './errors';

/** How long a lifecycle tool waits for the instance to settle before answering. */
const LIFECYCLE_WAIT_MS = 3 * 60 * 1000;

/** Default and ceiling for one luna_shell command. */
const LUNA_SHELL_DEFAULT_TIMEOUT_MS = 120_000;
const LUNA_SHELL_MAX_TIMEOUT_MS = 600_000;

/** Most characters of CLI output returned to the model. */
const LUNA_SHELL_MAX_OUTPUT = 64 * 1024;

/** Lines file_read returns when the caller does not say. */
const FILE_READ_DEFAULT_LINES = 400;



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

/** ANSI escapes, which the CLI emits for colour and the model has no use for. */
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

/**
 * Run the luna CLI as the drawer does, but for a token: attributed to it,
 * without colour, killed at its timeout, its output capped.
 */
async function runLunaCli(args: string[], actor: string, timeoutMs: number): Promise<Record<string, unknown>> {
	const proc = Bun.spawn([cliBinary(), ...args], {
		env: {
			...process.env,
			LUNA_ROOT: root(),
			LUNA_ACTOR: actor,
			LUNA_LANG: 'en',
			NO_COLOR: '1',
			FORCE_COLOR: '0'
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe'
	});

	let timedOut = false;

	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill('SIGKILL');
	}, timeoutMs);

	try {
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const exitCode = await proc.exited;
		const output = `${stdout}${stderr ? `\n${stderr}` : ''}`.replace(ANSI, '').trim();
		const truncated = output.length > LUNA_SHELL_MAX_OUTPUT;

		return {
			command: `luna ${args.join(' ')}`,
			exitCode: timedOut ? null : exitCode,
			timedOut: timedOut || undefined,
			output: truncated
				? `${output.slice(0, LUNA_SHELL_MAX_OUTPUT)}\n… [truncated]`
				: output
		};
	} finally {
		clearTimeout(timer);
	}
}

/** Drop rows naming an instance the token may not see. */
function visibleRows<T>(ctx: ToolContext, rows: T[], nameOf: (row: T) => string): T[] {
	return rows.filter((row) => scopeCoversInstance(ctx.principal.scope, nameOf(row)));
}

/**
 * The refusal for a name the directory does not hold exactly, naming the
 * players whose username contains it, so a nickname or fragment ("nene")
 * leads straight to the real account instead of a dead end.
 */
async function unknownPlayer(name: string): Promise<string> {
	const near = await luna.registeredPlayers({ search: name, sort: 'lastSeen', dir: 'desc', limit: 10 });
	const players = near.ok && near.data
		? near.data.players
		: [];

	if (players.length === 0) {
		return `no player named "${name}" has been seen on the network, and no username contains it`;
	}

	// two profiles can share a username (an account moved to a new UUID), and
	// only the UUID tells them apart
	const counts = new Map<string, number>();

	for (const player of players) {
		counts.set(player.username, (counts.get(player.username) ?? 0) + 1);
	}

	const names = players.map((player) => (counts.get(player.username) ?? 0) > 1
		? `${player.username} (uuid ${player.uuid})`
		: player.username);

	return `no player is named exactly "${name}"; players whose name contains it: ${names.join(', ')}. Retry with one of them (a UUID when two share a name)`;
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
	...ADDON_HANDLERS,
	...NETWORK_HANDLERS,
	...PACK_HANDLERS,
	...MODPACK_HANDLERS,

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

	async player_search(args) {
		const result = await luna.registeredPlayers({
			search: optStr(args, 'query')?.trim() || undefined,
			sort: optStr(args, 'sort') ?? 'lastSeen',
			dir: optStr(args, 'sort') === 'username' ? 'asc' : 'desc',
			limit: num(args, 'limit', 20),
			offset: num(args, 'offset', 0)
		});

		if (!result.ok || !result.data) {
			throw new ToolError(`the proxy did not answer: ${result.error ?? 'unavailable'}`);
		}

		return {
			total: result.data.total,
			offset: result.data.offset,
			players: result.data.players.map((player) => ({
				username: player.username,
				uuid: player.uuid,
				online: player.online,
				server: player.server || undefined,
				lastSeen: new Date(player.lastSeenAtEpochMillis).toISOString(),
				lastServer: player.lastServer,
				totalPlayHours: Math.round(player.totalPlayMillis / 36_000) / 100,
				sessions: player.sessionCount
			}))
		};
	},

	async player_chat(args, ctx) {
		const player = str(args, 'player');
		const server = optStr(args, 'server');
		const type = optStr(args, 'type');

		if (server && !scopeCoversInstance(ctx.principal.scope, server)) {
			throw new ToolError(`this token may not read ${server}`);
		}

		const result = await luna.playerChat(player, {
			...(type === 'chat' || type === 'command' ? { type } : {}),
			...(server ? { server } : {}),
			limit: num(args, 'limit', 100),
			offset: num(args, 'offset', 0)
		});

		if (!result.ok || !result.data) {
			throw new ToolError(result.status === 404
				? await unknownPlayer(player)
				: `the proxy did not answer: ${result.error ?? 'unavailable'}`);
		}

		// an older LunaCore ignores the server filter, so it is applied again here
		const entries = visibleRows(ctx, result.data.entries, (entry) => entry.server)
			.filter((entry) => !server || entry.server === server);

		return {
			player,
			total: result.data.total,
			offset: result.data.offset,
			returned: entries.length,
			more: result.data.offset + result.data.entries.length < result.data.total,
			entries: entries.map((entry) => ({
				at: new Date(entry.atEpochMillis).toISOString(),
				server: entry.server,
				type: entry.type,
				content: entry.content
			}))
		};
	},

	async chat_log(args, ctx) {
		const server = optStr(args, 'server');
		const type = optStr(args, 'type');

		if (server && !scopeCoversInstance(ctx.principal.scope, server)) {
			throw new ToolError(`this token may not read ${server}`);
		}

		const result = await luna.serverChat({
			...(server ? { server } : {}),
			...(type === 'chat' || type === 'command' ? { type } : {}),
			search: optStr(args, 'search')?.trim() || undefined,
			limit: num(args, 'limit', 100),
			offset: num(args, 'offset', 0)
		});

		if (!result.ok || !result.data) {
			throw new ToolError(result.status === 404
				? 'the proxy\'s LunaCore build predates the network chat log'
				: `the proxy did not answer: ${result.error ?? 'unavailable'}`);
		}

		const entries = visibleRows(ctx, result.data.entries, (entry) => entry.server);

		return {
			total: result.data.total,
			offset: result.data.offset,
			returned: entries.length,
			more: result.data.offset + result.data.entries.length < result.data.total,
			entries: entries.map((entry) => ({
				at: new Date(entry.atEpochMillis).toISOString(),
				player: entry.username,
				server: entry.server,
				type: entry.type,
				content: entry.content
			}))
		};
	},

	async player_lookup(args) {
		const result = await luna.registeredPlayer(str(args, 'player'));

		if (!result.ok || !result.data) {
			const reason = result.status === 404
				? await unknownPlayer(str(args, 'player'))
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

	// -- files ------------------------------------------------------------------
	async file_list(args) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);
		const listing = await browseInstance(cfg, name, optStr(args, 'path') ?? '');

		return {
			instance: name,
			path: listing.path || '/',
			entries: listing.entries.map((entry) => ({
				name: entry.name,
				kind: entry.kind,
				size: entry.kind === 'file' ? entry.size : undefined,
				modified: new Date(entry.modified).toISOString(),
				managed: entry.managed || undefined
			}))
		};
	},

	async file_read(args) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);
		const file = await readInstanceFile(cfg, name, str(args, 'path'));
		const lines = file.text.split('\n');
		const offset = num(args, 'offset', 1);
		const limit = num(args, 'limit', FILE_READ_DEFAULT_LINES);
		const slice = lines.slice(offset - 1, offset - 1 + limit);

		return {
			instance: name,
			path: file.path,
			size: file.size,
			totalLines: lines.length,
			fromLine: offset,
			toLine: offset - 1 + slice.length,
			managed: file.managed || undefined,
			note: file.managed
				? 'luna renders this file from a template on every start; file_write changes the template'
				: undefined,
			content: slice.join('\n')
		};
	},

	async file_stat(args) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);
		const info = await statInstancePath(cfg, name, str(args, 'path'));

		return info
			? { exists: true, ...info, modified: new Date(info.modified).toISOString() }
			: { exists: false, path: str(args, 'path') };
	},

	async file_find(args) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);
		const result = await findInstanceFiles(cfg, name, {
			path: optStr(args, 'path'),
			name: optStr(args, 'name'),
			depth: num(args, 'depth', 4),
			limit: num(args, 'limit', 100)
		});

		return {
			instance: name,
			truncated: result.truncated || undefined,
			entries: result.entries.map((entry) => ({ ...entry, modified: new Date(entry.modified).toISOString() }))
		};
	},

	async file_write(args, ctx) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);
		const path = str(args, 'path');
		const content = str(args, 'content');

		if (Buffer.byteLength(content) > MAX_EDIT_BYTES) {
			throw new ToolError(`content is over the ${MAX_EDIT_BYTES / 1024} KB limit for one file`);
		}

		if (args.createOnly === true && (await statInstancePath(cfg, name, path))) {
			throw new ToolError(`${path} already exists`);
		}

		const result = await writeInstanceFile(cfg, name, path, content);

		pushEvent(name, 'action', `file written by ${ctx.actor}: ${path}`);

		return { instance: name, path, written: Buffer.byteLength(content), result };
	},

	async file_mkdir(args, ctx) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);
		const info = await makeInstanceDir(cfg, name, str(args, 'path'));

		pushEvent(name, 'action', `directory created by ${ctx.actor}: ${info.path}`);

		return { instance: name, created: info.path };
	},

	async file_copy(args, ctx) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);
		const info = await copyInstancePath(cfg, name, str(args, 'from'), str(args, 'to'), {
			overwrite: args.overwrite === true
		});

		pushEvent(name, 'action', `copied by ${ctx.actor}: ${str(args, 'from')} → ${info.path}`);

		return { instance: name, copied: str(args, 'from'), to: info.path, kind: info.kind };
	},

	async file_move(args, ctx) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);
		const info = await moveInstancePath(cfg, name, str(args, 'from'), str(args, 'to'), {
			overwrite: args.overwrite === true
		});

		pushEvent(name, 'action', `moved by ${ctx.actor}: ${str(args, 'from')} → ${info.path}`);

		return { instance: name, moved: str(args, 'from'), to: info.path, kind: info.kind };
	},

	async file_delete(args, ctx) {
		const name = str(args, 'instance');
		const cfg = await requireInstance(name);
		const removed = await deleteInstancePath(cfg, name, str(args, 'path'), {
			recursive: args.recursive === true
		});

		pushEvent(name, 'action', `deleted by ${ctx.actor}: ${removed.path}`);

		return { instance: name, deleted: removed.path, kind: removed.kind, size: removed.kind === 'file' ? removed.size : undefined };
	},

	// -- shells -------------------------------------------------------------------
	async luna_shell(args, ctx) {
		const words = Array.isArray(args.args)
			? (args.args as string[])
			: [];

		// the CLI can name any instance, so a token held to some instances
		// cannot be trusted with it
		if (ctx.principal.scope.instances !== null) {
			throw new ToolError('this token is limited to some instances, so it cannot use the luna CLI');
		}

		const refusal = lunaShellRefusal(words);

		if (refusal) {
			throw new ToolError(refusal);
		}

		const timeoutMs = Math.min(num(args, 'timeoutSeconds', LUNA_SHELL_DEFAULT_TIMEOUT_MS / 1000) * 1000, LUNA_SHELL_MAX_TIMEOUT_MS);

		return await runLunaCli(words, ctx.actor, timeoutMs);
	},

	async shell_bash(args, ctx) {
		const instance = optStr(args, 'instance') ?? null;

		if (!instance && ctx.principal.scope.instances !== null) {
			throw new ToolError('this token is limited to some instances, so it must name one to run a command');
		}

		const cfg = instance
			? await requireInstance(instance)
			: await loadCluster();

		const result = await runHostCommand(cfg, instance, str(args, 'command'), {
			timeoutMs: num(args, 'timeoutSeconds', 60) * 1000,
			actor: ctx.actor
		});

		return {
			exitCode: result.exitCode,
			timedOut: result.timedOut || undefined,
			truncated: result.truncated || undefined,
			durationMs: result.durationMs,
			cwd: result.cwd,
			stdout: result.stdout,
			stderr: result.stderr || undefined
		};
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
