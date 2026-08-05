/**
 * Client access to the daemon-native surface: sampler-enriched statuses,
 * metric history, the cluster event log, UI transitions, and the daemons
 * management view. These have no core counterpart; they are the daemon's own.
 */

import type { ClusterEvent } from "../daemon/events";
import type { HealthSample } from "../daemon/health";
import type { DaemonCheck, DaemonDetail, DaemonRow, ReachResult } from "../daemon/hub";
import type {
	BinaryMeta,
	UpgradeCheck,
	UpgradeChannel,
	UpgradeOffer,
	UpgradeResult,
} from "../daemon/upgrade";
import type { MetricSample, StatusCheck, UiState } from "../daemon/sampler";

import { call } from "./rpc";
import { followSse } from "./socket";

export type {
	BinaryMeta,
	ClusterEvent,
	DaemonCheck,
	DaemonDetail,
	DaemonRow,
	HealthSample,
	MetricSample,
	ReachResult,
	StatusCheck,
	UiState,
	UpgradeCheck,
	UpgradeChannel,
	UpgradeOffer,
	UpgradeResult,
};

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

export const daemonDetail = call("daemon.daemonDetail") as (
	name: string,
) => Promise<DaemonDetail | null>;

export const daemonHealth = call("daemon.health") as () => Promise<HealthSample | undefined>;

export const daemonHealthHistory = call("daemon.healthHistory") as () => Promise<HealthSample[]>;

export const binaryMeta = call("daemon.binaryMeta") as () => Promise<BinaryMeta>;

/**
 * Upgrade one daemon: a follower pulls the primary's binary, the primary pulls
 * the GitHub release. The daemon exits as it answers, so a successful call
 * means "the swap happened and its service manager is restarting it".
 */
export const upgradeDaemon = call("daemon.upgradeDaemon") as (
	name: string,
	force?: boolean,
) => Promise<UpgradeResult>;

/**
 * What one daemon could upgrade to, primary channel first and the GitHub
 * release as the fallback. Applies nothing. `refresh` bypasses the daemon's
 * cached GitHub answer.
 */
export const checkDaemonUpgrade = call("daemon.checkDaemonUpgrade") as (
	name: string,
	refresh?: boolean,
) => Promise<UpgradeCheck>;

/**
 * Follow the daemon's fleet health stream: one frame per heartbeat cadence with
 * every daemon's row, live health included. Resolves when the stream ends.
 */
export async function followDaemons(
	onFrame: (daemons: DaemonRow[]) => void,
	signal?: AbortSignal,
): Promise<void> {
	await followSse(
		"/daemons/stream",
		(data) => {
			const frame = data as { daemons?: DaemonRow[] };

			if (Array.isArray(frame.daemons)) {
				onFrame(frame.daemons);
			}
		},
		signal,
	);
}
