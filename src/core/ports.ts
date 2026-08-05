import { join } from "node:path";

import type {
	ClusterConfig,
	InstanceConfig,
	PluginFamily,
	PluginsLock,
	PortBindingSpec,
	PortPool,
	PortPoolOverride,
} from "./types";
import { t } from "../shared/i18n";
import { instanceDir, managedInstances } from "./config";
import { effectiveTargets } from "./families";
import { getConfValue, setConfValue } from "./confedit";

/**
 * Port management (DESIGN.md §2.7). Two rules shape everything here:
 *
 * - **A port is only taken on the machine that binds it.** The proxy holding
 *   25565 on the primary says nothing about a follower's own 25565, so every
 *   pool, every allocation and every duplicate check is scoped to one machine.
 *   That machine is keyed by the owning daemon's name, with `""` standing for the
 *   primary; the same "absent `daemon` field" the instances themselves use.
 * - **cluster.json is the ledger.** An allocation exists because an instance
 *   records it, so deleting the instance releases its ports and there is no
 *   second list to keep in step. The only state outside the registry is the
 *   short-lived reservation a provision holds while it is still being built.
 */

/** Registry key of the primary's own machine: its instances carry no `daemon`. */
export const PRIMARY_MACHINE = "";

/** Pool id the game (backend listen) port comes from. */
export const GAME_POOL = "game";

/**
 * Pools every machine has before anyone configures one. The `game` range is
 * overridden by the cluster's legacy `serverPortRange`, so an untouched cluster
 * keeps allocating exactly where it always did.
 */
export const DEFAULT_PORT_POOLS: readonly PortPool[] = [
	{
		id: GAME_POOL,
		label: "Minecraft backends",
		protocol: "tcp",
		range: [32560, 32599],
	},

	{
		id: "voice",
		label: "Voice chat",
		protocol: "udp",
		range: [24455, 24499],
	},

	{
		id: "map",
		label: "Web maps",
		protocol: "tcp",
		range: [8100, 8199],
	},

	{
		id: "extra",
		label: "Other plugin services",
		protocol: "both",
		range: [32600, 32649],
	},
];

/** Built-in port binding presets for known plugins, keyed by "<provider-slug>:<side>". */
export const PORT_PRESETS: Record<string, PortBindingSpec[]> = {
	"simple-voice-chat:paper": [
		{
			id: "voice",
			protocol: "udp",
			scope: "instance",
			pool: "voice",
			range: [24455, 24499],
			config: {
				file: "plugins/voicechat/voicechat-server.properties",
				format: "properties",
				key: "port",
			},
		},
	],

	"simple-voice-chat:velocity": [
		{
			id: "voice",
			protocol: "udp",
			scope: "proxy",
			range: [24454, 24454],
			fixed: 24454,
			config: {
				file: "plugins/voicechat/voicechat-proxy.properties",
				format: "properties",
				key: "port",
			},
		},
	],

	"bluemap:paper": [
		{
			id: "web",
			protocol: "tcp",
			scope: "instance",
			pool: "map",
			range: [8100, 8199],
			config: {
				file: "plugins/BlueMap/webserver.conf",
				format: "hocon",
				key: "port",
			},
		},
	],
};

/** Port specs for a lock entry: explicit declaration wins, then slug+loader preset. */
export function portSpecsFor(entry: {
	ports?: PortBindingSpec[];
	remote?: { slug: string };
	family: PluginFamily;
}): PortBindingSpec[] | undefined {
	if (entry.ports) {
		return entry.ports;
	}

	if (!entry.remote) {
		return undefined;
	}

	// preset keys name concrete sides; a universal build binds on the paper side
	const side = entry.family === "universal" ? "paper" : entry.family;

	return PORT_PRESETS[`${entry.remote.slug}:${side}`];
}

// -- machines -------------------------------------------------------------------

/** Machine an instance's ports are allocated on ("" = the primary). */
export function machineOf(inst: InstanceConfig): string {
	return inst.daemon ?? PRIMARY_MACHINE;
}

/** How a machine key reads in a message; the primary has no name in cluster.json. */
export function machineLabel(machine: string): string {
	return machine === PRIMARY_MACHINE ? "primary" : machine;
}

/**
 * Every machine the cluster knows about, primary first: the registered daemons,
 * whoever owns an instance, and whoever a pool override names.
 */
export function clusterMachines(cfg: ClusterConfig): string[] {
	const rest = new Set<string>(Object.keys(cfg.daemons ?? {}));

	for (const pool of storedCatalog(cfg)) {
		for (const machine of Object.keys(pool.overrides ?? {})) {
			rest.add(machine);
		}
	}

	for (const inst of Object.values(managedInstances(cfg))) {
		rest.add(machineOf(inst));
	}

	rest.delete(PRIMARY_MACHINE);

	return [PRIMARY_MACHINE, ...[...rest].sort()];
}

/** Host the primary reaches a machine's instances on; loopback for its own. */
export function machineHost(cfg: ClusterConfig, machine: string): string {
	if (machine === PRIMARY_MACHINE) {
		return "127.0.0.1";
	}

	// a follower with no registration yet is still addressable by its own name
	return cfg.daemons?.[machine]?.host ?? machine;
}

export interface MachineInfo {
	/** Machine key ("" = the primary) */
	machine: string;
	/** How it reads in the console and in messages */
	label: string;
	/** Host the primary routes this machine's instances at */
	host: string;
	/** Instances it owns, proxy included */
	instances: string[];
}

/** Every machine with its routing host and the instances it owns. */
export function machineInfo(cfg: ClusterConfig): MachineInfo[] {
	const insts = Object.entries(managedInstances(cfg));

	return clusterMachines(cfg).map((machine) => ({
		machine,
		label: machineLabel(machine),
		host: machineHost(cfg, machine),
		instances: insts.filter(([, inst]) => machineOf(inst) === machine).map(([name]) => name),
	}));
}

