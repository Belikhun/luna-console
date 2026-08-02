/**
 * Server-side bridge between the SvelteKit console and the luna daemon.
 *
 * Everything stateful moved into the daemon (DESIGN.md §4): the metrics
 * sampler, the transient starting/stopping states, the event log and the
 * schedule runner all live there now — this module re-exports the daemon
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
	lunaProblem,
	getEvents
} from '$client/daemon';

export type { UiState, MetricSample, ClusterEvent, StatusCheck } from '$client/daemon';

import * as daemon from '$client/daemon';
import type { ClusterEvent } from '$client/daemon';

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
