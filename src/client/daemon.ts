/**
 * Client access to the daemon-native surface: sampler-enriched statuses,
 * metric history, the cluster event log, UI transitions, and the daemons
 * management view. These have no core counterpart — they are the daemon's own.
 */

import type { ClusterEvent } from "../daemon/events";
import type { DaemonRow, FollowerStats } from "../daemon/hub";
import type { MetricSample, StatusCheck, UiState } from "../daemon/sampler";

import { call } from "./rpc";

export type { ClusterEvent, DaemonRow, FollowerStats, MetricSample, StatusCheck, UiState };

export const listStatuses = call("daemon.listStatuses") as () => Promise<{
	instances: Array<Record<string, unknown>>;
	externals: Array<Record<string, unknown>>;
	hostMemMb: number;
	lunaProblem: string | null;
}>;

export const instanceStatus = call("daemon.instanceStatus") as (
	name: string,
) => Promise<Record<string, unknown>>;

export const getHistory = call("daemon.getHistory") as (name: string) => Promise<MetricSample[]>;

export const markTransition = call("daemon.markTransition") as (
	name: string,
	state: "stopping" | "restarting",
) => Promise<void>;

export const clearTransition = call("daemon.clearTransition") as (name: string) => Promise<void>;

export const readHostMemMb = call("daemon.readHostMemMb") as () => Promise<number>;

export const lunaProblem = call("daemon.lunaProblem") as () => Promise<string | undefined>;

export const pushEvent = call("daemon.pushEvent") as (
	instance: string,
	kind: ClusterEvent["kind"],
	message: string,
) => Promise<void>;

export const getEvents = call("daemon.getEvents") as (
	instance?: string,
) => Promise<ClusterEvent[]>;

export const listDaemons = call("daemon.listDaemons") as () => Promise<DaemonRow[]>;