/**
 * Address a backend answers on: its external address, or its owning machine's
 * host and game port. This is what velocity must route to, and what the console
 * offers to copy; never a bare `127.0.0.1` for an instance on another machine.
 */
export function instanceAddress(cfg: ClusterConfig, inst: InstanceConfig): string {
	if (inst.external) {
		return inst.external;
	}

	return `${machineHost(cfg, machineOf(inst))}:${inst.port}`;
}

// -- pools ----------------------------------------------------------------------

function clonePool(pool: PortPool): PortPool {
	const copy: PortPool = {
		id: pool.id,
		protocol: pool.protocol,
		range: [pool.range[0], pool.range[1]],
	};

	if (pool.label) {
		copy.label = pool.label;
	}

	if (pool.reserved?.length) {
		copy.reserved = [...pool.reserved];
	}

	const overrides = Object.entries(pool.overrides ?? {}).filter(
		([, override]) => override.range !== undefined || override.reserved?.length,
	);

	if (overrides.length) {
		copy.overrides = Object.fromEntries(
			overrides.map(([machine, override]) => {
				const kept: PortPoolOverride = {};

				if (override.range) {
					kept.range = [override.range[0], override.range[1]];
				}

				if (override.reserved?.length) {
					kept.reserved = [...override.reserved];
				}

				return [machine, kept];
			}),
		);
	}

	return copy;
}

/** cluster.json's catalog entries, guarded against the pre-catalog per-machine shape. */
function storedCatalog(cfg: ClusterConfig): PortPool[] {
	// the field briefly shipped as Record<machine, PortPool[]>; treat that as unset
	return Array.isArray(cfg.portPools) ? cfg.portPools : [];
}

/**
 * The cluster's pool catalog: the built-in defaults, with anything cluster.json
 * records replacing the default of the same id. Merging rather than replacing
 * means customizing the game range does not silently strip the cluster of the
 * pool its voice-chat ports come from; every consumer's pool always exists.
 */
export function poolCatalog(cfg: ClusterConfig): PortPool[] {
	const byId = new Map<string, PortPool>();

	for (const pool of DEFAULT_PORT_POOLS) {
		const copy = clonePool(pool);

		if (copy.id === GAME_POOL) {
			copy.range = [cfg.serverPortRange[0], cfg.serverPortRange[1]];
		}

		byId.set(copy.id, copy);
	}

	for (const pool of storedCatalog(cfg)) {
		byId.set(pool.id, clonePool(pool));
	}

	return [...byId.values()].sort((a, b) => a.range[0] - b.range[0]);
}

/**
 * The pools one machine hands out: the catalog with that machine's overrides
 * applied. The catalog is cluster-wide so every consumer's pool exists on every
 * machine; only the numbers vary here.
 */
export function poolsFor(cfg: ClusterConfig, machine: string): PortPool[] {
	const effective = poolCatalog(cfg).map((pool) => {
		const override = pool.overrides?.[machine];
		const flat = clonePool(pool);

		delete flat.overrides;

		if (override?.range) {
			flat.range = [override.range[0], override.range[1]];
		}

		if (override?.reserved) {
			flat.reserved = [...override.reserved];
		}

		return flat;
	});

	return effective.sort((a, b) => a.range[0] - b.range[0]);
}

/** Whether a pool can hand out a port for the given protocol. */
function poolServes(pool: PortPool, protocol?: "tcp" | "udp"): boolean {
	if (!protocol || pool.protocol === "both") {
		return true;
	}

	return pool.protocol === protocol;
}

/** One machine's pool by id, or undefined when it has none of that name. */
export function resolvePool(
	cfg: ClusterConfig,
	machine: string,
	id: string,
): PortPool | undefined {
	return poolsFor(cfg, machine).find((pool) => pool.id === id);
}

/** The pool a number falls in on one machine, or null when none covers it. */
export function poolOf(
	cfg: ClusterConfig,
	machine: string,
	port: number,
	protocol?: "tcp" | "udp",
): string | null {
	const pool = poolsFor(cfg, machine).find(
		(candidate) =>
			poolServes(candidate, protocol) && port >= candidate.range[0] && port <= candidate.range[1],
	);

	return pool?.id ?? null;
}

/** Numbers a pool spans, before reservations and allocations are taken out. */
export function poolCapacity(pool: PortPool): number {
	return pool.range[1] - pool.range[0] + 1;
}

// -- allocations ----------------------------------------------------------------

export interface PortAllocationEntry {
	/** Machine the port is bound on ("" = the primary) */
	machine: string;
	/** Instance holding it, `"proxy"` for the proxy itself */
	instance: string;
	/** Allocation key: `"game"` or `"<plugin>/<portId>"` */
	key: string;
	port: number;
	protocol: "tcp" | "udp";
	/** Pool the number falls in, null when it is outside every pool */
	pool: string | null;
}

/** Registry key of one plugin port allocation. */
function allocKey(plugin: string, portId: string): string {
	return `${plugin}/${portId}`;
}

/**
 * Whether an allocation is a fixed number rather than something a pool handed
 * out: the proxy's own game port is the cluster's public entrypoint, and a spec
 * with `fixed` pins its port by design (voice chat's proxy side is 24454
 * everywhere). Neither belongs to a pool, so neither is held to one.
 */
function isFixedAllocation(lock: PluginsLock | undefined, entry: PortAllocationEntry): boolean {
	if (entry.instance === "proxy" && entry.key === "game") {
		return true;
	}

	const [plugin, id] = entry.key.split("/");
	const plugged = lock?.plugins[plugin!];
	const specs = plugged ? portSpecsFor(plugged) : undefined;

	return specs?.find((spec) => spec.id === id)?.fixed !== undefined;
}

