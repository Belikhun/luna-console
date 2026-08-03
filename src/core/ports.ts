import { join } from "node:path";

import type { ClusterConfig, PluginEntry, PluginFamily, PluginsLock, PortBindingSpec } from "./types";
import { instanceDir, managedInstances } from "./config";
import { effectiveTargets } from "./families";
import { getConfValue, setConfValue } from "./confedit";

/** Built-in port binding presets for known plugins, keyed by "<provider-slug>:<side>". */
export const PORT_PRESETS: Record<string, PortBindingSpec[]> = {
	"simple-voice-chat:paper": [
		{
			id: "voice",
			protocol: "udp",
			scope: "instance",
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

export interface PortRow {
	port: number;
	protocol: "tcp" | "udp";
	owner: string; // "proxy", instance name, or "instance/plugin"
	kind: string; // "game", "query", "plugin:voicechat/voice", "external"
	source: "cluster" | "lock" | "config-file";
	listening?: boolean;
}

/** Registry key of one plugin port allocation. */
function allocKey(plugin: string, portId: string): string {
	return `${plugin}/${portId}`;
}

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

/** Every port the registry has handed out, mapped to a human-readable owner. */
export function allocatedPorts(cfg: ClusterConfig): Map<number, string> {
	const used = new Map<number, string>();

	used.set(cfg.proxy.port, "proxy (game)");

	for (const [key, port] of Object.entries(cfg.proxy.ports ?? {})) {
		used.set(port, `proxy (${key})`);
	}

	for (const [name, inst] of Object.entries(cfg.instances)) {
		if (inst.external) {
			continue;
		}

		used.set(inst.port, `${name} (game)`);

		for (const [key, port] of Object.entries(inst.ports ?? {})) {
			used.set(port, `${name} (${key})`);
		}
	}

	return used;
}

/** Lowest unallocated port in a range. Throws when the range is exhausted. */
export function nextFreePort(cfg: ClusterConfig, range: [number, number]): number {
	const used = allocatedPorts(cfg);

	for (let port = range[0]; port <= range[1]; port++) {
		if (!used.has(port)) {
			return port;
		}
	}

	throw new Error(`no free port in range ${range[0]}-${range[1]}`);
}

export interface PortAllocation {
	instance: string;
	key: string;
	port: number;
	written: boolean; // config file patched (false = reserved, config not generated yet)
	configPath: string;
}

/**
 * Ensure every port-declaring plugin has an allocation for each of its targets,
 * and that the plugin config files agree. Mutates cfg (caller saves).
 */
export async function ensurePortAllocations(
	cfg: ClusterConfig,
	lock: PluginsLock,
): Promise<PortAllocation[]> {
	const results: PortAllocation[] = [];
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

				const key = allocKey(pluginName, spec.id);
				const confPath = join(instanceDir(inst), spec.config.file);

				inst.ports ??= {};

				// Adopt an existing value from the config file if we have no allocation yet.
				if (inst.ports[key] === undefined) {
					const existing = await getConfValue(confPath, spec.config.format, spec.config.key);
					const parsed = existing !== undefined ? parseInt(existing) : NaN;

					inst.ports[key] =
						Number.isFinite(parsed) && parsed > 0
							? parsed
							: (spec.fixed ?? nextFreePort(cfg, spec.range));
				}

				const port = inst.ports[key]!;
				const written = await setConfValue(confPath, spec.config.format, spec.config.key, port);

				results.push({ instance: target, key, port, written, configPath: confPath });
			}
		}
	}

	return results;
}

/** Ports currently bound on the host, keyed `"<proto>:<port>"`. */
export async function listeningPorts(): Promise<Map<string, boolean>> {
	const proc = Bun.spawn(["ss", "-tulnH"], { stdout: "pipe", stderr: "ignore" });
	const out = await new Response(proc.stdout).text();

	await proc.exited;

	const map = new Map<string, boolean>();

	for (const line of out.split("\n")) {
		const cols = line.trim().split(/\s+/);

		if (cols.length < 5) {
			continue;
		}

		const proto = cols[0]!.startsWith("udp") ? "udp" : "tcp";
		const local = cols[4]!.match(/:(\d+)$/);

		if (local) {
			map.set(`${proto}:${local[1]}`, true);
		}
	}

	return map;
}

export interface PortIssue {
	kind: "duplicate" | "config-drift" | "velocity-mismatch";
	message: string;
}

