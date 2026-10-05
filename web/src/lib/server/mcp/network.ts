// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The network tools (`network`, `network-write` in `$shared/mcptools`): the
 * `/servers` menu, velocity's routing and the port map. Each adapter makes the
 * bridge calls the matching console route makes (`/api/selector`, `/api/proxy`,
 * `/api/ports`, the instance config route's port change), in the same order.
 *
 * Two departures from those routes, both on purpose. `proxy_register` and
 * `proxy_sync` reload velocity whenever asked, even when velocity.toml was
 * already in sync, because a server created moments ago is exactly that case
 * and velocity does not learn it otherwise. And the menu's apply runs inline
 * rather than as a console job: an MCP call already waits for its answer.
 */

import { loadCluster, loadLock, managedInstances, saveCluster } from '$core/config';
import { apply as applySelector, applyDraftToCluster, draft as loadDraft, state as loadSelectorState, validateSelectorDraft } from '$core/selector';
import type { InstanceSelectorEntry, SelectorServerDraft } from '$core/selector';
import { readVelocityServers, setProxyRegistration, syncVelocityToml } from '$core/proxy';
import { auditPorts, checkPort, clusterMachines, collectPortRows, ensurePortAllocations, machineLabel, portPoolUsage, PRIMARY_MACHINE } from '$core/ports';
import { setPort } from '$core/admin';
import { getStatus, sendCommand } from '$core/instances';
import type { ClusterConfig } from '$core/types';
import { listDaemons } from '$client/daemon';
import { pushEvent } from '$lib/server/luna';
import { scopeCoversInstance } from '$shared/mcptools';
import { optBool, optInt, optList, optStr, requireWholeCluster, str } from './args';
import { ToolError } from './errors';
import type { ToolHandler } from './errors';

/**
 * A machine key out of what the model typed: a follower's daemon name, the
 * primary's daemon name, "primary", or nothing at all for the primary.
 */
async function machineKey(cfg: ClusterConfig, name: string | undefined): Promise<string> {
	if (!name || name === 'primary') {
		return PRIMARY_MACHINE;
	}

	if (clusterMachines(cfg).includes(name)) {
		return name;
	}

	const primary = (await listDaemons()).find((row) => row.mode === 'primary');

	if (primary?.name === name) {
		return PRIMARY_MACHINE;
	}

	throw new ToolError(`unknown machine "${name}"; call fleet_status for the names`);
}

/** Reload velocity when it is running; false when there was nothing to reload. */
async function reloadVelocity(cfg: ClusterConfig): Promise<boolean> {
	const status = await getStatus(cfg, 'proxy');

	if (status.state === 'stopped') {
		return false;
	}

	return await sendCommand(cfg, 'proxy', 'velocity reload');
}

function requireRegistrable(cfg: ClusterConfig, name: string): void {
	if (!cfg.instances[name]) {
		throw new ToolError(`unknown instance "${name}"; call cluster_status for the list (the proxy itself has no menu entry or registration)`);
	}
}

function menuRow(name: string, server: SelectorServerDraft) {
	return {
		instance: name,
		displayName: server.serverDisplay ?? null,
		accentColor: server.accentColor ?? null,
		icon: server.serverIcon ?? null,
		description: server.description ?? [],
		placed: !!server.selector,
		page: server.selector?.page ?? null,
		slot: server.selector?.slot ?? null,
		permission: server.selector?.permission ?? null,
		publicListed: server.publicListed === true,
		host: server.hostName,
		software: server.software,
		mcVersion: server.mcVersion ?? null,
		external: server.external === true
	};
}

export const NETWORK_HANDLERS: Record<string, ToolHandler> = {
	async server_menu_list(_args, ctx) {
		const cfg = await loadCluster();
		const draft = await loadDraft(cfg);
		const state = await loadSelectorState(cfg);
		const servers = Object.entries(draft.servers)
			.filter(([name]) => scopeCoversInstance(ctx.principal.scope, name))
			.map(([name, server]) => menuRow(name, server))
			.sort((a, b) => (a.page ?? 99) - (b.page ?? 99) || (a.slot ?? 99) - (b.slot ?? 99));

		return {
			enabled: draft.global.enabled,
			title: draft.global.title ?? null,
			servers,
			appliedMatchesRegistry: !state.drift,
			driftPaths: state.driftPaths,
			issues: state.issues,
			proxyReachable: state.proxyReachable
		};
	},

	async proxy_registrations(_args, ctx) {
		const cfg = await loadCluster();
		const preview = await syncVelocityToml(cfg, true);
		const onDisk = await readVelocityServers(cfg);
		const registrations = Object.entries(cfg.instances)
			.filter(([name]) => scopeCoversInstance(ctx.principal.scope, name))
			.map(([name, inst]) => ({
				instance: name,
				external: !!inst.external,
				registered: inst.proxy?.register ?? false,
				tryPriority: inst.proxy?.priority ?? null,
				forcedHosts: inst.proxy?.forcedHosts ?? []
			}));

		return {
			syncPending: preview.changed,
			registrations,
			wanted: preview.servers,
			onDisk,
			tryList: preview.tryList,
			forcedHosts: preview.forcedHosts
		};
	},

	async ports_list(args, ctx) {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const machineArg = optStr(args, 'machine');
		const machine = machineArg === undefined
			? undefined
			: await machineKey(cfg, machineArg);
		const rows = await collectPortRows(cfg, lock);
		const onDisk = await readVelocityServers(cfg);
		const issues = await auditPorts(cfg, lock, onDisk);

		// a plugin port's owner reads "instance/plugin"; the instance is what the scope names
		const ownerInstance = (owner: string): string => owner.split('/')[0]!;

		const ports = rows
			.filter((row) => machine === undefined || row.machine === machine)
			.filter((row) => scopeCoversInstance(ctx.principal.scope, ownerInstance(row.owner)))
			.map((row) => ({
				port: row.port,
				protocol: row.protocol,
				owner: row.owner,
				kind: row.kind,
				machine: row.machine === null ? null : machineLabel(row.machine),
				address: row.address,
				listening: row.listening,
				pool: row.pool
			}));

		const pools = portPoolUsage(cfg, lock, machine === undefined ? undefined : [machine]).map((usage) => ({
			machine: machineLabel(usage.machine),
			pool: usage.pool.id,
			range: usage.pool.range,
			protocol: usage.pool.protocol,
			used: usage.used.length,
			free: usage.free,
			next: usage.next
		}));

		return {
			ports,
			pools,
			issues: issues
				.filter((issue) => machine === undefined || issue.machine === undefined || issue.machine === machine)
				.map((issue) => ({ kind: issue.kind, message: issue.message, machine: issue.machine === undefined ? undefined : machineLabel(issue.machine) }))
		};
	},

	async port_check(args) {
		const cfg = await loadCluster();
		const lock = await loadLock();
		const machine = await machineKey(cfg, optStr(args, 'machine'));
		const protocol = optStr(args, 'protocol') === 'udp'
			? 'udp'
			: 'tcp';
		const port = optInt(args, 'port') ?? 0;
		const check = checkPort(cfg, port, { machine, protocol, lock });

		return {
			port,
			machine: machineLabel(machine),
			free: check.ok,
			reason: check.error ?? undefined,
			warning: check.warning ?? undefined,
			pool: check.pool
		};
	},

	async server_menu_set(args, ctx) {
		requireWholeCluster(ctx, 'the /servers menu');

		const name = str(args, 'instance');
		const cfg = await loadCluster();

		requireRegistrable(cfg, name);

		const draft = await loadDraft(cfg);
		const server = draft.servers[name]!;
		const page = optInt(args, 'page');
		const slot = optInt(args, 'slot');
		const placed = optBool(args, 'placed');
		const changed: string[] = [];

		const text = (key: string, field: 'serverDisplay' | 'accentColor' | 'serverIcon'): void => {
			const value = optStr(args, key);

			if (value !== undefined) {
				server[field] = value.trim() || undefined;
				changed.push(key);
			}
		};

		text('displayName', 'serverDisplay');
		text('accentColor', 'accentColor');
		text('icon', 'serverIcon');

		const description = optList(args, 'description');

		if (description !== undefined) {
			server.description = description;
			changed.push('description');
		}

		const publicListed = optBool(args, 'publicListed');

		if (publicListed !== undefined) {
			server.publicListed = publicListed;
			changed.push('publicListed');
		}

		if (placed === false) {
			if (page !== undefined || slot !== undefined) {
				throw new ToolError('placed is false, so page and slot have nowhere to go; give one or the other');
			}

			server.selector = undefined;
			changed.push('placed');
		} else {
			const placing = placed === true || page !== undefined || slot !== undefined;
			const entry: InstanceSelectorEntry | undefined = server.selector ?? (placing ? { page: 1, slot: 0 } : undefined);

			if (placing && !server.selector && slot === undefined) {
				throw new ToolError('placing a server in the menu needs a slot (0-44); call server_menu_list to see which are taken');
			}

			if (entry) {
				if (page !== undefined) {
					entry.page = page;
				}

				if (slot !== undefined) {
					entry.slot = slot;
				}

				const glint = optBool(args, 'glint');

				if (glint !== undefined) {
					entry.glint = glint;
					changed.push('glint');
				}

				const permission = optStr(args, 'permission');

				if (permission !== undefined) {
					entry.permission = permission.trim() || undefined;
					changed.push('permission');
				}

				if (placing) {
					changed.push('placement');
				}

				server.selector = entry;
			} else if (optBool(args, 'glint') !== undefined || optStr(args, 'permission') !== undefined) {
				throw new ToolError(`${name} is not in the menu, so glint and permission have nothing to attach to; place it with a slot first`);
			}
		}

		if (changed.length === 0) {
			throw new ToolError('nothing to change; give at least one field');
		}

		applyDraftToCluster(cfg, draft);
		await saveCluster(cfg);
		pushEvent('proxy', 'action', `server menu entry for ${name} edited by ${ctx.actor}`);

		const issues = validateSelectorDraft(draft);

		return {
			saved: true,
			changed,
			entry: menuRow(name, draft.servers[name]!),
			issues,
			note: issues.some((issue) => issue.level === 'error')
				? 'saved, but the menu has errors; server_menu_apply will refuse until they are fixed'
				: 'saved; players see it after server_menu_apply'
		};
	},

	async server_menu_apply(_args, ctx) {
		requireWholeCluster(ctx, 'the /servers menu');

		const cfg = await loadCluster();

		try {
			const result = await applySelector(cfg);

			pushEvent('proxy', 'action', `server selector applied by ${ctx.actor} (${result.placed} server(s))`);

			return {
				wrote: result.wrote,
				proxyReloaded: result.proxyReloaded,
				placed: result.placed,
				note: result.proxyReloaded
					? 'players see the new menu now'
					: 'servers.yml was written but the proxy did not confirm the reload; check proxy logs'
			};
		} catch (err) {
			throw new ToolError((err as Error).message);
		}
	},

	async proxy_register(args, ctx) {
		requireWholeCluster(ctx, "velocity's routing");

		const name = str(args, 'instance');
		const cfg = await loadCluster();

		requireRegistrable(cfg, name);

		const priority = optInt(args, 'priority');
		const tryList = optBool(args, 'tryList');

		if (priority !== undefined && tryList === false) {
			throw new ToolError('tryList false takes the server out of the try list, so a priority contradicts it; give one or the other');
		}

		let result: { changed: string[] };

		try {
			result = setProxyRegistration(cfg, name, {
				register: optBool(args, 'register'),
				priority: tryList === false
					? null
					: priority,
				forcedHosts: optList(args, 'forcedHosts')
			});
		} catch (err) {
			throw new ToolError((err as Error).message);
		}

		if (result.changed.length > 0) {
			await saveCluster(cfg);
		}

		const sync = await syncVelocityToml(cfg, false);
		const reloaded = optBool(args, 'reload') === false
			? false
			: await reloadVelocity(cfg);

		pushEvent('proxy', 'action', `proxy registration of ${name} changed by ${ctx.actor}: ${result.changed.join(', ') || 'nothing'}`);

		return {
			instance: name,
			changed: result.changed,
			registration: cfg.instances[name]?.proxy ?? { register: false },
			velocityTomlRewritten: sync.changed,
			velocityReloaded: reloaded
		};
	},

	async proxy_sync(args, ctx) {
		requireWholeCluster(ctx, "velocity's routing");

		const cfg = await loadCluster();
		const sync = await syncVelocityToml(cfg, false);
		const reloaded = optBool(args, 'reload') === false
			? false
			: await reloadVelocity(cfg);

		pushEvent('proxy', 'action', `velocity.toml sync by ${ctx.actor}${sync.changed ? ' (updated)' : ' (no changes)'}${reloaded ? ' + reload' : ''}`);

		return {
			velocityTomlRewritten: sync.changed,
			velocityReloaded: reloaded,
			servers: sync.servers,
			tryList: sync.tryList
		};
	},

	async ports_fix(_args, ctx) {
		requireWholeCluster(ctx, 'the port pools');

		const cfg = await loadCluster();
		const lock = await loadLock();
		const ensured = await ensurePortAllocations(cfg, lock);

		await saveCluster(cfg);

		const onDisk = await readVelocityServers(cfg);
		const issues = await auditPorts(cfg, lock, onDisk);

		pushEvent('cluster', 'action', `port allocations re-ensured by ${ctx.actor}`);

		return {
			ensured: ensured.length,
			issues: issues.map((issue) => ({ kind: issue.kind, message: issue.message })),
			note: 'servers bind a moved port only after a restart'
		};
	},

	async instance_set_port(args, ctx) {
		const name = str(args, 'instance');
		const port = optInt(args, 'port') ?? 0;
		const cfg = await loadCluster();
		const inst = managedInstances(cfg)[name];

		if (!inst || name === 'proxy') {
			throw new ToolError(`"${name}" is not a backend luna manages; the proxy's own port lives in velocity.toml`);
		}

		const before = inst.port;

		try {
			await setPort(cfg, name, port);
		} catch (err) {
			throw new ToolError((err as Error).message);
		}

		await saveCluster(cfg);

		const sync = await syncVelocityToml(cfg, false);

		pushEvent(name, 'action', `game port ${before} → ${port} by ${ctx.actor}`);

		return {
			instance: name,
			from: before,
			to: port,
			velocityTomlRewritten: sync.changed,
			note: 'restart the server to bind the new port, then reload velocity (proxy_sync) so it routes there'
		};
	}
};