/** Protocol a plugin allocation binds on, from its port spec. */
function portProtocol(lock: PluginsLock | undefined, key: string): "tcp" | "udp" {
	const [plugin, id] = key.split("/");
	const entry = lock?.plugins[plugin!];
	const specs = entry ? portSpecsFor(entry) : undefined;

	return specs?.find((spec) => spec.id === id)?.protocol ?? "tcp";
}

/**
 * Every port the registry has handed out, one entry per allocation. External
 * servers are skipped: their ports are bound on a machine luna does not manage,
 * so they neither consume a pool nor collide with anything here.
 *
 * The lockfile is what says whether a plugin allocation is tcp or udp. Without
 * it a plugin port's protocol is a guess, so pool matching is left
 * protocol-agnostic rather than quietly filing every udp port under tcp.
 */
export function portAllocations(
	cfg: ClusterConfig,
	lock?: PluginsLock,
	machine?: string,
): PortAllocationEntry[] {
	const entries: PortAllocationEntry[] = [];

	for (const [name, inst] of Object.entries(managedInstances(cfg))) {
		const owner = machineOf(inst);

		if (machine !== undefined && owner !== machine) {
			continue;
		}

		entries.push({
			machine: owner,
			instance: name,
			key: "game",
			port: inst.port,
			protocol: "tcp",
			pool: poolOf(cfg, owner, inst.port, "tcp"),
		});

		for (const [key, port] of Object.entries(inst.ports ?? {})) {
			const protocol = portProtocol(lock, key);

			entries.push({
				machine: owner,
				instance: name,
				key,
				port,
				protocol,
				pool: poolOf(cfg, owner, port, lock ? protocol : undefined),
			});
		}
	}

	return entries.sort((a, b) => a.port - b.port);
}

/** Every port allocated on one machine (all of them when omitted), by owner label. */
export function allocatedPorts(cfg: ClusterConfig, machine?: string): Map<number, string> {
	const used = new Map<number, string>();

	for (const entry of portAllocations(cfg, undefined, machine)) {
		const where = machine === undefined ? ` on ${machineLabel(entry.machine)}` : "";

		used.set(entry.port, `${entry.instance} (${entry.key})${where}`);
	}

	return used;
}

/**
 * Ports handed out but not yet in the registry. Provisioning picks its port
 * before it downloads a server jar, and without this a second provision started
 * inside that window would be handed the same number. An entry is dropped as
 * soon as the registry records it, or once it has been held long enough that the
 * provision holding it must have died; an abandoned build never parks a number
 * for good.
 */
const reservations = new Map<string, { machine: string; port: number; at: number }>();

const RESERVATION_TTL_MS = 15 * 60_000;

function reservationKey(machine: string, port: number): string {
	return `${machine}:${port}`;
}

/** Drop reservations the registry has caught up with, and stale ones. */
function pruneReservations(cfg: ClusterConfig, now: number): void {
	for (const [key, held] of reservations) {
		if (now - held.at > RESERVATION_TTL_MS) {
			reservations.delete(key);

			continue;
		}

		const settled = portAllocations(cfg, undefined, held.machine).some(
			(entry) => entry.port === held.port,
		);

		if (settled) {
			reservations.delete(key);
		}
	}
}

/**
 * Hold one specific number against concurrent provisioning; the explicit-port
 * counterpart of `acquirePort({ reserve: true })`.
 */
export function reservePort(machine: string, port: number): void {
	reservations.set(reservationKey(machine, port), { machine, port, at: Date.now() });
}

/** Release a reservation explicitly; a provision that failed frees its port now. */
export function releaseReservation(machine: string, port: number): void {
	reservations.delete(reservationKey(machine, port));
}

/** Ports reserved by an in-flight provision on one machine. */
export function reservedPorts(machine: string): number[] {
	const held: number[] = [];

	for (const entry of reservations.values()) {
		if (entry.machine === machine) {
			held.push(entry.port);
		}
	}

	return held.sort((a, b) => a - b);
}

/** Allocations an instance holds; what deleting it releases. */
export function heldPorts(inst: InstanceConfig): Array<{ key: string; port: number }> {
	if (inst.external) {
		return [];
	}

	const held = [{ key: "game", port: inst.port }];

	for (const [key, port] of Object.entries(inst.ports ?? {})) {
		held.push({ key, port });
	}

	return held;
}

/** Release every port an instance held, so a re-provision can take them again. */
export function releaseInstancePorts(inst: InstanceConfig): number[] {
	const machine = machineOf(inst);
	const released = heldPorts(inst).map((held) => held.port);

	for (const port of released) {
		releaseReservation(machine, port);
	}

	return released;
}

export interface AcquireOptions {
	/** Machine the port will be bound on (omitted = the primary) */
	machine?: string;
	/** Pool to take from; `range` covers a machine that has no such pool */
	pool?: string;
	/** Explicit range, for a consumer that names no pool */
	range?: [number, number];
	/** Protocol the consumer binds, so a pool of the other protocol is skipped */
	protocol?: "tcp" | "udp";
	/** Hold the number against concurrent provisioning until the registry has it */
	reserve?: boolean;
}

export interface AcquiredPort {
	port: number;
	machine: string;
	/** Pool it came from, null when it came from an explicit range */
	pool: string | null;
}

/**
 * Take the lowest free port of a pool on one machine. Free means: not allocated
 * to anything on that machine, not reserved by the pool, and not held by a
 * provision still running.
 */