/** Ports allocated more than once in the registry. */
function auditDuplicates(cfg: ClusterConfig): PortIssue[] {
	const seen = new Map<number, string[]>();

	const add = (port: number, owner: string): void => {
		if (!seen.has(port)) {
			seen.set(port, []);
		}

		seen.get(port)!.push(owner);
	};

	add(cfg.proxy.port, "proxy game");

	for (const [key, port] of Object.entries(cfg.proxy.ports ?? {})) {
		add(port, `proxy ${key}`);
	}

	for (const [name, inst] of Object.entries(cfg.instances)) {
		if (inst.external) {
			continue;
		}

		add(inst.port, `${name} game`);

		for (const [key, port] of Object.entries(inst.ports ?? {})) {
			add(port, `${name} ${key}`);
		}
	}

	const issues: PortIssue[] = [];

	for (const [port, owners] of seen) {
		// UDP and TCP can legitimately share a number (proxy 25565 game + query) — only
		// flag same-instance-kind duplicates conservatively when owners differ.
		if (owners.length > 1) {
			issues.push({
				kind: "duplicate",
				message: `port ${port} allocated to: ${owners.join(", ")}`,
			});
		}
	}

	return issues;
}

/** Allocations whose plugin config file no longer matches the registry. */
async function auditConfigDrift(cfg: ClusterConfig, lock: PluginsLock): Promise<PortIssue[]> {
	const issues: PortIssue[] = [];
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

				const alloc = inst.ports?.[allocKey(pluginName, spec.id)];
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
					message: `${target}: ${spec.config.file} has ${spec.config.key}=${actual}, registry says ${alloc}`,
				});
			}
		}
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

		const expected = inst.external ?? `127.0.0.1:${inst.port}`;

		if (addr !== expected) {
			issues.push({
				kind: "velocity-mismatch",
				message: `velocity.toml "${name}" = ${addr}, expected ${expected}`,
			});
		}
	}

	return issues;
}

/**
 * Cross-check the three places a port can be recorded: the registry, the plugin
 * config files on disk, and velocity.toml's server table.
 */
export async function auditPorts(
	cfg: ClusterConfig,
	lock: PluginsLock,
	velocityServers: Record<string, string>,
): Promise<PortIssue[]> {
	return [
		...auditDuplicates(cfg),
		...(await auditConfigDrift(cfg, lock)),
		...auditVelocity(cfg, velocityServers),
	];
}

/** Protocol a plugin allocation binds on, from its port spec. */
function portProtocol(lock: PluginsLock, key: string): "tcp" | "udp" {
	const [plugin, id] = key.split("/");
	const entry = lock.plugins[plugin!];
	const specs = entry ? portSpecsFor(entry) : undefined;

	return specs?.find((spec) => spec.id === id)?.protocol ?? "tcp";
}

/** Every allocated port with its owner and whether it is currently bound. */
export async function collectPortRows(
	cfg: ClusterConfig,
	lock: PluginsLock,
): Promise<PortRow[]> {
	const listening = await listeningPorts();
	const rows: PortRow[] = [];

	const push = (row: Omit<PortRow, "listening">): void => {
		rows.push({ ...row, listening: listening.get(`${row.protocol}:${row.port}`) ?? false });
	};

	push({ port: cfg.proxy.port, protocol: "tcp", owner: "proxy", kind: "game", source: "cluster" });

	for (const [key, port] of Object.entries(cfg.proxy.ports ?? {})) {
		push({
			port,
			protocol: portProtocol(lock, key),
			owner: "proxy",
			kind: `plugin:${key}`,
			source: "cluster",
		});
	}

	for (const [name, inst] of Object.entries(cfg.instances)) {
		if (inst.external) {
			const port = inst.external.match(/:(\d+)$/);

			// external servers are not probed — we only record the port they advertise
			if (port) {
				rows.push({
					port: parseInt(port[1]!),
					protocol: "tcp",
					owner: name,
					kind: "external",
					source: "cluster",
				});
			}

			continue;
		}

		push({ port: inst.port, protocol: "tcp", owner: name, kind: "game", source: "cluster" });

		for (const [key, port] of Object.entries(inst.ports ?? {})) {
			push({
				port,
				protocol: portProtocol(lock, key),
				owner: name,
				kind: `plugin:${key}`,
				source: "cluster",
			});
		}
	}

	return rows.sort((a, b) => a.port - b.port);
}
