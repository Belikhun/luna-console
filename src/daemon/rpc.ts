// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The daemon's RPC surface: named operations mapped onto core functions
 * verbatim (DESIGN.md §4.3). Arguments and results cross the wire as plain
 * JSON; `cfg`/`lock` included; and because several core functions mutate
 * those objects in place, every op response echoes them back so the client
 * bridge can sync its caller's copies.
 *
 * Ops carrying an `instance` index are routable: when the named instance is
 * owned by a follower daemon, the dispatcher forwards the call there instead
 * of running it locally.
 */

import type { ProgressReporter } from "../core/progress";
import { t } from "../shared/i18n";
import { PROTOCOL_VERSION } from "../shared/protocol";
import type {
	AvailableRuntime,
	ClusterConfig,
	InstalledRuntime,
	LocalRuntimeInventory,
	MachineRuntimes,
	PluginsLock,
	RuntimeVendor,
	Software,
} from "../core/types";

import * as accountsCore from "../core/accounts";
import * as addonsCore from "../core/addons";
import * as adminCore from "../core/admin";
import * as backupsCore from "../core/backups";
import * as cleanupCore from "../core/cleanup";
import * as configCore from "../core/config";
import * as configfilesCore from "../core/configfiles";
import * as datapacksCore from "../core/datapacks";
import * as environmentCore from "../core/environment";
import * as instancesCore from "../core/instances";
import * as journalCore from "../core/journal";
import * as lifecycleCore from "../core/lifecycle";
import * as logsCore from "../core/logs";
import * as lunaCore from "../core/luna";
import * as mcassetsCore from "../core/mcassets";
import * as packslockCore from "../core/packslock";
import * as pluginstateCore from "../core/pluginstate";
import * as pluginsCore from "../core/plugins";
import * as publicsiteCore from "../core/publicsite";
import * as uptimeCore from "../core/uptime";
import * as respackinfoCore from "../core/respackinfo";
import * as playerlistsCore from "../core/playerlists";
import * as respacksCore from "../core/respacks";
import * as portsCore from "../core/ports";
import * as proxyCore from "../core/proxy";
import * as runtimesCore from "../core/runtimes";
import * as scheduleCore from "../core/schedule";
import * as selectorCore from "../core/selector";
import * as softwareCore from "../core/software";
import * as stagingCore from "../core/staging";
import * as screenCore from "../core/screen";
import * as worldCore from "../core/world";
import * as worldopsCore from "../core/worldops";
import * as settingsCore from "../core/settings";
import * as settingsApply from "../core/settingsapply";
import * as standardizeCore from "../core/standardize";
import * as templatesCore from "../core/templates";
import * as lunaApi from "../core/services/luna";
import * as modrinth from "../core/services/modrinth";
import * as softwareRegistry from "../core/services/software/registry";
import * as providers from "../core/services/providers";

import * as events from "./events";
import * as health from "./health";
import * as upgrade from "./upgrade";
import * as uptimeRecorder from "./uptime";
import type { DaemonRow } from "./hub";
import { daemonName, machineKey } from "./identity";
import { buildVersion } from "../version";
import * as sampler from "./sampler";

export interface OpSpec {
	// the registry spans every core signature, so the map is untyped by design;
	// type safety lives at the call sites (client bridge mirrors core's types)
	fn: (...args: never[]) => unknown;
	/** Argument index carrying the ClusterConfig; echoed back after the call */
	cfg?: number;
	/** Argument index carrying the PluginsLock; echoed back after the call */
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
				throw new Error(t("daemon.noClusterLink"));
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
 * Ownership-aware update sweep. The check and the downloads are this daemon's
 * own work, because the pool lives here; only the deploy phase has instances to
 * reach, so that is where the routed pair is substituted for core's local one.
 */
async function updateRouted(
	cfg: ClusterConfig,
	lock: PluginsLock,
	opts: {
		names?: string[];
		deploy?: boolean;
		reporter?: ProgressReporter;
	} = {},
): Promise<pluginsCore.UpdateOutcome> {
	return await pluginsCore.updatePlugins(cfg, lock, opts, {
		deploy: deployRouted,
		ensurePorts: ensurePortAllocationsRouted,
	});
}

/**
 * Ownership-aware data pack deploy, shaped exactly like the plugin deploy
 * above: the local slice runs here, each follower's slice is forwarded whole
 * (the follower mirrors the pool zips it needs first; see follower.ts), and
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
				throw new Error(t("daemon.noClusterLink"));
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
 * The world and backup ops, adapted to the routing convention.
 *
 * Every one of these acts on files that live wherever the instance does, so
 * they must reach the owning daemon, and the dispatcher routes on an argument
 * index naming the instance. The core functions were written to their own
 * natural signatures - a backup is identified by its id, not by an instance -
 * so these wrappers exist purely to put the instance name where the router
 * looks for it, and to check it against the record afterwards.
 */
/**
 * Read a staged archive against a target that has no instance yet.
 *
 * The launch wizard validates a world before the instance it is for exists, so
 * there is nothing to route on and nothing to read a level name from; the form's
 * own choices are the target. Deliberately unrouted: an upload always lands on
 * the primary, so the archive is here, and only the install has to travel.
 */
async function scanArchiveFor(
	token: string,
	software: Software,
	mcVersion: string | undefined,
	level: string,
): Promise<worldCore.WorldScan & { plan: worldCore.WorldImportPlan }> {
	const path = await localStagePath(token);
	const scan = await worldCore.scanWorldArchive(path);
	const traits = softwareCore.traitsOf(software, mcVersion);
	const plan = worldCore.planWorldImport(scan, {
		level: level.trim() || traits.levelName?.fallback || "world",
		layout: traits.worldLayout ?? "nested",
		mcVersion,
	});

	return { ...scan, plan };
}

async function scanStagedWorld(
	cfg: ClusterConfig,
	instance: string,
	token: string,
): Promise<worldCore.WorldScan & { plan: worldCore.WorldImportPlan }> {
	const inst = configCore.managedInstances(cfg)[instance];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name: instance }));
	}

	const path = await localStagePath(token);
	const scan = await worldCore.scanWorldArchive(path);
	const plan = worldCore.planWorldImport(scan, {
		level: await worldCore.levelNameOf(inst),
		layout: worldCore.layoutOf(inst),
		mcVersion: inst.mcVersion,
	});

	return { ...scan, plan };
}