export function acquirePort(cfg: ClusterConfig, opts: AcquireOptions = {}): AcquiredPort {
	const machine = opts.machine ?? PRIMARY_MACHINE;
	const now = Date.now();

	pruneReservations(cfg, now);

	const pool = opts.pool ? resolvePool(cfg, machine, opts.pool) : undefined;
	const range = pool?.range ?? opts.range;

	if (!range) {
		throw new Error(
			opts.pool
				? t("core.ports.noPool", { machine: machineLabel(machine), pool: opts.pool })
				: t("core.ports.noRange"),
		);
	}

	if (pool && !poolServes(pool, opts.protocol)) {
		throw new Error(
			t("core.ports.wrongProtocol", {
				pool: pool.id,
				machine: machineLabel(machine),
				serves: pool.protocol,
				wanted: opts.protocol ?? "tcp",
			}),
		);
	}

	const used = allocatedPorts(cfg, machine);
	const blocked = new Set<number>([...(pool?.reserved ?? []), ...reservedPorts(machine)]);

	for (let port = range[0]; port <= range[1]; port++) {
		if (used.has(port) || blocked.has(port)) {
			continue;
		}

		if (opts.reserve) {
			reservations.set(reservationKey(machine, port), { machine, port, at: now });
		}

		return { port, machine, pool: pool?.id ?? null };
	}

	const where = pool
		? `pool "${pool.id}" on ${machineLabel(machine)}`
		: `${machineLabel(machine)}'s range`;

	throw new Error(t("core.ports.exhausted", { where, from: range[0], to: range[1] }));
}

/**
 * Lowest unallocated port in a range on one machine. Kept for callers that work
 * from a raw range; anything provisioning an instance should go through
 * `acquirePort` so pools and reservations apply.
 */
export function nextFreePort(
	cfg: ClusterConfig,
	range: [number, number],
	machine?: string,
): number {
	return acquirePort(cfg, { machine, range }).port;
}

export interface PortCheck {
	ok: boolean;
	/** Why the port cannot be used; ready to throw */
	error?: string;
	/** The port is usable, but something about it is worth saying out loud */
	warning?: string;
	/** Pool it falls in, null when outside every pool on that machine */
	pool: string | null;
}

/**
 * Whether an explicitly requested port can be used on a machine. `instance` is
 * the allocation's own holder, so re-stating the port an instance already has is
 * not a clash with itself.
 */
export function checkPort(
	cfg: ClusterConfig,
	port: number,
	opts: {
		machine?: string;
		instance?: string;
		protocol?: "tcp" | "udp";
		lock?: PluginsLock;
	} = {},
): PortCheck {
	const machine = opts.machine ?? PRIMARY_MACHINE;
	const protocol = opts.protocol ?? "tcp";

	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return { ok: false, error: `${port} is not a valid port number`, pool: null };
	}

	const pool = poolOf(cfg, machine, port, protocol);

	const clash = portAllocations(cfg, opts.lock, machine).find(
		(entry) => entry.port === port && entry.instance !== opts.instance,
	);

	if (clash) {
		return {
			ok: false,
			error: `port ${port} is already used by ${clash.instance} (${clash.key}) on ${machineLabel(machine)}`,
			pool,
		};
	}

	if (reservedPorts(machine).includes(port)) {
		return {
			ok: false,
			error: `port ${port} is reserved by a provision in progress on ${machineLabel(machine)}`,
			pool,
		};
	}

	const owning = poolsFor(cfg, machine).find((candidate) => candidate.id === pool);

	if (owning?.reserved?.includes(port)) {
		return {
			ok: false,
			error: `port ${port} is held back by pool "${owning.id}" on ${machineLabel(machine)}`,
			pool,
		};
	}

	if (!pool) {
		return {
			ok: true,
			warning: t("core.ports.outsidePools", { port, protocol, machine: machineLabel(machine) }),
			pool,
		};
	}

	return { ok: true, pool };
}

// -- pool management ------------------------------------------------------------

export interface PortPoolUsage {
	machine: string;
	/** The pool as this machine serves it (override applied) */
	pool: PortPool;
	/** Numbers the range spans */
	capacity: number;
	/** Allocations that fall inside the pool */
	used: PortAllocationEntry[];
	/** Numbers held back by the pool definition */
	reserved: number[];
	/** Numbers held by provisions still running */
	pending: number[];
	/** Capacity minus everything above */
	free: number;
	/** What the pool would hand out next, null when it is exhausted */
	next: number | null;
	/** True when the pool comes from the built-in defaults, not from cluster.json */
	inherited: boolean;
	/** True when this machine departs from the pool's cluster-wide numbers */
	overridden: boolean;
}

/** Pools and their usage, for the console's pool panel and `luna ports pools`. */
export function portPoolUsage(
	cfg: ClusterConfig,
	lock?: PluginsLock,
	machines?: string[],
): PortPoolUsage[] {
	const views: PortPoolUsage[] = [];
	const configured = new Set(storedCatalog(cfg).map((pool) => pool.id));
	const overrides = new Map(
		storedCatalog(cfg).map((pool) => [pool.id, new Set(Object.keys(pool.overrides ?? {}))]),
	);

	for (const machine of machines ?? clusterMachines(cfg)) {
		const allocations = portAllocations(cfg, lock, machine);
		const pending = reservedPorts(machine);

		for (const pool of poolsFor(cfg, machine)) {
			const inRange = (port: number): boolean =>
				port >= pool.range[0] && port <= pool.range[1];

			// without a lock a plugin port's protocol is unknown, so anything inside
			// the range counts; over-reporting usage is the safe direction
			const used = allocations.filter(
				(entry) => inRange(entry.port) && (!lock || poolServes(pool, entry.protocol)),
			);

			const reserved = (pool.reserved ?? []).filter(inRange);
			const held = pending.filter(inRange);
			const taken = new Set<number>([
				...used.map((entry) => entry.port),
				...reserved,
				...held,
			]);

			let next: number | null = null;

			for (let port = pool.range[0]; port <= pool.range[1] && next === null; port++) {
				if (!taken.has(port)) {
					next = port;
				}
			}

			views.push({
				machine,
				pool,
				capacity: poolCapacity(pool),
				used,
				reserved,
				pending: held,
				free: poolCapacity(pool) - taken.size,
				next,
				inherited: !configured.has(pool.id),
				overridden: overrides.get(pool.id)?.has(machine) ?? false,
			});
		}
	}

	return views;
}

