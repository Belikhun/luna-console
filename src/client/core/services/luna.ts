/**
 * Bridge mirror of core/services/luna — LunaCore's HTTP API is reachable from
 * the proxy's host, so every call goes through the daemon. The SSE stream is
 * proxied through the daemon's /luna/stream passthrough.
 */

import type * as core from "../../../core/services/luna";

import { call } from "../../rpc";
import { dfetch } from "../../socket";

export type {
	BackendCard,
	BackendDetail,
	DashboardSnapshot,
	LunaResult,
	PlayerList,
	PlayerActivity,
	CommandResult,
	TransferResult,
} from "../../../core/services/luna";

export const dashboard = call("lunaApi.dashboard") as typeof core.dashboard;
export const backend = call("lunaApi.backend") as typeof core.backend;
export const players = call("lunaApi.players") as typeof core.players;
export const playerHistory = call("lunaApi.playerHistory") as typeof core.playerHistory;
export const runCommand = call("lunaApi.runCommand") as typeof core.runCommand;
export const broadcast = call("lunaApi.broadcast") as typeof core.broadcast;
export const kick = call("lunaApi.kick") as typeof core.kick;
export const message = call("lunaApi.message") as typeof core.message;
export const transfer = call("lunaApi.transfer") as typeof core.transfer;

/** Open a LunaCore SSE stream, tunneled through the daemon. */
export async function openStream(path: string, signal?: AbortSignal): Promise<Response> {
	return await dfetch(`/luna/stream${path}`, { signal });
}