async function replaceWorldRouted(
	cfg: ClusterConfig,
	instance: string,
	token: string,
	opts: worldopsCore.ReplaceWorldOptions & { keepStage?: boolean } = {},
): Promise<worldopsCore.WorldMutationResult> {
	const path = await localStagePath(token);
	const { keepStage, ...rest } = opts;

	const result = await worldopsCore.replaceWorld(cfg, instance, path, rest);

	// the upload has served its purpose; leaving it would double the disk this
	// world costs until the sweeper eventually noticed
	if (!keepStage) {
		await stagingCore.discardStage(token).catch(() => undefined);
	}

	return result;
}

async function listBackupsRouted(_cfg: ClusterConfig, instance: string): Promise<backupsCore.BackupEntry[]> {
	return await backupsCore.listBackups(instance);
}

async function restoreBackupRouted(
	cfg: ClusterConfig,
	instance: string,
	id: string,
	opts: backupsCore.RestoreOptions = {},
): Promise<worldopsCore.WorldMutationResult> {
	await requireBackupOf(instance, id);

	return await backupsCore.restoreBackup(cfg, id, opts);
}

async function updateBackupRouted(
	_cfg: ClusterConfig,
	instance: string,
	id: string,
	patch: { label?: string; note?: string; pinned?: boolean },
): Promise<backupsCore.BackupEntry> {
	await requireBackupOf(instance, id);

	return await backupsCore.updateBackup(id, patch);
}

async function deleteBackupRouted(
	_cfg: ClusterConfig,
	instance: string,
	id: string,
	actor?: string,
): Promise<backupsCore.BackupEntry | undefined> {
	await requireBackupOf(instance, id);

	return await backupsCore.deleteBackup(id, actor);
}

async function verifyBackupRouted(
	_cfg: ClusterConfig,
	instance: string,
	id: string,
	reporter?: ProgressReporter,
): Promise<backupsCore.BackupEntry> {
	await requireBackupOf(instance, id);

	return await backupsCore.verifyBackup(id, reporter);
}

async function setKeepRouted(_cfg: ClusterConfig, instance: string, keep: number): Promise<number> {
	return await backupsCore.setKeepCount(instance, keep);
}

async function driftRouted(_cfg: ClusterConfig, instance: string): Promise<backupsCore.BackupDrift> {
	return await backupsCore.backupDrift(instance);
}

/**
 * Refuse a backup id that does not belong to the instance it was routed for.
 *
 * The routing already sent the call to the right machine, but the id is client
 * input: without this, a caller could name any instance to get the call routed
 * somewhere convenient and then act on a different instance's backup.
 */
