// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

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

/**
 * Aikar's G1 tuning, the default profile every instance starts from, kept to the
 * flags that still change something on a modern JDK. ParallelRefProcEnabled and
 * the adaptive IHOP that overrides InitiatingHeapOccupancyPercent are JDK
 * defaults since 17. UseCompactObjectHeaders is left out on purpose: it is
 * worth having on Java 25, but a JDK 21 refuses to start with it, and a fresh
 * cluster may well be serving 1.21.
 */
const AIKAR_FLAGS = [
	"-XX:+UseG1GC",
	"-XX:MaxGCPauseMillis=200",
	"-XX:+UnlockExperimentalVMOptions",
	// the young generation is the point: Minecraft allocates hundreds of MB/s
	// of short-lived objects, and G1's default 5% new size promotes them early
	"-XX:G1NewSizePercent=30",
	"-XX:G1MaxNewSizePercent=40",
	"-XX:G1HeapRegionSize=8M",
	"-XX:G1ReservePercent=20",
	"-XX:G1HeapWastePercent=5",
	"-XX:G1MixedGCCountTarget=4",
	"-XX:G1MixedGCLiveThresholdPercent=90",
	"-XX:G1RSetUpdatingPauseTimePercent=5",
	"-XX:SurvivorRatio=32",
	"-XX:MaxTenuringThreshold=1",
	"-XX:+DisableExplicitGC",
	"-XX:+AlwaysPreTouch",
	"-XX:+PerfDisableSharedMem",
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