export interface PoolValidation {
	/** Fatal problems; nothing was written */
	errors: string[];
	/** Written, but the caller should say these out loud */
	warnings: string[];
}

/** Pairs of pools that could both hand out the same number for one protocol. */
function poolOverlaps(pools: PortPool[]): string[] {
	const clashes: string[] = [];

	for (let i = 0; i < pools.length; i++) {
		for (let j = i + 1; j < pools.length; j++) {
			const a = pools[i]!;
			const b = pools[j]!;
			const protocolsMeet =
				a.protocol === b.protocol || a.protocol === "both" || b.protocol === "both";

			if (protocolsMeet && a.range[0] <= b.range[1] && b.range[0] <= a.range[1]) {
				clashes.push(
					`pools "${a.id}" and "${b.id}" overlap (${a.range.join("-")} / ${b.range.join("-")})`,
				);
			}
		}
	}

	return clashes;
}

/** One range's bounds check, shared by a pool's default numbers and its overrides. */
function validateRange(owner: string, range: [number, number]): string[] {
	const errors: string[] = [];
	const [from, to] = range;

	if (!Number.isInteger(from) || !Number.isInteger(to)) {
		errors.push(`${owner}: range bounds must be whole numbers`);

		return errors;
	}

	if (from < 1 || to > 65535) {
		errors.push(`${owner}: range must stay within 1-65535`);
	}

	if (from > to) {
		errors.push(`${owner}: range starts after it ends (${from}-${to})`);
	}

	return errors;
}

/** Range check on one pool definition, in the order a form would report them. */
function validatePool(pool: PortPool): string[] {
	const errors: string[] = [];

	if (!/^[a-z0-9][a-z0-9_-]*$/.test(pool.id)) {
		errors.push(`pool id "${pool.id}" must be lowercase alphanumeric/-/_`);
	}

	errors.push(...validateRange(`pool "${pool.id}"`, pool.range));

	for (const port of pool.reserved ?? []) {
		if (port < pool.range[0] || port > pool.range[1]) {
			errors.push(`pool "${pool.id}": reserved port ${port} is outside its own range`);
		}
	}

	for (const [machine, override] of Object.entries(pool.overrides ?? {})) {
		const owner = `pool "${pool.id}" on ${machineLabel(machine)}`;
		const range = override.range ?? pool.range;

		if (override.range) {
			errors.push(...validateRange(owner, override.range));
		}

		for (const port of override.reserved ?? []) {
			if (port < range[0] || port > range[1]) {
				errors.push(`${owner}: reserved port ${port} is outside its range`);
			}
		}
	}

	return errors;
}

export interface PoolConsumer {
	/** `provision` = the instance create flow; `plugin` = a lockfile port spec */
	kind: "provision" | "plugin";
	/** Plugin name, or what the provision acquires */
	name: string;
	protocol: "tcp" | "udp";
	/** The spec's port id ("voice", "web"), for plugin consumers */
	portId?: string;
}

/**
 * What acquires from each pool, keyed by pool id. This *is* the mapping: a pool
 * with no entry here is handed out to nothing until a plugin's port declaration
 * (`PortBindingSpec.pool`) names it; pools do not attach to instances or
 * plugins themselves, their consumers come asking by id.
 */
export function poolConsumers(lock?: PluginsLock): Record<string, PoolConsumer[]> {
	const consumers: Record<string, PoolConsumer[]> = {
		[GAME_POOL]: [{ kind: "provision", name: "instance game port", protocol: "tcp" }],
	};

	const seen = new Set<string>();

	for (const [key, entry] of Object.entries(lock?.plugins ?? {})) {
		for (const spec of portSpecsFor(entry) ?? []) {
			if (!spec.pool) {
				continue;
			}

			// several family builds of one plugin share a name and a spec; one row
			const name = entry.plugin ?? key;
			const dedup = `${spec.pool}|${name}|${spec.id}`;

			if (seen.has(dedup)) {
				continue;
			}

			seen.add(dedup);
			(consumers[spec.pool] ??= []).push({
				kind: "plugin",
				name,
				protocol: spec.protocol,
				portId: spec.id,
			});
		}
	}

	return consumers;
}

/**
 * Replace the cluster's pool catalog. An entry customizes the built-in default
 * of the same id (the defaults always remain; a consumer's pool can never
 * disappear); a new id adds a pool; an empty list returns everything to the
 * defaults. Mutates cfg (caller saves); and only once every definition
 * validates, so a rejected form never leaves half a catalog behind.
 */