async function requireBackupOf(instance: string, id: string): Promise<backupsCore.BackupEntry> {
	const entry = await backupsCore.getBackup(id);

	if (!entry || entry.instance !== instance) {
		throw new Error(t("core.backups.unknown", { id }));
	}

	return entry;
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
		throw new Error(t("core.datapacks.unknown", { name }));
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
				throw new Error(t("daemon.noClusterLink"));
			}

			const outcome = await forwardOp(daemon, "datapacks.removeFiles", [cfg, lock, name, names]);

			deletedFrom.push(...(outcome.result as string[]));
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);

			throw new Error(t("daemon.removeFailed", { daemon, name, detail }));
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
			? t("core.addons.rewritten", { count: respacks.length }) + (reloaded ? ` ${t("core.addons.proxyReloaded")}` : "")
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
		throw new Error(t("core.instances.unknown", { name }));
	}

	const owner = name === "proxy" ? undefined : inst.daemon;

	if (!owner || owner === daemonName()) {
		return await instancesCore.getStatus(cfg, name);
	}

	try {
		if (!forwardOp) {
			throw new Error(t("daemon.noClusterLink"));
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
						throw new Error(t("daemon.noClusterLink"));
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
			throw new Error(t("daemon.noFollowerLink", { name: opts.daemon }));
		}

		const { reporter, ...plain } = opts;
		const outcome = await forwardOp(
			opts.daemon,
			"admin.createInstance",
			[cfg, name, plain],
			reporter,
		);

		// the follower mutated its copy of cfg; echo it into ours so the
		// caller's registry entry (and its save) are correct
		Object.assign(cfg, outcome.cfg as ClusterConfig);

		return outcome.result as adminCore.CreateResult;
	}

	return await adminCore.createInstance(cfg, name, opts);
}

/**
 * Route adoption to the daemon named in the options. The instance is not in the
 * registry yet, so the usual owner routing has nothing to key on; the target
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
			throw new Error(t("daemon.noFollowerLink", { name: opts.daemon }));
		}

		const outcome = await forwardOp(opts.daemon, "admin.adoptInstance", [cfg, name, opts]);

		// the follower mutated its copy of cfg; echo it into ours so the
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
 * no link to is not an error; the caller renders "unknown" for it, which is the
 * truth, rather than a confident "not bound".
 */
async function askMachine(machine: string, op: string, args: unknown[]): Promise<unknown | null> {
	try {
		if (!forwardOp) {
			throw new Error(t("daemon.noClusterLink"));
		}

		const outcome = await forwardOp(machine, op, args);

		return outcome.result;
	} catch {
		return null;
	}
}

/**
 * The list form of `askMachine`. A follower one build behind may not have the op
 * at all, or may answer with an older shape; `listeningPorts` used to return a
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
					message: t("daemon.machineUnreachable", { machine: portsCore.machineLabel(machine) }),
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

// -- java runtimes -------------------------------------------------------------
// A JDK is arch-specific and lives under the machine's own cluster root, so every
// machine holds its own and answers for its own. Unlike the port ops these fan out
// over *registered* machines rather than instance owners: a follower with nothing
// on it yet is exactly the one an operator installs a runtime onto first.

/** Every machine in the fleet, this daemon's own key first. */
function fleetMachines(cfg: ClusterConfig): string[] {
	const mine = machineKey();
	const keys = ["", ...Object.keys(cfg.daemons ?? {})];

	return [mine, ...keys.filter((key) => key !== mine)];
}

/** What every machine in the fleet has installed. */
async function runtimesInventoryRouted(cfg: ClusterConfig): Promise<MachineRuntimes[]> {
	const mine = machineKey();
	const rows: MachineRuntimes[] = [];

	await Promise.all(
		fleetMachines(cfg).map(async (machine) => {
			if (machine === mine) {
				const local = await runtimesCore.listInstalledRuntimes();

				rows.push({ machine, platform: local.platform, runtimes: local.runtimes });

				return;
			}

			const answer = (await askMachine(machine, "runtimes.inventoryLocal", [])) as
				| LocalRuntimeInventory
				| null;

			rows.push({
				machine,
				platform: answer?.platform ?? null,
				runtimes: Array.isArray(answer?.runtimes) ? answer.runtimes : null,
			});
		}),
	);

	return rows.sort((a, b) => a.machine.localeCompare(b.machine));
}

/** The catalog as one machine sees it; its platform decides which builds exist. */
async function runtimesAvailableRouted(
	cfg: ClusterConfig,
	machine = machineKey(),
	opts: { vendor?: RuntimeVendor; feature?: number; refresh?: boolean } = {},
): Promise<AvailableRuntime[]> {
	if (machine === machineKey()) {
		return await runtimesCore.listAvailableRuntimes(opts);
	}

	const answer = await askMachineList<AvailableRuntime>(machine, "runtimes.listAvailable", [opts]);

	return answer ?? [];
}

/**
 * Install a runtime onto one machine. The download runs where the runtime will
 * be used, so a follower's progress is mirrored back through the forwarded
 * reporter rather than the primary fetching an archive it cannot run.
 */
async function installRuntimeRouted(
	cfg: ClusterConfig,
	machine: string,
	id: string,
	opts: { force?: boolean; reporter?: ProgressReporter } = {},
): Promise<InstalledRuntime> {
	if (machine === machineKey()) {
		return await runtimesCore.installRuntime(id, opts);
	}

	if (!forwardOp) {
		throw new Error(t("daemon.noFollowerLink", { name: machine }));
	}

	const { reporter, ...plain } = opts;
	const outcome = await forwardOp(machine, "runtimes.installLocal", [id, plain], reporter);

	return outcome.result as InstalledRuntime;
}

