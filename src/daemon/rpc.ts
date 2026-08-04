/**
 * The daemon's RPC surface: named operations mapped onto core functions
 * verbatim (DESIGN.md §4.3). Arguments and results cross the wire as plain
 * JSON — `cfg`/`lock` included — and because several core functions mutate
 * those objects in place, every op response echoes them back so the client
 * bridge can sync its caller's copies.
 *
 * Ops carrying an `instance` index are routable: when the named instance is
 * owned by a follower daemon, the dispatcher forwards the call there instead
 * of running it locally.
 */

import type { ProgressReporter } from "../core/progress";
import type { ClusterConfig, PluginsLock } from "../core/types";

import * as addonsCore from "../core/addons";
import * as adminCore from "../core/admin";
import * as cleanupCore from "../core/cleanup";
import * as configCore from "../core/config";
import * as datapacksCore from "../core/datapacks";
import * as environmentCore from "../core/environment";
import * as instancesCore from "../core/instances";
import * as lifecycleCore from "../core/lifecycle";
import * as logsCore from "../core/logs";
import * as lunaCore from "../core/luna";
import * as mcassetsCore from "../core/mcassets";
import * as packslockCore from "../core/packslock";
import * as pluginstateCore from "../core/pluginstate";
import * as pluginsCore from "../core/plugins";
import * as respackinfoCore from "../core/respackinfo";
import * as playerlistsCore from "../core/playerlists";
import * as respacksCore from "../core/respacks";
import * as portsCore from "../core/ports";
import * as proxyCore from "../core/proxy";
import * as scheduleCore from "../core/schedule";
import * as selectorCore from "../core/selector";
import * as screenCore from "../core/screen";
import * as settingsCore from "../core/settings";
import * as standardizeCore from "../core/standardize";
import * as templatesCore from "../core/templates";
import * as lunaApi from "../core/services/luna";
import * as modrinth from "../core/services/modrinth";
import * as papermc from "../core/services/papermc";
import * as providers from "../core/services/providers";

import * as events from "./events";
import * as health from "./health";
import * as upgrade from "./upgrade";
import type { DaemonRow } from "./hub";
import { daemonName, machineKey } from "./identity";
import { buildVersion } from "../version";
import * as sampler from "./sampler";

export interface OpSpec {
	// the registry spans every core signature, so the map is untyped by design;
	// type safety lives at the call sites (client bridge mirrors core's types)
	fn: (...args: never[]) => unknown;
	/** Argument index carrying the ClusterConfig — echoed back after the call */
	cfg?: number;
	/** Argument index carrying the PluginsLock — echoed back after the call */
	lock?: number;
	/** Argument index naming the target instance, for follower routing */
	instance?: number;
	/** Where a job's reporter is injected: argument index, property when the
	 *  argument is an options object (created when absent) */
	reporter?: { arg: number; prop?: string };
}

export interface OpResult {
	result: unknown;
	cfg?: unknown;
	lock?: unknown;
}

/** Instance names in cfg owned by this daemon vs. grouped by remote owner. */
function splitByOwner(
	cfg: ClusterConfig,
	names: string[],
): { local: string[]; remote: Map<string, string[]> } {
	const insts = configCore.managedInstances(cfg);
	const local: string[] = [];
	const remote = new Map<string, string[]>();

	for (const name of names) {
		const inst = insts[name];

		if (!inst) {
			continue;
		}

		const owner = name === "proxy" ? undefined : inst.daemon;

		if (!owner || owner === daemonName()) {
			local.push(name);

			continue;
		}

		if (!remote.has(owner)) {
			remote.set(owner, []);
		}

		remote.get(owner)!.push(name);
	}

	return { local, remote };
}

/**
 * Ownership-aware deploy: the local slice runs here, each follower's slice is
 * forwarded whole (the follower mirrors the pool jars it needs first). A
 * follower being offline fails only its own instances, reported as actions.
 */
async function deployRouted(
	cfg: ClusterConfig,
	lock: PluginsLock,
	opts: {
		instances?: string[];
		plugin?: string;
		reporter?: ProgressReporter;
	} = {},
): Promise<pluginsCore.DeployAction[]> {
	const wanted = opts.instances ?? Object.keys(configCore.managedInstances(cfg));
	const { local, remote } = splitByOwner(cfg, wanted);
	const actions: pluginsCore.DeployAction[] = [];

	if (local.length > 0) {
		actions.push(...(await pluginsCore.deploy(cfg, lock, { ...opts, instances: local })));
	}

	for (const [daemon, names] of remote) {
		const { reporter, ...plain } = opts;

		try {
			if (!forwardOp) {
				throw new Error("no cluster link");
			}

			const outcome = await forwardOp(
				daemon,
				"plugins.deploy",
				[cfg, lock, { ...plain, instances: names }],
				reporter,
			);

			actions.push(...(outcome.result as pluginsCore.DeployAction[]));
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);

			for (const name of names) {
				actions.push({
					instance: name,
					file: "*",
					action: "error",
					detail: `daemon ${daemon}: ${detail}`,
				});
			}
		}
	}

	return actions;
}

/**
 * Ownership-aware data pack deploy, shaped exactly like the plugin deploy
 * above: the local slice runs here, each follower's slice is forwarded whole
 * (the follower mirrors the pool zips it needs first — see follower.ts), and
 * an offline follower fails only its own instances.
 */