export function setPoolCatalog(
	cfg: ClusterConfig,
	pools: PortPool[],
	lock?: PluginsLock,
): PoolValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	const seen = new Set<string>();

	for (const pool of pools) {
		if (seen.has(pool.id)) {
			errors.push(`pool id "${pool.id}" is defined twice`);
		}

		seen.add(pool.id);
		errors.push(...validatePool(pool));
	}

	if (errors.length) {
		return { errors, warnings };
	}

	// apply tentatively; the remaining checks judge the merged result (what is
	// written plus the defaults still inherited), and roll back on failure
	const previous = cfg.portPools;

	if (pools.length) {
		cfg.portPools = pools.map(clonePool).sort((a, b) => a.range[0] - b.range[0]);
	} else {
		delete cfg.portPools;
	}

	const rollback = (problems: string[]): PoolValidation => {
		if (previous === undefined) {
			delete cfg.portPools;
		} else {
			cfg.portPools = previous;
		}

		return { errors: problems, warnings };
	};

	// every consumer must still be servable: a pool a plugin acquires from with
	// the wrong protocol fails at deploy time, which is the worst place to learn it
	const catalog = poolCatalog(cfg);
	const consumerProblems: string[] = [];

	for (const [poolId, wanting] of Object.entries(poolConsumers(lock))) {
		const pool = catalog.find((candidate) => candidate.id === poolId);

		for (const consumer of wanting) {
			if (!pool) {
				warnings.push(t("core.ports.undefinedPool", { pool: poolId, consumer: consumer.name }));

				continue;
			}

			if (!poolServes(pool, consumer.protocol)) {
				consumerProblems.push(
					t("core.ports.protocolClash", {
						pool: poolId,
						serves: pool.protocol,
						consumer: consumer.name,
						wanted: consumer.protocol,
					}),
				);
			}
		}
	}

	if (consumerProblems.length) {
		return rollback(consumerProblems);
	}

	// Overlap is judged per machine on the effective sets, because two pools
	// covering the same number for the same protocol make the pool a port came
	// from ambiguous, and every usage figure depends on that being one answer.
	const machines = new Set(clusterMachines(cfg));

	for (const pool of catalog) {
		for (const machine of Object.keys(pool.overrides ?? {})) {
			machines.add(machine);
		}
	}

	const overlapProblems: string[] = [];

	for (const machine of machines) {
		for (const clash of poolOverlaps(poolsFor(cfg, machine))) {
			overlapProblems.push(`${machineLabel(machine)}: ${clash}`);
		}
	}

	if (overlapProblems.length) {
		return rollback([...new Set(overlapProblems)]);
	}

	for (const pool of pools) {
		if (pool.range[0] < 1024) {
			warnings.push(t("core.ports.privilegedRange", { pool: pool.id }));
		}

		if (!poolConsumers(lock)[pool.id]) {
			warnings.push(t("core.ports.noConsumers", { pool: pool.id }));
		}
	}

	// an allocation nothing covers any more still works; it is simply no longer
	// tracked, and a later `acquirePort` could hand its number to somebody else
	for (const machine of machines) {
		for (const entry of portAllocations(cfg, lock, machine)) {
			if (isFixedAllocation(lock, entry)) {
				continue;
			}

			if (poolOf(cfg, machine, entry.port, entry.protocol) === null) {
				warnings.push(
					`${entry.instance} (${entry.key}) holds ${entry.port}/${entry.protocol}, which no pool on ${machineLabel(machine)} covers`,
				);
			}
		}
	}

	return { errors, warnings };
}

// -- plugin allocations ---------------------------------------------------------

/**
 * Instances a spec applies to: proxy-scoped specs bind on the proxy alone,
 * instance-scoped ones on every backend the plugin reaches (explicit targets
 * and group coverage alike).
 */
function specTargets(
	cfg: ClusterConfig,
	lock: PluginsLock,
	name: string,
	spec: PortBindingSpec,
): string[] {
	if (spec.scope === "proxy") {
		return ["proxy"];
	}

	return effectiveTargets(cfg, lock, name).filter((target) => target !== "proxy");
}

export interface PortAllocation {
	instance: string;
	/** Machine the allocation binds on */
	machine: string;
	key: string;
	port: number;
	written: boolean; // config file patched (false = reserved, config not generated yet)
	configPath: string;
}

interface PluginBinding {
	inst: InstanceConfig;
	target: string;
	spec: PortBindingSpec;
	/** Registry key of the allocation, `"<plugin>/<portId>"` */
	key: string;
}

/** Every (plugin, spec, target) triple a port has to exist for. */
function pluginBindings(cfg: ClusterConfig, lock: PluginsLock): PluginBinding[] {
	const bindings: PluginBinding[] = [];
	const insts = managedInstances(cfg);

	for (const [pluginName, entry] of Object.entries(lock.plugins)) {
		const specs = portSpecsFor(entry);

		if (!specs) {
			continue;
		}

		for (const spec of specs) {
			for (const target of specTargets(cfg, lock, pluginName, spec)) {
				const inst = insts[target];

				if (!inst) {
					continue;
				}

				bindings.push({ inst, target, spec, key: allocKey(pluginName, spec.id) });
			}
		}
	}

	return bindings;
}

/**
 * Ensure every port-declaring plugin has an allocation for each of its targets.
 * Allocation is registry work, so it happens for every machine wherever this
 * runs; writing the numbers into the plugin config files only works on the
 * machine holding those files, which is what `machine` narrows to (undefined =
 * everything local, for a single-machine cluster). Mutates cfg (caller saves).
 */
export async function ensurePortAllocations(
	cfg: ClusterConfig,
	lock: PluginsLock,
	machine?: string,
): Promise<PortAllocation[]> {
	const results: PortAllocation[] = [];

	for (const { inst, target, spec, key } of pluginBindings(cfg, lock)) {
		const owner = machineOf(inst);
		const confPath = join(instanceDir(inst), spec.config.file);

		inst.ports ??= {};

		// Adopt an existing value from the config file if we have no allocation yet -
		// only the owning machine can read it, so a follower's own pass does the
		// adopting for its instances.
		if (inst.ports[key] === undefined) {
			const mine = machine === undefined || owner === machine;
			const existing = mine
				? await getConfValue(confPath, spec.config.format, spec.config.key)
				: undefined;
			const parsed = existing !== undefined ? parseInt(existing) : NaN;

			inst.ports[key] =
				Number.isFinite(parsed) && parsed > 0
					? parsed
					: (spec.fixed ??
						acquirePort(cfg, {
							machine: owner,
							pool: spec.pool,
							range: spec.range,
							protocol: spec.protocol,
						}).port);
		}

		if (machine !== undefined && owner !== machine) {
			continue;
		}

		const port = inst.ports[key]!;
		const written = await setConfValue(confPath, spec.config.format, spec.config.key, port);

		results.push({ instance: target, machine: owner, key, port, written, configPath: confPath });
	}

	return results;
}