/**
 * Delete a runtime from one machine, refusing while something still asks for it.
 * The guard lives here because it needs the cluster config: the machine holding
 * the files has no idea which instances point at them.
 */
async function removeRuntimeRouted(
	cfg: ClusterConfig,
	machine: string,
	id: string,
	opts: { force?: boolean } = {},
): Promise<{ removed: boolean; freedBytes?: number }> {
	if (!opts.force) {
		const consumers = (runtimesCore.runtimeConsumers(cfg)[id] ?? []).filter(
			(consumer) => consumer.kind === "profile" || consumer.machine === machine,
		);

		if (consumers.length > 0) {
			throw new Error(
				t("core.runtimes.inUse", {
					id,
					consumers: consumers.map((consumer) => consumer.name).join(", "),
				}),
			);
		}
	}

	if (machine === machineKey()) {
		return await runtimesCore.removeLocalRuntime(id);
	}

	if (!forwardOp) {
		throw new Error(t("daemon.noFollowerLink", { name: machine }));
	}

	const outcome = await forwardOp(machine, "runtimes.removeLocal", [id]);

	return outcome.result as { removed: boolean; freedBytes?: number };
}

/** Route a directory inspection to the daemon whose disk holds the directory. */
async function inspectInstanceDirRouted(
	dir: string,
	daemon?: string,
): Promise<adminCore.InstanceDetection> {
	if (daemon && daemon !== daemonName()) {
		if (!forwardOp) {
			throw new Error(t("daemon.noFollowerLink", { name: daemon }));
		}

		const outcome = await forwardOp(daemon, "admin.inspectInstanceDir", [dir]);

		return outcome.result as adminCore.InstanceDetection;
	}

	return await adminCore.inspectInstanceDir(dir);
}

/** Set while this daemon's primary is refusing its build; see `linkQuarantine`. */
let quarantineReason: string | undefined;

/**
 * Record that the primary has quarantined this daemon, or that it has not.
 *
 * Called by the follower link. It is what lets `luna daemon list`, run in a
 * shell on the stranded machine itself, say why nothing is happening; the hub's
 * own view of the same fact never reaches a daemon it will not talk to.
 */
export function setLinkQuarantine(reason: string | undefined): void {
	quarantineReason = reason;
}

/** Why this daemon's primary is refusing it, if it is. */
export function linkQuarantine(): string | undefined {
	return quarantineReason;
}

/**
 * Provider behind `daemon.listDaemons`; replaced by the hub on a primary.
 * Without a hub there are no live links to report, so this daemon describes
 * itself from its own health and everything else from the registry alone.
 */