async function deployDataPacksRouted(
	cfg: ClusterConfig,
	lock: packslockCore.PacksLock,
	opts: {
		instances?: string[];
		pack?: string;
		groups?: datapacksCore.AddonGroups;
		reporter?: ProgressReporter;
	} = {},
): Promise<datapacksCore.DataPackDeployAction[]> {
	const wanted = opts.instances ?? Object.keys(configCore.managedInstances(cfg));
	const { local, remote } = splitByOwner(cfg, wanted);
	const actions: datapacksCore.DataPackDeployAction[] = [];

	if (local.length > 0) {
		actions.push(...(await datapacksCore.deployDataPacks(cfg, lock, { ...opts, instances: local })));
	}

	for (const [daemon, names] of remote) {
		const { reporter, ...plain } = opts;

		try {
			if (!forwardOp) {
				throw new Error("no cluster link");
			}

			const outcome = await forwardOp(
				daemon,
				"datapacks.deploy",
				[cfg, lock, { ...plain, instances: names }],
				reporter,
			);

			actions.push(...(outcome.result as datapacksCore.DataPackDeployAction[]));
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);

			for (const name of names) {
				actions.push({
					instance: name,
					file: "*",
					action: "error",
					detail: `daemon ${daemon}: ${detail}`,
				});
			}
		}
	}

	return actions;
}

/**
 * Ownership-aware data pack removal: each owner deletes the copies in its own
 * instances' worlds, then the lock entry is settled once, here. Without the
 * routing a follower-owned world would keep serving a pack the cluster
 * believes is gone.
 */
async function removeDataPackRouted(
	cfg: ClusterConfig,
	lock: packslockCore.PacksLock,
	name: string,
	fromTargets?: string[],
	groups?: datapacksCore.AddonGroups,
): Promise<{ deletedFrom: string[]; entryRemoved: boolean }> {
	const entry = lock.datapacks[name];

	if (!entry) {
		throw new Error(`unknown data pack: ${name}`);
	}

	const current = datapacksCore.datapackTargets(cfg, name, entry, groups);
	const wanted = fromTargets
		? configCore.expandTargets(cfg, fromTargets).filter((target) => current.includes(target))
		: current;

	const { local, remote } = splitByOwner(cfg, wanted);
	const deletedFrom: string[] = [];

	if (local.length > 0) {
		deletedFrom.push(...(await datapacksCore.removeDataPackFiles(cfg, lock, name, local)));
	}

	for (const [daemon, names] of remote) {
		try {
			if (!forwardOp) {
				throw new Error("no cluster link");
			}

			const outcome = await forwardOp(daemon, "datapacks.removeFiles", [cfg, lock, name, names]);

			deletedFrom.push(...(outcome.result as string[]));
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);

			throw new Error(`daemon ${daemon} could not remove ${name}: ${detail}`);
		}
	}

	const { entryRemoved } = await datapacksCore.finalizeDataPackRemoval(
		cfg,
		lock,
		name,
		wanted,
		!!fromTargets,
		groups,
	);

	return { deletedFrom, entryRemoved };
}

/**
 * `addons.applyGroups` with the data pack deploy routed to each owner. The
 * resource pack half runs here unconditionally: pack definitions live in the
 * primary's `<root>/packs` and the proxy that reads them is the primary's.
 */
async function applyAddonGroupsRouted(
	cfg: ClusterConfig,
	packs: packslockCore.PacksLock,
	groups: Parameters<typeof addonsCore.applyAddonGroups>[2],
	opts: { instances?: string[]; reporter?: ProgressReporter } = {},
): Promise<addonsCore.AddonGroupApply> {
	const progress = opts.reporter;
	const respackNode = progress?.child("Resource packs", 1);

	const respacks = await respacksCore.syncResourcePackGroups(cfg, packs, groups);

	let reloaded = false;

	if (respacks.length) {
		reloaded = await respacksCore.reloadResourcePacks(cfg);
	}

	respackNode?.complete(
		respacks.length
			? `${respacks.length} definition(s) rewritten${reloaded ? " — proxy reloaded" : ""}`
			: "nothing to change",
	);

	const datapacks = await deployDataPacksRouted(cfg, packs, {
		instances: opts.instances,
		groups,
		reporter: progress?.child("Data packs", 3),
	});

	return { respacks, reloaded, datapacks };
}

/**
 * Ownership-aware status of one instance: probed on its owner, so a follower's
 * screen and java process are seen by the daemon that has them. An unreachable
 * owner reads as "unknown" rather than a false "stopped".
 */
export async function getStatusRouted(
	cfg: ClusterConfig,
	name: string,
): Promise<instancesCore.InstanceStatus> {
	const inst = configCore.managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(`unknown instance: ${name}`);
	}

	const owner = name === "proxy" ? undefined : inst.daemon;

	if (!owner || owner === daemonName()) {
		return await instancesCore.getStatus(cfg, name);
	}

	try {
		if (!forwardOp) {
			throw new Error("no cluster link");
		}

		const outcome = await forwardOp(owner, "instances.getStatus", [cfg, name]);

		return outcome.result as instancesCore.InstanceStatus;
	} catch {
		return { name, inst, state: "unknown" };
	}
}

/**
 * Ownership-aware status sweep: local instances are probed here, remote ones on
 * their owner. An unreachable follower's instances read as "unknown" rather
 * than a false "stopped".
 */
