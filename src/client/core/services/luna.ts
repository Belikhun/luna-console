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
	RegisteredPlayer,
	RegisteredPlayerList,
	RegisteredPlayerQuery,
	RegisteredPlayerDetail,
	PlayerPermissionsSummary,
	PlayerServerPlaytime,
	PlaySession,
	PlaySessionPage,
	PlayerChatEntry,
	PlayerChatPage,
	ModerationEntry,
	ModerationPage,
	ModerationRecord,
	PermissionNode,
	PermissionGroupSummary,
	PermissionGroupDetail,
	PermissionUserDetail,
	NodeChange,
	SkinInfo,
	SkinChange,
	SkinChangeResult,
	AuthSession,
	AuthAccountInfo,
	AuthChange,
	AuthChangeResult,
	VaultCurrency,
	VaultSummary,
	VaultAccountInfo,
	VaultTransaction,
	VaultTransactionPage,
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
export const registeredPlayers = call("lunaApi.registeredPlayers") as typeof core.registeredPlayers;
export const registeredPlayer = call("lunaApi.registeredPlayer") as typeof core.registeredPlayer;
export const playerSessions = call("lunaApi.playerSessions") as typeof core.playerSessions;
export const playerChat = call("lunaApi.playerChat") as typeof core.playerChat;
export const playerModeration = call("lunaApi.playerModeration") as typeof core.playerModeration;
export const recordModeration = call("lunaApi.recordModeration") as typeof core.recordModeration;
export const permissionGroups = call("lunaApi.permissionGroups") as typeof core.permissionGroups;
export const permissionGroup = call("lunaApi.permissionGroup") as typeof core.permissionGroup;
export const createPermissionGroup = call("lunaApi.createPermissionGroup") as typeof core.createPermissionGroup;
export const deletePermissionGroup = call("lunaApi.deletePermissionGroup") as typeof core.deletePermissionGroup;
export const editGroupNode = call("lunaApi.editGroupNode") as typeof core.editGroupNode;
export const editGroupMeta = call("lunaApi.editGroupMeta") as typeof core.editGroupMeta;
export const permissionUser = call("lunaApi.permissionUser") as typeof core.permissionUser;
export const editUserNode = call("lunaApi.editUserNode") as typeof core.editUserNode;
export const editUserGroups = call("lunaApi.editUserGroups") as typeof core.editUserGroups;
export const skinInfo = call("lunaApi.skinInfo") as typeof core.skinInfo;
export const setSkin = call("lunaApi.setSkin") as typeof core.setSkin;
export const authAccount = call("lunaApi.authAccount") as typeof core.authAccount;
export const setAuth = call("lunaApi.setAuth") as typeof core.setAuth;
export const vaultAccount = call("lunaApi.vaultAccount") as typeof core.vaultAccount;
export const vaultTransactions = call("lunaApi.vaultTransactions") as typeof core.vaultTransactions;

/** Open a LunaCore SSE stream, tunneled through the daemon. */
export async function openStream(path: string, signal?: AbortSignal): Promise<Response> {
	return await dfetch(`/luna/stream${path}`, { signal });
}
