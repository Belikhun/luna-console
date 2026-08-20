// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Server-side bridge between the SvelteKit console and the luna daemon.
 *
 * Everything stateful moved into the daemon (DESIGN.md §4): the metrics
 * sampler, the transient starting/stopping states, the event log and the
 * schedule runner all live there now; this module re-exports the daemon
 * client surface under the names the routes always used, so the console reads
 * the same truth the CLI does, over the same socket.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';

import {
	loadCluster,
	loadLock,
	managedInstances,
	instanceDir,
	root,
	expandTargets
} from '$core/config';

export { loadCluster, loadLock, managedInstances, instanceDir, root, expandTargets };

export {
	listStatuses,
	instanceStatus,
	getHistory,
	readHostMemMb,
	instanceThreads,
	lunaProblem,
	getEvents
} from '$client/daemon';

export type { UiState, MetricSample, ClusterEvent, StatusCheck, ThreadReport, ThreadSample } from '$client/daemon';

import * as daemon from '$client/daemon';
import type { ClusterEvent } from '$client/daemon';
import { dfetch } from '$client/socket';

/**
 * Reach the daemon's HTTP API directly, for the routes that move bytes.
 *
 * The RPC bridge above carries JSON arguments, which is right for everything
 * that describes work and wrong for everything that *is* data: a world zip on
 * the way in and a backup archive on the way out are both measured in
 * gigabytes, and neither can be serialised into an argument list. Those two go
 * over the same unix socket as a streamed body instead, and this is the door.
 */
export async function daemonFetch(path: string, init?: RequestInit): Promise<Response> {
	return await dfetch(path, init);
}

/**
 * Fire-and-forget wrappers: these were synchronous when the state lived in this
 * process, and their call sites treat them as statements. A daemon hiccup must
 * not become an unhandled rejection in a route.
 */
export function pushEvent(instance: string, kind: ClusterEvent['kind'], message: string): void {
	void daemon.pushEvent(instance, kind, message).catch(() => {});
}

/** Mark an instance as mid-transition, so the UI can show it before core catches up. */
export function markTransition(name: string, state: 'stopping' | 'restarting'): void {
	void daemon.markTransition(name, state).catch(() => {});
}

/** Drop an instance's transient state immediately. */
export function clearTransition(name: string): void {
	void daemon.clearTransition(name).catch(() => {});
}

/** Path to the compiled CLI binary (for the terminal's exec route). */
export function cliBinary(): string {
	const bin = join(root(), 'control', 'dist', 'luna');

	return existsSync(bin) ? bin : 'luna';
}

export const INTERACTIVE_COMMANDS = new Set(['console']);
