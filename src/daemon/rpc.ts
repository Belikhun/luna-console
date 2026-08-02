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

import * as adminCore from "../core/admin";
import * as cleanupCore from "../core/cleanup";
import * as configCore from "../core/config";
import * as environmentCore from "../core/environment";
import * as instancesCore from "../core/instances";
import * as lunaCore from "../core/luna";
import * as pluginstateCore from "../core/pluginstate";
import * as pluginsCore from "../core/plugins";
import * as portsCore from "../core/ports";
import * as proxyCore from "../core/proxy";
import * as scheduleCore from "../core/schedule";
import * as screenCore from "../core/screen";
import * as settingsCore from "../core/settings";
import * as standardizeCore from "../core/standardize";
import * as templatesCore from "../core/templates";
import * as lunaApi from "../core/services/luna";
import * as modrinth from "../core/services/modrinth";
import * as papermc from "../core/services/papermc";

import * as events from "./events";
import { daemonName } from "./identity";
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

/** Provider behind `daemon.listDaemons` — replaced by the hub on a primary. */
let daemonsProvider: () => Promise<unknown> = async () => {
	const cfg = await configCore.loadCluster();
	const daemons = cfg.daemons ?? {};

	return Object.entries(daemons).map(([name, reg]) => ({
		name,
		mode: "follower",
		host: reg.host,
		online: false,
		version: reg.version ?? null,
		connectedAt: null,
		lastSeen: reg.lastSeen ?? null,
		stats: null,
		instances: Object.entries(cfg.instances)
			.filter(([, inst]) => inst.daemon === name)
			.map(([instName]) => instName),
	}));
};

/** Swap in the hub's live daemons listing. */
export function setDaemonsProvider(provider: () => Promise<unknown>): void {
	daemonsProvider = provider;
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
	"admin.setVersion": { fn: adminCore.setVersion, cfg: 0, instance: 1, reporter: { arg: 3 } },
	"admin.setPort": { fn: adminCore.setPort, cfg: 0 },
	"admin.getServerProperty": { fn: adminCore.getServerProperty, cfg: 0, instance: 1 },
	"admin.setServerProperty": { fn: adminCore.setServerProperty, cfg: 0, instance: 1 },
	"admin.deleteInstance": { fn: adminCore.deleteInstance, cfg: 0, instance: 1 },

	// -- instance lifecycle ---------------------------------------------------
	"instances.writeRunScript": { fn: instancesCore.writeRunScript, cfg: 0, instance: 1 },
	"instances.getStatus": { fn: instancesCore.getStatus, cfg: 0, instance: 1 },
	"instances.getAllStatuses": { fn: getAllStatusesRouted, cfg: 0 },
	"instances.startInstance": { fn: instancesCore.startInstance, cfg: 0, instance: 1 },
	"instances.stopInstance": { fn: instancesCore.stopInstance, cfg: 0, instance: 1 },
	"instances.sendCommand": { fn: instancesCore.sendCommand, cfg: 0, instance: 1 },

	// -- plugins ---------------------------------------------------------------
	"plugins.scan": { fn: pluginsCore.scan, cfg: 0, lock: 1 },
	"plugins.getVersionsForEntry": { fn: pluginsCore.getVersionsForEntry },
	"plugins.checkUpdates": { fn: pluginsCore.checkUpdates, cfg: 0, lock: 1 },
	"plugins.applyUpdate": { fn: pluginsCore.applyUpdate, lock: 0 },
	"plugins.pinVersion": { fn: pluginsCore.pinVersion, cfg: 0, lock: 1 },
	"plugins.ensureVariantForMc": { fn: pluginsCore.ensureVariantForMc, lock: 0 },
	"plugins.deploy": { fn: deployRouted, cfg: 0, lock: 1, reporter: { arg: 2, prop: "reporter" } },
	"plugins.installFromModrinth": { fn: pluginsCore.installFromModrinth, cfg: 0, lock: 1 },
	"plugins.adopt": { fn: pluginsCore.adopt, cfg: 0, lock: 1, instance: 2 },
	"plugins.removePlugin": { fn: pluginsCore.removePlugin, cfg: 0, lock: 1 },
	"standardize.standardizeNaming": {
		fn: standardizeCore.standardizeNaming,
		cfg: 0,
		lock: 1,
		reporter: { arg: 2, prop: "reporter" },
	},

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
	"ports.ensurePortAllocations": { fn: portsCore.ensurePortAllocations, cfg: 0, lock: 1 },
	"ports.listeningPorts": { fn: portsCore.listeningPorts },
	"ports.auditPorts": { fn: portsCore.auditPorts, cfg: 0, lock: 1 },
	"ports.collectPortRows": { fn: portsCore.collectPortRows, cfg: 0, lock: 1 },
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
	"environment.builtinVars": { fn: environmentCore.builtinVars, cfg: 0 },
	"environment.resolveVars": { fn: environmentCore.resolveVars, cfg: 0 },

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
	"modrinth.getProject": { fn: modrinth.getProject },
	"modrinth.getVersions": { fn: modrinth.getVersions },
	"modrinth.search": { fn: modrinth.search },
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

	// -- daemon-native (sampler, events) ---------------------------------------------------
	"daemon.listStatuses": { fn: sampler.listStatuses },
	"daemon.instanceStatus": { fn: sampler.instanceStatus, instance: 0 },
	"daemon.getHistory": { fn: sampler.getHistory, instance: 0 },
	"daemon.markTransition": { fn: sampler.markTransition },
	"daemon.clearTransition": { fn: sampler.clearTransition },
	"daemon.readHostMemMb": { fn: sampler.readHostMemMb },
	"daemon.lunaProblem": { fn: sampler.lunaProblem },
	"daemon.pushEvent": { fn: events.pushEvent },
	"daemon.getEvents": { fn: events.getEvents },
	"daemon.listDaemons": { fn: () => daemonsProvider() },
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
