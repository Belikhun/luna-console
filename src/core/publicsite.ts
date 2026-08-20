// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The public page's projection: what an unauthenticated visitor is allowed to
 * know about the cluster.
 *
 * Everything here is an allowlist rather than a filter. The snapshot is built
 * field by field from cluster state, so a new field added to `InstanceConfig`
 * or to `HealthSample` cannot reach the internet by having been forgotten. Host
 * addresses, disk paths, machine names, port numbers and the instances that did
 * not opt in are all absent by construction.
 *
 * Two switches gate it and neither implies the other: `cfg.publicSite.enabled`
 * decides whether the page exists at all, and `inst.publicListed` decides
 * whether one instance appears on it.
 */

import { effectiveTargets } from "./families";
import { instanceDir, managedInstances } from "./config";
import {
	MAP_PROVIDERS,
	resolveMapWebroot,
	type MapProviderId,
	type MapWebroot,
} from "./maps";
import { instanceAddress, portSpecsFor } from "./ports";
import { series, type UptimeStore } from "./uptime";
import type { ClusterConfig, InstanceConfig, PluginsLock, PublicSiteConfig } from "./types";

/** Days of uptime history the public page carries per instance. */
export const PUBLIC_UPTIME_DAYS = 90;

/** Whether the public page exists on this cluster. */
export function publicEnabled(cfg: ClusterConfig): boolean {
	return cfg.publicSite?.enabled === true;
}

/**
 * Instances that may appear on the public page, listed or not.
 *
 * `cfg.instances` rather than `managedInstances`, which folds in the proxy: the
 * proxy is the thing players connect *through*, it has no world and no version,
 * and its port is the one address the page already advertises. An external
 * server is included, because the proxy still reports its players and it is a
 * place people can join; it simply never has a map of its own.
 */
export function listableInstances(cfg: ClusterConfig): Array<[string, InstanceConfig]> {
	return Object.entries(cfg.instances);
}

/** Instances that appear on the public page, in registry order. */
export function publicInstances(cfg: ClusterConfig): Array<[string, InstanceConfig]> {
	return listableInstances(cfg).filter(([, inst]) => inst.publicListed === true);
}

/** Whether one instance is listed; the gate every per-instance route repeats. */
export function isPublicInstance(cfg: ClusterConfig, name: string): boolean {
	return cfg.instances[name]?.publicListed === true;
}

/** Where an instance's own map webserver can be reached. */
export interface MapEndpoint {
	/** Host:port of the map's own webserver, on the machine that runs it */
	origin: string;
	/** Which map is answering there; the console renders a different HUD per map */
	provider: MapProviderId;
	/** Lock key of the entry providing it, e.g. "bluemap@paper" */
	entry: string;
}

/**
 * Where an instance's map answers live, or undefined when nothing is listening.
 *
 * A narrower question than `mapAccessFor`: this one is only about the plugin's
 * own webserver, so an instance whose map is served purely from its rendered
 * files answers undefined here and still has a map.
 */
export function mapEndpointFor(
	cfg: ClusterConfig,
	lock: PluginsLock,
	name: string,
): MapEndpoint | undefined {
	const access = mapAccessFor(cfg, lock, name);

	if (!access?.origin) {
		return undefined;
	}

	return { origin: access.origin, provider: access.provider, entry: access.entry };
}

/** Which map an instance carries, and where it answers live if it does. */
export interface MapAccess {
	provider: MapProviderId;
	/** Lock key of the entry providing it, e.g. "dynmap@forge" */
	entry: string;
	/**
	 * Host:port of the map's own webserver, or null when it binds no port.
	 *
	 * Null is a normal, supported setup rather than a broken one. Dynmap's own
	 * documented arrangement for an external webserver is to write its files down
	 * and turn its listener off, and luna *is* that external webserver, so an
	 * instance can carry a perfectly good map with nothing listening: everything
	 * comes off the rendered files instead.
	 */
	origin: string | null;
}