/**
 * The plugin port values one machine's config files currently hold. This is how a
 * machine that does not own the files gets to adopt them instead of allocating
 * over the top: a voice-chat port a follower's config already binds is the port
 * that plugin is reachable on, whatever the registry has yet to record.
 */
export async function readPortConfigs(
	cfg: ClusterConfig,
	lock: PluginsLock,
	machine?: string,
): Promise<Array<{ instance: string; key: string; port: number }>> {
	const found: Array<{ instance: string; key: string; port: number }> = [];

	for (const { inst, target, spec, key } of pluginBindings(cfg, lock)) {
		if (machine !== undefined && machineOf(inst) !== machine) {
			continue;
		}

		const actual = await getConfValue(
			join(instanceDir(inst), spec.config.file),
			spec.config.format,
			spec.config.key,
		);
		const parsed = actual !== undefined ? parseInt(actual) : NaN;

		if (Number.isFinite(parsed) && parsed > 0) {
			found.push({ instance: target, key, port: parsed });
		}
	}

	return found;
}

/**
 * Write the registry's plugin port allocations into one machine's config files,
 * allocating nothing. This is the follower half of `ensurePortAllocations`: the
 * primary allocates for the whole cluster, each owner writes its own files.
 */
export async function writePortConfigs(
	cfg: ClusterConfig,
	lock: PluginsLock,
	machine?: string,
): Promise<PortAllocation[]> {
	const results: PortAllocation[] = [];

	for (const { inst, target, spec, key } of pluginBindings(cfg, lock)) {
		const owner = machineOf(inst);
		const port = inst.ports?.[key];

		if (port === undefined || (machine !== undefined && owner !== machine)) {
			continue;
		}

		const confPath = join(instanceDir(inst), spec.config.file);
		const written = await setConfValue(confPath, spec.config.format, spec.config.key, port);

		results.push({ instance: target, machine: owner, key, port, written, configPath: confPath });
	}

	return results;
}

// -- live state -----------------------------------------------------------------

/**
 * Ports currently bound on this host, as `"<proto>:<port>"` keys. An array
 * rather than a set because this crosses the RPC wire as JSON; a Map or Set
 * would arrive empty.
 */
export async function listeningPorts(): Promise<string[]> {
	const proc = Bun.spawn(["ss", "-tulnH"], { stdout: "pipe", stderr: "ignore" });
	const out = await new Response(proc.stdout).text();

	await proc.exited;

	const bound = new Set<string>();

	for (const line of out.split("\n")) {
		const cols = line.trim().split(/\s+/);

		if (cols.length < 5) {
			continue;
		}

		const proto = cols[0]!.startsWith("udp") ? "udp" : "tcp";
		const local = cols[4]!.match(/:(\d+)$/);

		if (local) {
			bound.add(`${proto}:${local[1]}`);
		}
	}

	return [...bound];
}

export interface PortIssue {
	/** `unchecked` is not a finding: it says a machine could not be looked at, so
	 *  the audit is reporting less than the whole cluster */
	kind: "duplicate" | "config-drift" | "velocity-mismatch" | "pool" | "unchecked";
	message: string;
	/** Machine the problem is on, when it belongs to one */
	machine?: string;
}

/** Ports allocated twice on the same machine, for the same protocol. */
function auditDuplicates(cfg: ClusterConfig, lock: PluginsLock): PortIssue[] {
	const seen = new Map<string, PortAllocationEntry[]>();

	for (const entry of portAllocations(cfg, lock)) {
		// tcp and udp can legitimately share a number, and two machines always
		// can; only the same protocol on the same host is a real collision
		const key = `${entry.machine}|${entry.protocol}|${entry.port}`;

		if (!seen.has(key)) {
			seen.set(key, []);
		}

		seen.get(key)!.push(entry);
	}

	const issues: PortIssue[] = [];

	for (const owners of seen.values()) {
		if (owners.length < 2) {
			continue;
		}

		const first = owners[0]!;
		const who = owners.map((entry) => `${entry.instance} (${entry.key})`).join(", ");

		issues.push({
			kind: "duplicate",
			machine: first.machine,
			message: `${machineLabel(first.machine)}: ${first.port}/${first.protocol} allocated to ${who}`,
		});
	}

	return issues;
}

/**
 * Allocations that no pool on their machine covers, and pool definitions that
 * clash. Machines are only held to a catalog somebody actually wrote: the
 * built-in defaults are a guess at what a machine hands out, and flagging a
 * working server for sitting outside a guess is noise, not a finding.
 */
function auditPools(cfg: ClusterConfig, lock: PluginsLock): PortIssue[] {
	const issues: PortIssue[] = [];

	if (!storedCatalog(cfg).length) {
		return issues;
	}

	for (const machine of clusterMachines(cfg)) {
		const pools = poolsFor(cfg, machine);

		for (const clash of poolOverlaps(pools)) {
			issues.push({
				kind: "pool",
				machine,
				message: `${machineLabel(machine)}: ${clash}`,
			});
		}

		for (const entry of portAllocations(cfg, lock, machine)) {
			if (isFixedAllocation(lock, entry)) {
				continue;
			}

			if (entry.pool === null) {
				issues.push({
					kind: "pool",
					machine,
					message: `${machineLabel(machine)}: ${entry.instance} (${entry.key}) holds ${entry.port}/${entry.protocol}, outside every pool`,
				});

				continue;
			}

			// a number both held back and handed out is a contradiction in the
			// definition: the pool says never, the registry says already
			const owning = pools.find((pool) => pool.id === entry.pool);

			if (owning?.reserved?.includes(entry.port)) {
				issues.push({
					kind: "pool",
					machine,
					message: `${machineLabel(machine)}: pool "${owning.id}" holds ${entry.port} back, but ${entry.instance} (${entry.key}) is using it`,
				});
			}
		}
	}

	return issues;
}