export async function getAllStatusesRouted(
	cfg: ClusterConfig,
): Promise<instancesCore.InstanceStatus[]> {
	const insts = configCore.managedInstances(cfg);
	const { local, remote } = splitByOwner(cfg, Object.keys(insts));

	const results = new Map<string, instancesCore.InstanceStatus>();

	await Promise.all(
		local.map(async (name) => {
			results.set(name, await instancesCore.getStatus(cfg, name));
		}),
	);

	await Promise.all(
		[...remote.entries()].map(async ([daemon, names]) => {
			for (const name of names) {
				try {
					if (!forwardOp) {
						throw new Error("no cluster link");
					}

					const outcome = await forwardOp(daemon, "instances.getStatus", [cfg, name]);

					results.set(name, outcome.result as instancesCore.InstanceStatus);
				} catch {
					results.set(name, { name, inst: insts[name]!, state: "unknown" });
				}
			}
		}),
	);

	return Object.keys(insts)
		.map((name) => results.get(name))
		.filter((status): status is instancesCore.InstanceStatus => status !== undefined);
}

// -- server selector -----------------------------------------------------------
// The primary's name is what `server-info.host-name` says for every instance it
// owns, and it lives in daemon/, so core takes it as an argument and the wrappers
// below supply it.

function selectorDraftRouted(cfg: ClusterConfig): selectorCore.SelectorDraft {
	return selectorCore.draftFromCluster(cfg, daemonName());
}

function selectorPreviewRouted(cfg: ClusterConfig): string {
	return selectorCore.buildServersYml(cfg, daemonName());
}

async function selectorStatusRouted(cfg: ClusterConfig): Promise<selectorCore.SelectorState> {
	return await selectorCore.selectorStatus(cfg, daemonName());
}