/**
 * Which map plugin is deployed to an instance, whether or not it has a port.
 *
 * The gate every map route repeats, and the pure one: the lockfile alone answers
 * it, so the public snapshot can carry it without touching a disk. Where the map
 * is *reachable* is a second question, and the answer may be "nowhere, read the
 * files".
 */
export function mapAccessFor(
	cfg: ClusterConfig,
	lock: PluginsLock,
	name: string,
): MapAccess | undefined {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		return undefined;
	}

	for (const provider of MAP_PROVIDERS) {
		for (const [key, entry] of Object.entries(lock.plugins)) {
			if (entry.remote?.slug !== provider.slug) {
				continue;
			}

			if (!effectiveTargets(cfg, lock, key).includes(name)) {
				continue;
			}

			const spec = portSpecsFor(entry)?.find((binding) => binding.protocol === "tcp");
			const port = spec ? inst.ports?.[`${key}/${spec.id}`] : undefined;

			// the game port is what instanceAddress returns; only its host is wanted,
			// because the map answers on a port of its own
			const host = instanceAddress(cfg, inst).split(":")[0];

			return {
				provider: provider.id,
				entry: key,
				origin: port ? `${host}:${port}` : null,
			};
		}
	}

	return undefined;
}

/**
 * The rendered webroot of whichever map an instance carries, on this machine.
 *
 * The lockfile decides which provider to look for, exactly as `mapEndpointFor`
 * does, so the two never disagree about what an instance has; the disk decides
 * whether anything has been rendered.
 */
export async function mapWebrootFor(
	cfg: ClusterConfig,
	lock: PluginsLock,
	name: string,
): Promise<MapWebroot | undefined> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		return undefined;
	}

	const access = mapAccessFor(cfg, lock, name);
	const provider = access
		? MAP_PROVIDERS.find((entry) => entry.id === access.provider)
		: undefined;

	if (!provider) {
		return undefined;
	}

	return await resolveMapWebroot(instanceDir(inst), provider);
}

/**
 * What is known about an instance's map without opening it: which provider, where
 * it answers live, and whether the rendered files can be served on their own.
 *
 * One call rather than three because every caller wants the same picture, and
 * because "has a map" and "has a map that survives a stop" are different
 * questions that a single boolean kept conflating.
 */
export interface MapSource {
	provider: MapProviderId;
	entry: string;
	/** Null when the map binds no port of its own; the files are then the only source */
	origin: string | null;
	/** Absent when nothing is rendered on the owning machine, or it is not local */
	webroot?: string;
	/** Whether the rendered files boot without the server; false needs the server */
	offlineReady: boolean;
}

/** Resolve one instance's map source; local disk facts included. */
export async function mapSourceFor(
	cfg: ClusterConfig,
	lock: PluginsLock,
	name: string,
): Promise<MapSource | undefined> {
	const access = mapAccessFor(cfg, lock, name);

	if (!access) {
		return undefined;
	}

	const webroot = await mapWebrootFor(cfg, lock, name);

	return {
		provider: access.provider,
		entry: access.entry,
		origin: access.origin,
		webroot: webroot?.dir,
		offlineReady: webroot?.offlineReady ?? false,
	};
}

// -- the wire payload -----------------------------------------------------------

/** A point in a public chart; `v` absent means nobody measured that bucket. */
export interface PublicPoint {
	t: number;
	v?: number;
}

/** One instance, as the public page sees it. */
export interface PublicInstanceCard {
	name: string;
	/** MiniMessage display name; falls back to the instance name */
	display: string;
	accentColor: string | null;
	/** Bukkit material of the selector icon, for the card art fallback */
	icon: string | null;
	description: string[];
	software: string;
	mcVersion: string | null;
	online: boolean;
	players: number | null;
	maxPlayers: number | null;
	tps: number | null;
	uptimeMs: number | null;
	/** Process CPU, as a percentage of one core */
	cpu: number | null;
	/** Cores of the machine it runs on, so a reader can scale `cpu` against them */
	cpuCores: number | null;
	/** Resident size and the instance's configured ceiling, in MB */
	memUsedMb: number | null;
	memMaxMb: number | null;
	/** What the server is holding; null on a platform that cannot count it */
	chunks: number | null;
	tickingEntities: number | null;
	nonTickingEntities: number | null;
	/** 0-1 tick performance index, and the player-weighted share of slow ticks */
	apdex: number | null;
	misery: number | null;
	/** Whether an embeddable map exists; never where it lives */
	hasMap: boolean;
	/** Which map it is, so the page draws that map's controls; null when there is none */
	mapProvider: MapProviderId | null;
	uptime: { days: Array<{ d: string; up: number; seen: number }>; pct: number | null };
}