/**
 * Allocations whose plugin config file no longer matches the registry. Only the
 * machine holding the file can tell, so `machine` restricts the scan to the
 * instances whose directories are on this disk.
 */
export async function auditConfigDrift(
	cfg: ClusterConfig,
	lock: PluginsLock,
	machine?: string,
): Promise<PortIssue[]> {
	const issues: PortIssue[] = [];

	for (const { inst, target, spec, key } of pluginBindings(cfg, lock)) {
		const owner = machineOf(inst);

		if (machine !== undefined && owner !== machine) {
			continue;
		}

		const alloc = inst.ports?.[key];
		const actual = await getConfValue(
			join(instanceDir(inst), spec.config.file),
			spec.config.format,
			spec.config.key,
		);

		if (alloc === undefined || actual === undefined || parseInt(actual) === alloc) {
			continue;
		}

		issues.push({
			kind: "config-drift",
			machine: owner,
			message: `${target}: ${spec.config.file} has ${spec.config.key}=${actual}, registry says ${alloc}`,
		});
	}

	return issues;
}

/** Proxy routing entries that disagree with the registry. */
function auditVelocity(cfg: ClusterConfig, velocityServers: Record<string, string>): PortIssue[] {
	const issues: PortIssue[] = [];

	for (const [name, addr] of Object.entries(velocityServers)) {
		const inst = cfg.instances[name];

		if (!inst) {
			issues.push({
				kind: "velocity-mismatch",
				message: `velocity.toml registers "${name}" which is not in cluster.json`,
			});

			continue;
		}

		// a follower-owned backend is routed at its machine's host, exactly as
		// core/proxy.ts writes it; comparing against loopback would flag every
		// remote instance in the cluster
		const expected = instanceAddress(cfg, inst);

		if (addr !== expected) {
			issues.push({
				kind: "velocity-mismatch",
				machine: machineOf(inst),
				message: `velocity.toml "${name}" = ${addr}, expected ${expected}`,
			});
		}
	}

	return issues;
}

/**
 * Cross-check every place a port is recorded: the registry against itself and
 * against the machines' pools, the plugin config files on disk, and
 * velocity.toml's server table. `machine` scopes the on-disk half; the caller
 * gathers the other machines' drift from their own daemons.
 */
export async function auditPorts(
	cfg: ClusterConfig,
	lock: PluginsLock,
	velocityServers: Record<string, string>,
	machine?: string,
): Promise<PortIssue[]> {
	return [
		...auditDuplicates(cfg, lock),
		...auditPools(cfg, lock),
		...(await auditConfigDrift(cfg, lock, machine)),
		...auditVelocity(cfg, velocityServers),
	];
}

export interface MachineProbe {
	/** Machine key ("" = the primary) */
	machine: string;
	/** `"<proto>:<port>"` bound there; null when the machine could not be probed */
	listening: string[] | null;
}

export interface PortRow {
	port: number;
	protocol: "tcp" | "udp";
	owner: string; // "proxy", instance name, or "instance/plugin"
	kind: string; // "game", "plugin:voicechat/voice", "external"
	source: "cluster" | "lock" | "config-file";
	/** null when the owning machine could not be probed */
	listening: boolean | null;
	/** Machine it binds on ("" = the primary), null for an external server */
	machine: string | null;
	/** Where it answers, "host:port" */
	address: string;
	/** Pool the number falls in on that machine */
	pool: string | null;
}

/**
 * Every allocated port with its owner, its machine, the address it answers on
 * and whether it is currently bound. Bind state comes from the probes the caller
 * gathered; one per machine, because `ss` only ever sees its own host.
 */
export async function collectPortRows(
	cfg: ClusterConfig,
	lock: PluginsLock,
	probes?: MachineProbe[],
): Promise<PortRow[]> {
	const gathered =
		probes ?? ([{ machine: PRIMARY_MACHINE, listening: await listeningPorts() }] as MachineProbe[]);

	const byMachine = new Map(gathered.map((probe) => [probe.machine, probe]));
	const rows: PortRow[] = [];

	for (const entry of portAllocations(cfg, lock)) {
		const probe = byMachine.get(entry.machine);

		rows.push({
			port: entry.port,
			protocol: entry.protocol,
			owner: entry.instance,
			kind: entry.key === "game" ? "game" : `plugin:${entry.key}`,
			source: "cluster",
			listening: probe?.listening ? probe.listening.includes(`${entry.protocol}:${entry.port}`) : null,
			machine: entry.machine,
			address: `${machineHost(cfg, entry.machine)}:${entry.port}`,
			pool: entry.pool,
		});
	}

	for (const [name, inst] of Object.entries(cfg.instances)) {
		if (!inst.external) {
			continue;
		}

		const port = inst.external.match(/:(\d+)$/);

		// external servers run on a machine luna does not manage; we record the
		// address they advertise and probe nothing
		if (port) {
			rows.push({
				port: parseInt(port[1]!),
				protocol: "tcp",
				owner: name,
				kind: "external",
				source: "cluster",
				listening: null,
				machine: null,
				address: inst.external,
				pool: null,
			});
		}
	}

	return rows.sort((a, b) => a.port - b.port);
}