let daemonsProvider: () => Promise<unknown> = async () => {
	const cfg = await configCore.loadCluster();
	const self = daemonName();
	const own = health.currentHealth() ?? null;
	const refused = linkQuarantine();

	const selfRow: DaemonRow = {
		name: self,
		mode: "follower",
		host: null,
		addresses: health.hostAddresses(),
		online: !refused,
		state: refused ? "quarantined" : "online",
		quarantine: refused ?? null,
		version: buildVersion(),
		protocol: PROTOCOL_VERSION,
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
			state: "offline",
			quarantine: null,
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

/** Provider behind `daemon.daemonDetail`; replaced by the hub on a primary. */
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
 * Provider behind `daemon.upgradeDaemon`; replaced by the hub on a primary,
 * which is the only role that can reach another daemon. Without a hub the one
 * daemon this process can still upgrade is itself, which is what a CLI on a
 * follower host is asking for.
 */
let upgradeSender: (
	name: string,
	force: boolean,
	reporter?: ProgressReporter,
) => Promise<unknown> = async (
	name: string,
	force: boolean,
	reporter?: ProgressReporter,
) => {
	if (name !== daemonName()) {
		throw new Error(t("daemon.primaryOnlyUpgrade"));
	}

	return await upgrade.selfUpgrade(force, reporter);
};

/** Swap in the hub's follower upgrade sender. */
export function setUpgradeSender(
	sender: (name: string, force: boolean, reporter?: ProgressReporter) => Promise<unknown>,
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
		throw new Error(t("daemon.primaryOnlyCheck"));
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

/**
 * Every machine's health history, for the charts that combine the fleet.
 *
 * Without a hub there is one machine and it is this one. The primary replaces
 * this with the hub's view, which also holds each follower's history as its
 * samples arrive on the heartbeat.
 */
let fleetHistoryProvider: () => health.HealthSample[][] = () => [health.healthHistory()];

/** Swap in the hub's fleet-wide health histories. */
export function setFleetHistoryProvider(provider: () => health.HealthSample[][]): void {
	fleetHistoryProvider = provider;
}

/**
 * Assemble the public page's document.
 *
 * The projection itself is core's, and pure; this gathers the parts only a
 * daemon can reach. The fleet's histories live in the hub, the per-instance
 * metrics in the sampler, and the uptime record in this process's own store.
 *
 * Answers `null` when the page is switched off, so a route has one thing to
 * check rather than repeating the gate.
 */
async function publicSnapshot(): Promise<publicsiteCore.PublicSnapshot | null> {
	const cfg = await configCore.loadCluster();

	if (!publicsiteCore.publicEnabled(cfg)) {
		return null;
	}

	const lock = await configCore.loadLock();
	const listed = publicsiteCore.publicInstances(cfg).map(([name]) => name);

	const rows = ((await sampler.listStatuses()) as { instances: Array<Record<string, unknown>> })
		.instances;

	const status: publicsiteCore.PublicSnapshotInput["status"] = {};
	const metrics: publicsiteCore.PublicSnapshotInput["metrics"] = {};

	for (const name of listed) {
		const row = rows.find((entry) => entry.name === name);
		const players = row?.players as { online?: number; max?: number } | null | undefined;

		status[name] = {
			online: row?.state === "running",
			players: players?.online ?? null,
			maxPlayers: players?.max ?? null,
			tps: (row?.tps as number | null) ?? null,
			uptimeMs: (row?.uptimeMs as number | null) ?? null,
			cpu: (row?.cpu as number | null) ?? null,
			// the JVM's own heap rather than the process's resident size: it is what
			// the server reports about itself and it comes with a real ceiling, which
			// is what a gauge needs to have a full end
			rssMb: (row?.heapUsedMb as number | null) ?? null,
			memMaxMb: (row?.heapMaxMb as number | null) ?? null,
			chunks: (row?.chunks as number | null) ?? null,
			tickingEntities: (row?.tickingEntities as number | null) ?? null,
			nonTickingEntities: (row?.nonTickingEntities as number | null) ?? null,
			apdex: (row?.apdex as number | null) ?? null,
			misery: (row?.misery as number | null) ?? null,
		};

		metrics[name] = sampler.getHistory(name);
	}

	const fleet = fleetHistoryProvider();

	return publicsiteCore.buildPublicSnapshot({
		cfg,
		lock,
		fleet,
		metrics,
		status,
		uptime: uptimeRecorder.uptimeStore(),
		machines: fleet.length,
		bucketMs: health.SAMPLE_INTERVAL_MS,
		window: PUBLIC_SERIES_POINTS,
		now: Date.now(),
	});
}

/** Points in each public chart; one hour at the health sampler's cadence. */
const PUBLIC_SERIES_POINTS = 720;

/**
 * One instance's uptime timeline, for the console.
 *
 * Not gated on the public page: this is the operator's view of the same record,
 * and it is what the instance and machine screens draw. The store lives on the
 * primary, so a CLI run on a follower gets an empty window rather than a
 * partial one, which is the honest answer for a record it does not keep.
 */
function uptimeSeries(instance: string, days = uptimeCore.RETENTION_DAYS): uptimeCore.UptimeSeries {
	return uptimeCore.series(uptimeRecorder.uptimeStore(), instance, days, Date.now());
}

/**
 * Where an instance's BlueMap webserver answers, for the console's map proxy.
 *
 * Returned only for a listed instance: the public route must not become a way
 * to reach a private instance's map by knowing its name.
 */
async function publicMapEndpoint(instance: string): Promise<publicsiteCore.MapEndpoint | null> {
	const cfg = await configCore.loadCluster();

	if (!publicsiteCore.publicEnabled(cfg) || !publicsiteCore.isPublicInstance(cfg, instance)) {
		return null;
	}

	const lock = await configCore.loadLock();

	return publicsiteCore.mapEndpointFor(cfg, lock, instance) ?? null;
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
	"admin.ensureForwardingMod": { fn: adminCore.ensureForwardingMod, cfg: 0, lock: 1, instance: 2 },
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

	// -- console journal (this machine's own; a follower's stays on the follower) --
	"journal.append": { fn: journalCore.appendJournal },
	"journal.read": { fn: journalCore.readJournal },

	// -- console accounts ------------------------------------------------------------
	// Deliberately no op for the raw store: `loadAccounts` returns password hashes
	// and access-key digests, and every op below hands back the masked summaries
	// instead. That is what keeps a credential inside the daemon process by
	// construction rather than by every caller remembering to strip it.
	"accounts.list": { fn: accountsCore.listAccounts },
	"accounts.get": { fn: accountsCore.getAccount },
	"accounts.create": { fn: accountsCore.createAccount },
	"accounts.update": { fn: accountsCore.updateAccount },
	"accounts.delete": { fn: accountsCore.deleteAccount },
	"accounts.setPassword": { fn: accountsCore.setPassword },
	"accounts.addAccessKey": { fn: accountsCore.addAccessKey },
	"accounts.addMinecraft": { fn: accountsCore.addMinecraftIdentity },
	"accounts.removeIdentity": { fn: accountsCore.removeIdentity },
	"accounts.setIdentityDisabled": { fn: accountsCore.setIdentityDisabled },
	"accounts.audit": { fn: accountsCore.auditTrail },
	"accounts.bootstrapNeeded": { fn: accountsCore.bootstrapNeeded },
	"accounts.bootstrap": { fn: accountsCore.bootstrapAccount },
	// the whole verify → open-session → record cycle runs here: the argon2 hash
	// never crosses the socket, so nothing outside the daemon can attempt a guess
	"accounts.signIn": { fn: accountsCore.signIn },
	"accounts.signOut": { fn: accountsCore.signOut },
	"accounts.resolveSession": { fn: accountsCore.resolveSession },
	"accounts.resolveAccessKey": { fn: accountsCore.resolveAccessKey },
	"accounts.listSessions": { fn: accountsCore.listSessions },
	"accounts.revokeSession": { fn: accountsCore.revokeSession },
	"accounts.revokeAccountSessions": { fn: accountsCore.revokeAccountSessions },

	// -- plugins ---------------------------------------------------------------
	"plugins.scan": { fn: pluginsCore.scan, cfg: 0, lock: 1 },
	"plugins.getVersionsForEntry": { fn: pluginsCore.getVersionsForEntry },
	"plugins.checkUpdates": {
		fn: pluginsCore.checkUpdates,
		cfg: 0,
		lock: 1,
		reporter: { arg: 3, prop: "reporter" },
	},
	"plugins.applyUpdate": { fn: pluginsCore.applyUpdate, lock: 0 },
	"plugins.update": {
		fn: updateRouted,
		cfg: 0,
		lock: 1,
		reporter: { arg: 2, prop: "reporter" },
	},
	"plugins.pinVersion": { fn: pluginsCore.pinVersion, cfg: 0, lock: 1 },
	"plugins.ensureVariantForMc": { fn: pluginsCore.ensureVariantForMc, lock: 0 },
	"plugins.deploy": { fn: deployRouted, cfg: 0, lock: 1, reporter: { arg: 2, prop: "reporter" } },
	"plugins.installFromProvider": { fn: pluginsCore.installFromProvider, cfg: 0, lock: 1 },
	"plugins.adopt": { fn: pluginsCore.adopt, cfg: 0, lock: 1, instance: 2 },
	"plugins.uploadJar": { fn: pluginsCore.uploadJar, cfg: 0, lock: 1 },
	"plugins.removePlugin": { fn: pluginsCore.removePlugin, cfg: 0, lock: 1 },
	// provider mapping: the probe writes nothing, the other two rewrite the entry
	"plugins.probeIdentity": { fn: pluginsCore.probePluginIdentity, lock: 0 },
	"plugins.identify": { fn: pluginsCore.identifyPlugin, cfg: 0, lock: 1 },
	"plugins.forgetIdentity": { fn: pluginsCore.forgetPluginIdentity, lock: 0 },
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
	// the listing that also asks the running proxy which packs plugins register
	"respacks.listLive": { fn: respacksCore.listResourcePacksLive, cfg: 0, lock: 1 },
	"respacks.dynamic": { fn: respacksCore.dynamicResourcePacks },
	"respacks.takeOverDynamic": { fn: respacksCore.takeOverDynamicPack, cfg: 0, lock: 1 },
	"respacks.releaseDynamic": { fn: respacksCore.releaseDynamicPack, cfg: 0, lock: 1 },
	"respacks.probeIdentity": { fn: respacksCore.probeRespackIdentity, cfg: 0, lock: 1 },
	"respacks.identify": { fn: respacksCore.identifyResourcePack, cfg: 0, lock: 1 },
	"respacks.forgetIdentity": { fn: respacksCore.forgetRespackIdentity, cfg: 0, lock: 1 },
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
	"datapacks.probeIdentity": { fn: datapacksCore.probeDataPackIdentity, lock: 0 },
	"datapacks.identify": { fn: datapacksCore.identifyDataPack, cfg: 0, lock: 1 },
	"datapacks.forgetIdentity": { fn: datapacksCore.forgetDataPackIdentity, lock: 0 },
	"datapacks.adopt": { fn: datapacksCore.adoptDataPack, cfg: 0, lock: 1, instance: 2 },
	"datapacks.remove": { fn: removeDataPackRouted, cfg: 0, lock: 1 },
	// the per-owner slice of a routed removal; the primary calls it on each
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

	// -- worlds and backups (helpers above the table) ---------------------------
	// every one of these acts on one instance's directory, so they route to the
	// daemon that owns it; the archives never leave the machine they were
	// written on, which is why the index is not cluster state either
	"world.info": { fn: worldCore.worldInfo, cfg: 0, instance: 1 },
	"world.lock": { fn: worldopsCore.worldLock, cfg: 0, instance: 1 },
	"world.scanStaged": { fn: scanStagedWorld, cfg: 0, instance: 1 },
	"world.scanArchive": { fn: scanArchiveFor },
	"world.replace": { fn: replaceWorldRouted, cfg: 0, instance: 1, reporter: { arg: 3, prop: "reporter" } },
	"world.reset": { fn: worldopsCore.resetWorld, cfg: 0, instance: 1, reporter: { arg: 2, prop: "reporter" } },
	"world.recover": { fn: worldopsCore.recoverWorldOp, cfg: 0, instance: 1 },
	"backups.list": { fn: listBackupsRouted, cfg: 0, instance: 1 },
	"backups.create": {
		fn: backupsCore.createBackup,
		cfg: 0,
		instance: 1,
		reporter: { arg: 2, prop: "reporter" },
	},
	"backups.restore": { fn: restoreBackupRouted, cfg: 0, instance: 1, reporter: { arg: 3, prop: "reporter" } },
	"backups.update": { fn: updateBackupRouted, cfg: 0, instance: 1 },
	"backups.delete": { fn: deleteBackupRouted, cfg: 0, instance: 1 },
	"backups.verify": { fn: verifyBackupRouted, cfg: 0, instance: 1, reporter: { arg: 3 } },
	"backups.setKeep": { fn: setKeepRouted, cfg: 0, instance: 1 },
	"backups.drift": { fn: driftRouted, cfg: 0, instance: 1 },
	// A schedule's action, run once, through the one implementation of it. The
	// import is lazy because `daemon/scheduler.ts` reaches back here for `runOp`,
	// and a static import either way would close the cycle.
	"schedule.execute": {
		fn: async (action: scheduleCore.ScheduleAction, instance: string): Promise<string> =>
			await (await import("./scheduler")).executeScheduleAction(action, instance),
	},
	"staging.info": { fn: stagingCore.stageInfo },
	"staging.discard": { fn: stagingCore.discardStage },

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
	// -- java runtimes -------------------------------------------------------------
	// the "…Local" ops answer for the machine they run on and are what the routed
	// wrappers forward; a client only ever calls the routed ones
	"runtimes.inventoryLocal": { fn: runtimesCore.listInstalledRuntimes },
	"runtimes.installLocal": {
		fn: runtimesCore.installRuntime,
		reporter: { arg: 1, prop: "reporter" },
	},
	"runtimes.removeLocal": { fn: runtimesCore.removeLocalRuntime },
	"runtimes.listAvailable": { fn: runtimesCore.listAvailableRuntimes },
	"runtimes.inventory": { fn: runtimesInventoryRouted, cfg: 0 },
	"runtimes.available": { fn: runtimesAvailableRouted, cfg: 0 },
	"runtimes.install": {
		fn: installRuntimeRouted,
		cfg: 0,
		reporter: { arg: 3, prop: "reporter" },
	},
	"runtimes.remove": { fn: removeRuntimeRouted, cfg: 0 },
	"runtimes.ensureForInstance": {
		fn: runtimesCore.ensureInstanceRuntime,
		cfg: 0,
		instance: 1,
		reporter: { arg: 2 },
	},

	"proxy.syncVelocityToml": { fn: proxyCore.syncVelocityToml, cfg: 0 },
	"proxy.readVelocityServers": { fn: proxyCore.readVelocityServers, cfg: 0 },
	"proxy.readForwardingSecret": { fn: proxyCore.readForwardingSecret, cfg: 0 },

	// -- settings, templates, environment ------------------------------------------
	"settings.readServerProperties": { fn: settingsApply.readServerProperties, cfg: 0, instance: 1 },
	"settings.setRawProperty": { fn: settingsApply.setRawProperty, cfg: 0, instance: 1 },
	"settings.deleteRawProperty": { fn: settingsApply.deleteRawProperty, cfg: 0, instance: 1 },
	"settings.applySettings": {
		fn: settingsApply.applySettings,
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
	// no op for resolveDetailed: the client composes it from `builtinVars` plus the
	// pure layering, which keeps it working against a follower on an older build
	// reveal is a read that records itself, so the daemon does the whole load →
	// reveal → save cycle: the pure half mutates a store object, which could not
	// survive the trip back over the bridge
	"environment.reveal": { fn: environmentCore.revealAndRecord },
	// the env file is written into the instance directory, so it runs on the owner
	"environment.writeEnvFile": { fn: instancesCore.writeEnvFile, cfg: 0, instance: 1 },

	// -- instance config files ------------------------------------------------------
	// every one of these reads or writes inside an instance directory, so they all
	// route to the daemon that owns it; the store they update is primary-owned and
	// travels back up through the save-through hook
	"configfiles.browse": { fn: configfilesCore.browseInstance, cfg: 0, instance: 1 },
	"configfiles.read": { fn: configfilesCore.readInstanceFile, cfg: 0, instance: 1 },
	"configfiles.write": { fn: configfilesCore.writeInstanceFile, cfg: 0, instance: 1 },
	"configfiles.manage": { fn: configfilesCore.manageFile, cfg: 0, instance: 1 },
	"configfiles.unmanage": { fn: configfilesCore.unmanageFile, cfg: 0, instance: 1 },
	"configfiles.readopt": { fn: configfilesCore.readoptFile, cfg: 0, instance: 1 },
	"configfiles.createPlaceholder": { fn: configfilesCore.createPlaceholder, cfg: 0, instance: 1 },
	"configfiles.render": {
		fn: configfilesCore.renderManagedFiles,
		cfg: 0,
		instance: 1,
		reporter: { arg: 2 },
	},
	"configfiles.discardDrift": { fn: configfilesCore.discardDrift, cfg: 0, instance: 1 },
	"configfiles.forgetInstance": { fn: configfilesCore.forgetInstance },
	// the whole-cluster overview: the store is primary-owned, and the drift check
	// it reports is only accurate for instances this daemon can see on disk
	"configfiles.report": { fn: configfilesCore.managedFileReport, cfg: 0 },
	// spans every instance's templates and resolution, so it stays on the primary
	// where the stores live rather than routing anywhere
	"configfiles.variableUsage": { fn: configfilesCore.variableUsage, cfg: 0, lock: 1 },
	"configfiles.load": { fn: configfilesCore.loadConfigFiles },

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
	"software.listMcVersions": { fn: softwareRegistry.listMcVersions },
	"software.listLoaderVersions": { fn: softwareRegistry.listLoaderVersions },
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
	"lunaApi.moderationLog": { fn: lunaApi.moderationLog },
	"lunaApi.recordModeration": { fn: lunaApi.recordModeration },
	"lunaApi.networkIpBans": { fn: lunaApi.networkIpBans },
	"lunaApi.addNetworkIpBan": { fn: lunaApi.addNetworkIpBan },
	"lunaApi.removeNetworkIpBan": { fn: lunaApi.removeNetworkIpBan },
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
	"lunaApi.vaultAccount": { fn: lunaApi.vaultAccount },
	"lunaApi.vaultTransactions": { fn: lunaApi.vaultTransactions },

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
	// -- the public page ------------------------------------------------------
	// No cfg/lock echo and no instance routing: the snapshot is read-only, and it
	// is assembled where the whole fleet is visible, which is only ever here.
	"publicsite.snapshot": { fn: publicSnapshot },
	"publicsite.mapEndpoint": { fn: publicMapEndpoint },
	"publicsite.uptimeSeries": { fn: uptimeSeries },

	"daemon.listDaemons": { fn: () => daemonsProvider() },
	"daemon.daemonDetail": { fn: (name: string) => daemonDetailProvider(name) },
	"daemon.health": { fn: health.currentHealth },
	"daemon.binaryMeta": { fn: upgrade.localBinaryMeta },
	// both run on the daemon they describe; the primary forwards them there, and
	// the reporter travels with the forward so the tree the follower builds is
	// the one the caller watches
	"daemon.selfUpgrade": { fn: upgrade.selfUpgrade, reporter: { arg: 1 } },
	"daemon.checkUpgrade": { fn: upgrade.checkUpgrade },
	"daemon.upgradeDaemon": {
		fn: (name: string, force?: boolean, reporter?: ProgressReporter) =>
			upgradeSender(name, force ?? false, reporter),
		reporter: { arg: 2 },
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
 * How this daemon gets hold of a staged world zip it does not have.
 *
 * Installed by the follower link, which is the only side that can need it: an
 * upload always lands on the primary, so a follower asked to import one has to
 * pull it across first. Left unset on the primary, where the file is already
 * local and a missing token means the upload really is gone.
 *
 * A hook rather than an import because `daemon/follower.ts` imports `runOp`
 * from here, and reaching back the other way would close the cycle.
 */
export let fetchStagedWorld: ((token: string) => Promise<string>) | undefined;

/** Install the staged-world fetcher (follower only). */
export function installStageFetcher(fetcher: typeof fetchStagedWorld): void {
	fetchStagedWorld = fetcher;
}

/** Resolve a staging token to a local path, pulling it down if this is a follower. */
async function localStagePath(token: string): Promise<string> {
	if (stagingCore.stageExists(token)) {
		return stagingCore.stagePath(token);
	}

	if (fetchStagedWorld) {
		return await fetchStagedWorld(token);
	}

	throw new Error(t("daemon.stageMissing", { token }));
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
		throw new Error(t("daemon.unknownOp", { op }));
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