/** Everything the public page renders, in one document. */
export interface PublicSnapshot {
	site: {
		title: string;
		tagline: string | null;
		address: string | null;
		generatedAt: number;
	};
	totals: {
		players: number;
		maxPlayers: number;
		instancesOnline: number;
		instancesTotal: number;
		avgTps: number | null;
		cpuPct: number | null;
		memUsedMb: number | null;
		memTotalMb: number | null;
		machines: number;
	};
	series: {
		players: PublicPoint[];
		cpu: PublicPoint[];
		memUsedMb: PublicPoint[];
	};
	instances: PublicInstanceCard[];
}

/** How samples from several machines are folded into one series. */
export type CombineMode = "sum" | "avg";

/**
 * Align several machines' series onto one timeline and combine them.
 *
 * Daemons sample on independent timers, so their timestamps never line up;
 * bucketing to the sample interval is what makes "the fleet's CPU" a number
 * rather than a sawtooth. A bucket no machine measured stays absent, which the
 * console's Sparkline already draws as a gap rather than as a dip to zero.
 */
export function combineSeries(
	sources: Array<Array<{ t: number; v: number | undefined }>>,
	mode: CombineMode,
	bucketMs: number,
	window: number,
): PublicPoint[] {
	const buckets = new Map<number, { total: number; count: number }>();

	for (const source of sources) {
		for (const point of source) {
			if (point.v === undefined || !Number.isFinite(point.v)) {
				continue;
			}

			const key = Math.floor(point.t / bucketMs) * bucketMs;
			const bucket = buckets.get(key) ?? { total: 0, count: 0 };

			bucket.total += point.v;
			bucket.count += 1;
			buckets.set(key, bucket);
		}
	}

	const keys = [...buckets.keys()].sort((a, b) => a - b).slice(-window);

	return keys.map((key) => {
		const bucket = buckets.get(key)!;

		return {
			t: key,
			v: mode === "sum" ? bucket.total : bucket.total / bucket.count,
		};
	});
}

/** What the daemon hands the builder; everything it cannot compute on its own. */
export interface PublicSnapshotInput {
	cfg: ClusterConfig;
	lock: PluginsLock;
	/** One entry per daemon, each its own health history */
	fleet: Array<Array<{ t: number; cpuPct: number; memUsedMb: number; memTotalMb: number }>>;
	/** Per-instance metric history, keyed by instance name */
	metrics: Record<string, Array<{ t: number; players?: number; tps?: number }>>;
	/** Live status per instance, keyed by name */
	status: Record<
		string,
		{
			online: boolean;
			players: number | null;
			maxPlayers: number | null;
			tps: number | null;
			uptimeMs: number | null;
			cpu?: number | null;
			cpuCores?: number | null;
			rssMb?: number | null;
			memMaxMb?: number | null;
			chunks?: number | null;
			tickingEntities?: number | null;
			nonTickingEntities?: number | null;
			apdex?: number | null;
			misery?: number | null;
		}
	>;
	uptime: UptimeStore;
	/** Machines counted as usable right now */
	machines: number;
	bucketMs: number;
	window: number;
	now: number;
}

/** Site heading and address, with the defaults a bare config falls back to. */
function siteOf(config: PublicSiteConfig | undefined, now: number): PublicSnapshot["site"] {
	return {
		title: config?.title?.trim() || "Minecraft network",
		tagline: config?.tagline?.trim() || null,
		address: config?.address?.trim() || null,
		generatedAt: now,
	};
}