async function selectorImportRouted(
	cfg: ClusterConfig,
	opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<selectorCore.ImportReport> {
	return await selectorCore.importServersYml(cfg, daemonName(), {
		...opts,
		write: async (updated) => await configCore.saveCluster(updated),
	});
}

async function selectorApplyRouted(
	cfg: ClusterConfig,
	opts: { reporter?: ProgressReporter } = {},
): Promise<selectorCore.ApplyResult> {
	return await selectorCore.applySelector(cfg, daemonName(), opts);
}

/** Route instance creation to the daemon named in the options. */
async function createInstanceRouted(
	cfg: ClusterConfig,
	name: string,
	opts: adminCore.CreateOptions,
): Promise<adminCore.CreateResult> {
	if (opts.daemon && opts.daemon !== daemonName()) {
		if (!forwardOp) {
			throw new Error(`instance targets daemon "${opts.daemon}" but no follower link exists`);
		}

		const { reporter, ...plain } = opts;
		const outcome = await forwardOp(
			opts.daemon,
			"admin.createInstance",
			[cfg, name, plain],
			reporter,
		);

		// the follower mutated its copy of cfg — echo it into ours so the
		// caller's registry entry (and its save) are correct
		Object.assign(cfg, outcome.cfg as ClusterConfig);

		return outcome.result as adminCore.CreateResult;
	}

	return await adminCore.createInstance(cfg, name, opts);
}

/**
 * Route adoption to the daemon named in the options. The instance is not in the
 * registry yet, so the usual owner routing has nothing to key on — the target
 * comes from the request, exactly as it does for creation. It has to run there:
 * the directory being adopted only exists on that machine's disk.
 */
async function adoptInstanceRouted(
	cfg: ClusterConfig,
	name: string,
	opts: adminCore.AdoptOptions = {},
): Promise<adminCore.AdoptResult> {
	if (opts.daemon && opts.daemon !== daemonName()) {
		if (!forwardOp) {
			throw new Error(`instance targets daemon "${opts.daemon}" but no follower link exists`);
		}

		const outcome = await forwardOp(opts.daemon, "admin.adoptInstance", [cfg, name, opts]);

		// the follower mutated its copy of cfg — echo it into ours so the
		// caller's registry entry (and its save) are correct
		Object.assign(cfg, outcome.cfg as ClusterConfig);

		return outcome.result as adminCore.AdoptResult;
	}

	return await adminCore.adoptInstance(cfg, name, opts);
}

// -- ports ---------------------------------------------------------------------
// `ss` only sees its own host and a plugin's config file only exists on the
// machine running it, so the port map is gathered per machine: this daemon looks
// at itself and every other owner is asked about its own.

/** Machines owning at least one instance, other than this daemon's own. */
function remoteMachines(cfg: ClusterConfig): string[] {
	const mine = machineKey();

	return portsCore
		.machineInfo(cfg)
		.filter((info) => info.machine !== mine && info.instances.length > 0)
		.map((info) => info.machine);
}

/**
 * Ask one machine's daemon for something about its own ports. A machine we have
 * no link to is not an error — the caller renders "unknown" for it, which is the
 * truth, rather than a confident "not bound".
 */
async function askMachine(machine: string, op: string, args: unknown[]): Promise<unknown | null> {
	try {
		if (!forwardOp) {
			throw new Error("no cluster link");
		}

		const outcome = await forwardOp(machine, op, args);

		return outcome.result;
	} catch {
		return null;
	}
}

/**
 * The list form of `askMachine`. A follower one build behind may not have the op
 * at all, or may answer with an older shape — `listeningPorts` used to return a
 * Map, and a Map crosses JSON as `{}`. Only a real array is an answer; anything
 * else is "not known from here", which is what the callers already render.
 */
async function askMachineList<T>(
	machine: string,
	op: string,
	args: unknown[],
): Promise<T[] | null> {
	const answer = await askMachine(machine, op, args);

	return Array.isArray(answer) ? (answer as T[]) : null;
}

/** The port map with bind state from every machine that owns instances. */
async function collectPortRowsRouted(
	cfg: ClusterConfig,
	lock: PluginsLock,
): Promise<portsCore.PortRow[]> {
	const probes: portsCore.MachineProbe[] = [
		{ machine: machineKey(), listening: await portsCore.listeningPorts() },
	];

	await Promise.all(
		remoteMachines(cfg).map(async (machine) => {
			const listening = await askMachineList<string>(machine, "ports.listeningPorts", []);

			probes.push({ machine, listening });
		}),
	);

	return await portsCore.collectPortRows(cfg, lock, probes);
}

/** The port audit, with each machine's config drift read on that machine. */
async function auditPortsRouted(
	cfg: ClusterConfig,
	lock: PluginsLock,
	velocityServers: Record<string, string>,
): Promise<portsCore.PortIssue[]> {
	const issues = await portsCore.auditPorts(cfg, lock, velocityServers, machineKey());

	await Promise.all(
		remoteMachines(cfg).map(async (machine) => {
			const drift = await askMachineList<portsCore.PortIssue>(
				machine,
				"ports.auditConfigDrift",
				[cfg, lock, machine],
			);

			if (drift === null) {
				issues.push({
					kind: "unchecked",
					machine,
					message: `${portsCore.machineLabel(machine)} is unreachable — its plugin port configuration was not checked`,
				});

				return;
			}

			issues.push(...drift);
		}),
	);

	return issues;
}

/**
 * Allocate every plugin port from the owning machine's pools here, then have each
 * other owner write the numbers into its own config files. Allocation is registry
 * work and stays on one daemon, so two machines can never hand out the same port
 * for the same plugin at the same time.
 */
async function ensurePortAllocationsRouted(
	cfg: ClusterConfig,
	lock: PluginsLock,
): Promise<portsCore.PortAllocation[]> {
	const others = remoteMachines(cfg);

	// adopt first, allocate second: a port another machine's plugin config already
	// binds is the port that plugin answers on, and allocating over the top of it
	// would move a working service without anybody asking for it
	await Promise.all(
		others.map(async (machine) => {
			const onDisk = await askMachineList<{ instance: string; key: string; port: number }>(
				machine,
				"ports.readPortConfigs",
				[cfg, lock, machine],
			);

			for (const found of onDisk ?? []) {
				const inst = configCore.managedInstances(cfg)[found.instance];

				if (!inst) {
					continue;
				}

				inst.ports ??= {};
				inst.ports[found.key] ??= found.port;
			}
		}),
	);

	const results = await portsCore.ensurePortAllocations(cfg, lock, machineKey());

	await Promise.all(
		others.map(async (machine) => {
			const written = await askMachineList<portsCore.PortAllocation>(
				machine,
				"ports.writePortConfigs",
				[cfg, lock, machine],
			);

			results.push(...(written ?? []));
		}),
	);

	return results;
}

/** Route a directory inspection to the daemon whose disk holds the directory. */
async function inspectInstanceDirRouted(
	dir: string,
	daemon?: string,
): Promise<adminCore.InstanceDetection> {
	if (daemon && daemon !== daemonName()) {
		if (!forwardOp) {
			throw new Error(`inspection targets daemon "${daemon}" but no follower link exists`);
		}

		const outcome = await forwardOp(daemon, "admin.inspectInstanceDir", [dir]);

		return outcome.result as adminCore.InstanceDetection;
	}

	return await adminCore.inspectInstanceDir(dir);
}

/**
 * Provider behind `daemon.listDaemons` — replaced by the hub on a primary.
 * Without a hub there are no live links to report, so this daemon describes
 * itself from its own health and everything else from the registry alone.
 */
let daemonsProvider: () => Promise<unknown> = async () => {
	const cfg = await configCore.loadCluster();
	const self = daemonName();
	const own = health.currentHealth() ?? null;

	const selfRow: DaemonRow = {
		name: self,
		mode: "follower",
		host: null,
		addresses: health.hostAddresses(),
		online: true,
		version: buildVersion(),
		protocol: null,
		outdated: false,
		root: configCore.root(),
		connectedAt: null,
		lastSeen: new Date().toISOString(),
		lastBeatMs: null,
		latencyMs: null,
		uptimeMs: null,
		health: own,
		checks: [],
		reach: null,
		instances: Object.entries(cfg.instances)
			.filter(([, inst]) => inst.daemon === self)
			.map(([instName]) => instName),
	};

	const others: DaemonRow[] = Object.entries(cfg.daemons ?? {})
		.filter(([name]) => name !== self)
		.map(([name, reg]) => ({
			name,
			mode: "follower",
			host: reg.host,
			addresses: reg.addresses ?? [],
			online: false,
			version: reg.version ?? null,
			protocol: null,
			outdated: false,
			root: reg.root ?? null,
			connectedAt: null,
			lastSeen: reg.lastSeen ?? null,
			lastBeatMs: null,
			latencyMs: null,
			uptimeMs: null,
			health: null,
			checks: [],
			reach: null,
			instances: Object.entries(cfg.instances)
				.filter(([, inst]) => inst.daemon === name)
				.map(([instName]) => instName),
		}));

	return [selfRow, ...others];
};

/** Provider behind `daemon.daemonDetail` — replaced by the hub on a primary. */
let daemonDetailProvider: (name: string) => Promise<unknown> = async (name: string) => {
	const rows = (await daemonsProvider()) as DaemonRow[];
	const row = rows.find((entry) => entry.name === name);

	if (!row) {
		return null;
	}

	return {
		row,
		history: row.name === daemonName() ? health.healthHistory() : [],
		events: events.getEvents(events.daemonEventKey(name)),
	};
};

/**
 * Provider behind `daemon.upgradeDaemon` — replaced by the hub on a primary,
 * which is the only role that can reach another daemon.
 */
let upgradeSender: (name: string, force: boolean) => Promise<unknown> = async () => {
	throw new Error("only the primary daemon can upgrade another daemon");
};

/** Swap in the hub's follower upgrade sender. */
export function setUpgradeSender(
	sender: (name: string, force: boolean) => Promise<unknown>,
): void {
	upgradeSender = sender;
}

/**
 * Provider behind `daemon.checkDaemonUpgrade`. Without a hub the only daemon
 * this process can ask is itself, which is the honest answer for a follower
 * queried through its own socket.
 */
let checkSender: (name: string, refresh: boolean) => Promise<unknown> = async (
	name: string,
	refresh: boolean,
) => {
	if (name !== daemonName()) {
		throw new Error("only the primary daemon can check another daemon for upgrades");
	}

	return await upgrade.checkUpgrade(refresh);
};

/** Swap in the hub's fleet-wide upgrade check. */
export function setCheckSender(
	sender: (name: string, refresh: boolean) => Promise<unknown>,
): void {
	checkSender = sender;
}

/** Swap in the hub's live daemons listing. */
export function setDaemonsProvider(provider: () => Promise<unknown>): void {
	daemonsProvider = provider;
}

/** Swap in the hub's per-daemon detail view. */
export function setDaemonDetailProvider(provider: (name: string) => Promise<unknown>): void {
	daemonDetailProvider = provider;
}

/** Every operation the daemon serves, `<module>.<function>`. */
export const OPS: Record<string, OpSpec> = {
	// -- state files ---------------------------------------------------------
	"config.loadCluster": { fn: configCore.loadCluster },
	"config.saveCluster": { fn: configCore.saveCluster, cfg: 0 },
	"config.loadLock": { fn: configCore.loadLock },
	"config.saveLock": { fn: configCore.saveLock, lock: 0 },

	// -- instance administration ----------------------------------------------
	"admin.detectMcVersion": { fn: adminCore.detectMcVersion },
	"admin.createInstance": {
		fn: createInstanceRouted,
		cfg: 0,
		reporter: { arg: 2, prop: "reporter" },
	},
	"admin.adoptInstance": { fn: adoptInstanceRouted, cfg: 0 },
	"admin.inspectInstanceDir": { fn: inspectInstanceDirRouted },
	"admin.setVersion": { fn: adminCore.setVersion, cfg: 0, instance: 1, reporter: { arg: 3 } },
	"admin.setPort": { fn: adminCore.setPort, cfg: 0 },
	"admin.getServerProperty": { fn: adminCore.getServerProperty, cfg: 0, instance: 1 },
	"admin.setServerProperty": { fn: adminCore.setServerProperty, cfg: 0, instance: 1 },
	"admin.deleteInstance": {
		fn: adminCore.deleteInstance,
		cfg: 0,
		instance: 1,
		reporter: { arg: 3 },
	},

	// -- instance lifecycle ---------------------------------------------------
	"instances.writeRunScript": { fn: instancesCore.writeRunScript, cfg: 0, instance: 1 },
	"instances.getStatus": { fn: instancesCore.getStatus, cfg: 0, instance: 1 },
	"instances.getAllStatuses": { fn: getAllStatusesRouted, cfg: 0 },
	"instances.startInstance": { fn: instancesCore.startInstance, cfg: 0, instance: 1 },
	"instances.stopInstance": { fn: instancesCore.stopInstance, cfg: 0, instance: 1 },
	"instances.sendCommand": { fn: instancesCore.sendCommand, cfg: 0, instance: 1 },

	// -- player access lists (whitelist / ops / bans; run on the instance's owner) --
	"playerlists.get": { fn: playerlistsCore.getAccessLists, cfg: 0, instance: 1 },
	"playerlists.apply": { fn: playerlistsCore.applyAccessChange, cfg: 0, instance: 1 },
	"playerlists.setWhitelist": { fn: playerlistsCore.setWhitelistEnabled, cfg: 0, instance: 1 },

	// -- tracked lifecycle (log-derived live progress; run as jobs) -------------
	"lifecycle.startTracked": {
		fn: lifecycleCore.startInstanceTracked,
		cfg: 0,
		instance: 1,
		reporter: { arg: 2 },
	},
	"lifecycle.stopTracked": {
		fn: lifecycleCore.stopInstanceTracked,
		cfg: 0,
		instance: 1,
		reporter: { arg: 2 },
	},
	"lifecycle.restartTracked": {
		fn: lifecycleCore.restartInstanceTracked,
		cfg: 0,
		instance: 1,
		reporter: { arg: 2 },
	},

	// -- logs (read on the machine that owns the instance) ---------------------
	"logs.readInstanceLogs": { fn: logsCore.readInstanceLogs, cfg: 0, instance: 1 },

	// -- plugins ---------------------------------------------------------------
	"plugins.scan": { fn: pluginsCore.scan, cfg: 0, lock: 1 },
	"plugins.getVersionsForEntry": { fn: pluginsCore.getVersionsForEntry },
	"plugins.checkUpdates": { fn: pluginsCore.checkUpdates, cfg: 0, lock: 1 },
	"plugins.applyUpdate": { fn: pluginsCore.applyUpdate, lock: 0 },
	"plugins.pinVersion": { fn: pluginsCore.pinVersion, cfg: 0, lock: 1 },
	"plugins.ensureVariantForMc": { fn: pluginsCore.ensureVariantForMc, lock: 0 },
	"plugins.deploy": { fn: deployRouted, cfg: 0, lock: 1, reporter: { arg: 2, prop: "reporter" } },
	"plugins.installFromProvider": { fn: pluginsCore.installFromProvider, cfg: 0, lock: 1 },
	"plugins.adopt": { fn: pluginsCore.adopt, cfg: 0, lock: 1, instance: 2 },
	"plugins.uploadJar": { fn: pluginsCore.uploadJar, cfg: 0, lock: 1 },
	"plugins.removePlugin": { fn: pluginsCore.removePlugin, cfg: 0, lock: 1 },
	"standardize.standardizeNaming": {
		fn: standardizeCore.standardizeNaming,
		cfg: 0,
		lock: 1,
		reporter: { arg: 2, prop: "reporter" },
	},

	// -- packs (resource packs + data packs) ------------------------------------
	"packslock.loadPacksLock": { fn: packslockCore.loadPacksLock },
	"packslock.savePacksLock": { fn: packslockCore.savePacksLock, lock: 0 },
	"respacks.listResourcePacks": { fn: respacksCore.listResourcePacks, cfg: 0, lock: 1 },
	"respacks.updateResourcePack": { fn: respacksCore.updateResourcePack, cfg: 0, lock: 1 },
	"respacks.addResourcePackFile": { fn: respacksCore.addResourcePackFile, cfg: 0, lock: 1 },
	"respacks.installFromProvider": { fn: respacksCore.installResourcePackFromProvider, cfg: 0, lock: 1 },
	"respacks.checkUpdates": { fn: respacksCore.checkResourcePackUpdates, lock: 0 },
	"respacks.applyUpdate": { fn: respacksCore.applyResourcePackUpdate, lock: 0 },
	"respacks.removeResourcePack": { fn: respacksCore.removeResourcePack, cfg: 0, lock: 1 },
	"respacks.setForInstance": { fn: respacksCore.setResourcePackForInstance, cfg: 0, lock: 1 },
	"respacks.reload": { fn: respacksCore.reloadResourcePacks, cfg: 0 },
	"respacks.syncGroups": { fn: respacksCore.syncResourcePackGroups, cfg: 0, lock: 1 },
	"respacks.detail": { fn: respackinfoCore.resourcePackDetail, cfg: 0, lock: 1 },
	"respacks.serveConfig": { fn: respackinfoCore.packServeConfig, cfg: 0 },
	"respacks.holders": { fn: respackinfoCore.packHolders },
	"respacks.loadFailures": { fn: respackinfoCore.packLoadFailures, cfg: 0 },
	"respacks.resolution": { fn: respackinfoCore.packResolution },
	"datapacks.list": { fn: datapacksCore.listDataPacks, cfg: 0, lock: 1 },
	"datapacks.instanceReport": {
		fn: datapacksCore.instanceDataPackReport,
		cfg: 0,
		lock: 1,
		instance: 2,
	},
	"datapacks.deploy": {
		fn: deployDataPacksRouted,
		cfg: 0,
		lock: 1,
		reporter: { arg: 2, prop: "reporter" },
	},
	"datapacks.installFromProvider": { fn: datapacksCore.installDataPackFromProvider, cfg: 0, lock: 1 },
	"datapacks.checkUpdates": { fn: datapacksCore.checkDataPackUpdates, cfg: 0, lock: 1 },
	"datapacks.applyUpdate": { fn: datapacksCore.applyDataPackUpdate, lock: 0 },
	"datapacks.addFile": { fn: datapacksCore.addDataPackFile, cfg: 0, lock: 1 },
	"datapacks.adopt": { fn: datapacksCore.adoptDataPack, cfg: 0, lock: 1, instance: 2 },
	"datapacks.remove": { fn: removeDataPackRouted, cfg: 0, lock: 1 },
	// the per-owner slice of a routed removal — the primary calls it on each
	// follower, never a client
	"datapacks.removeFiles": { fn: datapacksCore.removeDataPackFiles, cfg: 0, lock: 1 },
	"addons.applyGroups": {
		fn: applyAddonGroupsRouted,
		cfg: 0,
		lock: 1,
		reporter: { arg: 3, prop: "reporter" },
	},
	// reads both lockfiles and renames files inside the instance, so it runs on
	// the owner; the lockfile half is pure and stays with the caller
	"addons.adoptInstanceAddons": { fn: addonsCore.adoptInstanceAddons, cfg: 0, instance: 3 },
	"providers.search": { fn: providers.searchProvider },

	// -- plugin runtime state ---------------------------------------------------
	"pluginstate.ensureAliases": { fn: pluginstateCore.ensureAliases, lock: 0 },
	"pluginstate.readBootSession": { fn: pluginstateCore.readBootSession, cfg: 0, instance: 1 },
	"pluginstate.instancePluginReport": {
		fn: pluginstateCore.instancePluginReport,
		cfg: 0,
		lock: 1,
		instance: 2,
	},
	"pluginstate.removeInstanceJars": {
		fn: pluginstateCore.removeInstanceJars,
		cfg: 0,
		lock: 1,
		instance: 2,
	},

	// -- luna pipeline -----------------------------------------------------------
	"luna.listModules": { fn: lunaCore.listModules },
	"luna.buildStamp": { fn: lunaCore.buildStamp },
	"luna.build": { fn: lunaCore.build },
	"luna.artifacts": { fn: lunaCore.artifacts },
	"luna.strayArtifacts": { fn: lunaCore.strayArtifacts },
	"luna.sync": { fn: lunaCore.sync, lock: 0 },
	"luna.status": { fn: lunaCore.status, cfg: 0, lock: 1 },

	// -- ports & proxy -------------------------------------------------------------
	"ports.ensurePortAllocations": { fn: ensurePortAllocationsRouted, cfg: 0, lock: 1 },
	"ports.writePortConfigs": { fn: portsCore.writePortConfigs, cfg: 0, lock: 1 },
	"ports.readPortConfigs": { fn: portsCore.readPortConfigs, cfg: 0, lock: 1 },
	"ports.listeningPorts": { fn: portsCore.listeningPorts },
	"ports.auditPorts": { fn: auditPortsRouted, cfg: 0, lock: 1 },
	"ports.auditConfigDrift": { fn: portsCore.auditConfigDrift, cfg: 0, lock: 1 },
	"ports.collectPortRows": { fn: collectPortRowsRouted, cfg: 0, lock: 1 },
	"proxy.syncVelocityToml": { fn: proxyCore.syncVelocityToml, cfg: 0 },
	"proxy.readVelocityServers": { fn: proxyCore.readVelocityServers, cfg: 0 },
	"proxy.readForwardingSecret": { fn: proxyCore.readForwardingSecret, cfg: 0 },

	// -- settings, templates, environment ------------------------------------------
	"settings.readServerProperties": { fn: settingsCore.readServerProperties, cfg: 0, instance: 1 },
	"settings.applySettings": {
		fn: settingsCore.applySettings,
		cfg: 0,
		instance: 1,
		reporter: { arg: 3 },
	},
	"templates.applyTemplates": { fn: templatesCore.applyTemplates, cfg: 0, lock: 1, instance: 2 },
	"environment.loadEnv": { fn: environmentCore.loadEnv },
	"environment.saveEnv": { fn: environmentCore.saveEnv },
	// instance-routed so machine-dependent builtins (LUNA_PROXY_HOST) resolve on
	// the daemon whose instances will actually read the value
	"environment.builtinVars": { fn: environmentCore.builtinVars, cfg: 0, instance: 1 },
	"environment.resolveVars": { fn: environmentCore.resolveVars, cfg: 0, instance: 2 },

	// -- server selector -------------------------------------------------------------
	// cluster.json is primary-owned, so none of these route to a follower; the
	// proxy the reload targets is the primary's too.
	"selector.draft": { fn: selectorDraftRouted, cfg: 0 },
	"selector.preview": { fn: selectorPreviewRouted, cfg: 0 },
	"selector.state": { fn: selectorStatusRouted, cfg: 0 },
	"selector.import": { fn: selectorImportRouted, cfg: 0 },
	"selector.apply": { fn: selectorApplyRouted, cfg: 0, reporter: { arg: 1, prop: "reporter" } },

	// -- minecraft client assets -----------------------------------------------------
	"mcassets.state": { fn: mcassetsCore.assetState, cfg: 0 },
	"mcassets.ensure": { fn: mcassetsCore.ensureMcAssets, cfg: 0, reporter: { arg: 1, prop: "reporter" } },

	// -- schedules -------------------------------------------------------------------
	"schedule.loadSchedules": { fn: scheduleCore.loadSchedules },
	"schedule.saveSchedules": { fn: scheduleCore.saveSchedules },

	// -- cleanup ----------------------------------------------------------------------
	"cleanup.diskUsage": { fn: cleanupCore.diskUsage },
	"cleanup.buildPlan": { fn: cleanupCore.buildPlan, cfg: 0 },
	"cleanup.execute": { fn: cleanupCore.execute },

	// -- screen (session queries; attaching stays local to the CLI) --------------------
	"screen.listSessions": { fn: screenCore.listSessions },
	"screen.sessionExists": { fn: screenCore.sessionExists },

	// -- external services ---------------------------------------------------------------
	"modrinth.lookupByHash": { fn: modrinth.lookupByHash },
	"providers.status": { fn: providers.providerStatus },
	"providers.getProject": { fn: providers.getProject },
	"providers.getVersions": { fn: providers.getVersions },
	"papermc.latestBuild": { fn: papermc.latestBuild },
	"papermc.listVersions": { fn: papermc.listVersions },
	"lunaApi.dashboard": { fn: lunaApi.dashboard },
	"lunaApi.backend": { fn: lunaApi.backend },
	"lunaApi.players": { fn: lunaApi.players },
	"lunaApi.playerHistory": { fn: lunaApi.playerHistory },
	"lunaApi.runCommand": { fn: lunaApi.runCommand },
	"lunaApi.broadcast": { fn: lunaApi.broadcast },
	"lunaApi.kick": { fn: lunaApi.kick },
	"lunaApi.message": { fn: lunaApi.message },
	"lunaApi.transfer": { fn: lunaApi.transfer },
	"lunaApi.registeredPlayers": { fn: lunaApi.registeredPlayers },
	"lunaApi.registeredPlayer": { fn: lunaApi.registeredPlayer },
	"lunaApi.playerSessions": { fn: lunaApi.playerSessions },
	"lunaApi.playerChat": { fn: lunaApi.playerChat },
	"lunaApi.playerModeration": { fn: lunaApi.playerModeration },
	"lunaApi.recordModeration": { fn: lunaApi.recordModeration },
	"lunaApi.permissionGroups": { fn: lunaApi.permissionGroups },
	"lunaApi.permissionGroup": { fn: lunaApi.permissionGroup },
	"lunaApi.createPermissionGroup": { fn: lunaApi.createPermissionGroup },
	"lunaApi.deletePermissionGroup": { fn: lunaApi.deletePermissionGroup },
	"lunaApi.editGroupNode": { fn: lunaApi.editGroupNode },
	"lunaApi.editGroupMeta": { fn: lunaApi.editGroupMeta },
	"lunaApi.permissionUser": { fn: lunaApi.permissionUser },
	"lunaApi.editUserNode": { fn: lunaApi.editUserNode },
	"lunaApi.editUserGroups": { fn: lunaApi.editUserGroups },
	"lunaApi.skinInfo": { fn: lunaApi.skinInfo },
	"lunaApi.setSkin": { fn: lunaApi.setSkin },
	"lunaApi.authAccount": { fn: lunaApi.authAccount },
	"lunaApi.setAuth": { fn: lunaApi.setAuth },

	// -- daemon-native (sampler, events) ---------------------------------------------------
	"daemon.listStatuses": { fn: sampler.listStatuses },
	// deliberately NOT instance-routed: the serialized status carries the proxy's
	// LunaCore telemetry, and only the primary can see that. The core probe
	// inside does route to the owner (getStatusRouted), so a follower instance's
	// process state is still read where the process actually is.
	"daemon.instanceStatus": { fn: sampler.instanceStatus },
	"daemon.getHistory": { fn: sampler.getHistory, instance: 0 },
	"daemon.markTransition": { fn: sampler.markTransition },
	"daemon.clearTransition": { fn: sampler.clearTransition },
	"daemon.readHostMemMb": { fn: sampler.readHostMemMb },
	"daemon.lunaProblem": { fn: sampler.lunaProblem },
	"daemon.pushEvent": { fn: events.pushEvent },
	"daemon.getEvents": { fn: events.getEvents },
	"daemon.listDaemons": { fn: () => daemonsProvider() },
	"daemon.daemonDetail": { fn: (name: string) => daemonDetailProvider(name) },
	"daemon.health": { fn: health.currentHealth },
	"daemon.binaryMeta": { fn: upgrade.localBinaryMeta },
	// both run on the daemon they describe; the primary forwards them there
	"daemon.selfUpgrade": { fn: upgrade.selfUpgrade },
	"daemon.checkUpgrade": { fn: upgrade.checkUpgrade },
	"daemon.upgradeDaemon": {
		fn: (name: string, force?: boolean) => upgradeSender(name, force ?? false),
	},
	"daemon.checkDaemonUpgrade": {
		fn: (name: string, refresh?: boolean) => checkSender(name, refresh ?? false),
	},
	"daemon.healthHistory": { fn: health.healthHistory },
};

/**
 * Forward hook, installed by the hub when this daemon is a primary with
 * followers connected. Given an op and its args, returns the owning daemon's
 * name when the op must run remotely, undefined to run it here.
 */
export let resolveRemote:
	| ((op: string, spec: OpSpec, args: unknown[]) => string | undefined)
	| undefined;

/** Forwarder, installed alongside resolveRemote. */
export let forwardOp:
	| ((daemon: string, op: string, args: unknown[], reporter?: ProgressReporter) => Promise<OpResult>)
	| undefined;

/** Install the routing hooks (hub on a primary; nothing on a follower). */
export function installRouting(
	resolve: typeof resolveRemote,
	forward: typeof forwardOp,
): void {
	resolveRemote = resolve;
	forwardOp = forward;
}

/**
 * Execute one operation: inject the job reporter when the op takes one, run the
 * core function (or forward it to the owning follower), and echo back the
 * cfg/lock arguments so in-place mutations survive the wire.
 */
export async function runOp(
	op: string,
	args: unknown[],
	reporter?: ProgressReporter,
): Promise<OpResult> {
	const spec = OPS[op];

	if (!spec) {
		throw new Error(`unknown operation: ${op}`);
	}

	if (resolveRemote && forwardOp) {
		const remote = resolveRemote(op, spec, args);

		if (remote) {
			return await forwardOp(remote, op, args, reporter);
		}
	}

	if (spec.reporter && reporter) {
		const { arg, prop } = spec.reporter;

		if (prop) {
			const options = (args[arg] ?? {}) as Record<string, unknown>;

			options[prop] = reporter;
			args[arg] = options;
		} else {
			args[arg] = reporter;
		}
	}

	const result = await (spec.fn as (...fnArgs: unknown[]) => unknown)(...args);

	const out: OpResult = { result };

	if (spec.cfg !== undefined) {
		out.cfg = args[spec.cfg];
	}

	if (spec.lock !== undefined) {
		out.lock = args[spec.lock];
	}

	return out;
}
