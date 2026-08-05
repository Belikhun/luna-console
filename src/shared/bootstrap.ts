/**
 * What an empty cluster looks like.
 *
 * `core/` bails when `cluster.json` is missing; nothing in it can run without
 * the registry; so a machine being set up for the first time needs one written
 * before its daemon starts. That skeleton is domain knowledge, not installer
 * trivia, but the installer runs before any daemon exists to ask, which is why
 * it lives here rather than behind an RPC in `core/`.
 *
 * A follower never needs this: the primary syncs the registry down over the
 * cluster link as soon as the link comes up.
 */

import type { ClusterConfig } from "../core/types";

/** Aikar's flags; the default profile every instance starts from. */
const AIKAR_FLAGS = [
	"-XX:+UseG1GC",
	"-XX:+ParallelRefProcEnabled",
	"-XX:MaxGCPauseMillis=200",
	"-XX:+UnlockExperimentalVMOptions",
	"-XX:+DisableExplicitGC",
	"-XX:+AlwaysPreTouch",
	"-XX:G1HeapWastePercent=5",
	"-XX:G1MixedGCCountTarget=4",
	"-XX:InitiatingHeapOccupancyPercent=15",
	"-XX:G1MixedGCLiveThresholdPercent=90",
	"-XX:G1RSetUpdatingPauseTimePercent=5",
	"-XX:SurvivorRatio=32",
	"-XX:+PerfDisableSharedMem",
	"-XX:MaxTenuringThreshold=1",
	"-Dusing.aikars.flags=https://mcflags.emc.gs",
	"-Daikars.new.flags=true",
];

export interface StarterOptions {
	/** Port players connect to; the proxy's listener */
	proxyPort?: number;
	/** Memory for the proxy, e.g. "2G" */
	proxyMemory?: string;
	/** Screen session prefix, so several clusters can share a machine */
	screenPrefix?: string;
	/** Port pool new paper instances are allocated from */
	portRange?: [number, number];
}

/**
 * A registry with no instances: the proxy definition, the default java profile
 * and the port pool, which is the least a primary daemon needs to start. The
 * proxy directory it names does not have to exist yet; `luna instance launch`
 * creates it on first use.
 */
export function starterCluster(opts: StarterOptions = {}): ClusterConfig {
	return {
		screenPrefix: opts.screenPrefix ?? "luna.",
		serverPortRange: opts.portRange ?? [32560, 32599],
		javaProfiles: {
			aikar: { flags: [...AIKAR_FLAGS] },
		},
		proxy: {
			dir: "proxy",
			software: "velocity",
			port: opts.proxyPort ?? 25565,
			memory: opts.proxyMemory ?? "2G",
			profile: "aikar",
		},
		instances: {},
		daemons: {},
	};
}