/**
 * Build the public document.
 *
 * Pure: every input is handed in, so the same cluster state always produces the
 * same snapshot and the daemon owns all the I/O.
 */
export function buildPublicSnapshot(input: PublicSnapshotInput): PublicSnapshot {
	const listed = publicInstances(input.cfg);
	const cards: PublicInstanceCard[] = [];

	let players = 0;
	let maxPlayers = 0;
	let online = 0;
	let tpsTotal = 0;
	let tpsCount = 0;

	for (const [name, inst] of listed) {
		const status = input.status[name];
		const window = series(input.uptime, name, PUBLIC_UPTIME_DAYS, input.now);
		const map = mapAccessFor(input.cfg, input.lock, name);

		if (status?.online) {
			online += 1;
			players += status.players ?? 0;

			if (status.tps !== null && status.tps !== undefined) {
				tpsTotal += status.tps;
				tpsCount += 1;
			}
		}

		maxPlayers += status?.maxPlayers ?? 0;

		cards.push({
			name,
			display: inst.serverDisplay ?? name,
			accentColor: inst.accentColor ?? null,
			icon: inst.serverIcon ?? null,
			description: inst.description ?? [],
			software: inst.software,
			mcVersion: inst.mcVersion ?? null,
			online: status?.online ?? false,
			players: status?.players ?? null,
			maxPlayers: status?.maxPlayers ?? null,
			tps: status?.tps ?? null,
			uptimeMs: status?.uptimeMs ?? null,
			cpu: status?.cpu ?? null,
			cpuCores: status?.cpuCores ?? null,
			memUsedMb: status?.rssMb ?? null,
			memMaxMb: status?.memMaxMb ?? null,
			chunks: status?.chunks ?? null,
			tickingEntities: status?.tickingEntities ?? null,
			nonTickingEntities: status?.nonTickingEntities ?? null,
			apdex: status?.apdex ?? null,
			misery: status?.misery ?? null,
			hasMap: map !== undefined,
			mapProvider: map?.provider ?? null,
			// stops are dropped on the way out: an operator wants the incident count,
			// a visitor wants to know whether it was up
			uptime: {
				days: window.days.map((day) => ({ d: day.d, up: day.up, seen: day.seen })),
				pct: window.pct,
			},
		});
	}

	const wanted = new Set(listed.map(([name]) => name));

	const playerSeries = Object.entries(input.metrics)
		.filter(([name]) => wanted.has(name))
		.map(([, history]) => history.map((sample) => ({ t: sample.t, v: sample.players })));

	const latest = input.fleet.map((history) => history.at(-1)).filter((sample) => sample !== undefined);

	return {
		site: siteOf(input.cfg.publicSite, input.now),
		totals: {
			players,
			maxPlayers,
			instancesOnline: online,
			instancesTotal: listed.length,
			avgTps: tpsCount ? Math.round((tpsTotal / tpsCount) * 100) / 100 : null,
			cpuPct: latest.length
				? Math.round(latest.reduce((sum, sample) => sum + sample.cpuPct, 0) / latest.length)
				: null,
			memUsedMb: latest.length
				? Math.round(latest.reduce((sum, sample) => sum + sample.memUsedMb, 0))
				: null,
			memTotalMb: latest.length
				? Math.round(latest.reduce((sum, sample) => sum + sample.memTotalMb, 0))
				: null,
			machines: input.machines,
		},
		series: {
			players: combineSeries(playerSeries, "sum", input.bucketMs, input.window),
			cpu: combineSeries(
				input.fleet.map((history) => history.map((sample) => ({ t: sample.t, v: sample.cpuPct }))),
				"avg",
				input.bucketMs,
				input.window,
			),
			memUsedMb: combineSeries(
				input.fleet.map((history) => history.map((sample) => ({ t: sample.t, v: sample.memUsedMb }))),
				"sum",
				input.bucketMs,
				input.window,
			),
		},
		instances: cards,
	};
}
