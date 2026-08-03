/**
 * Bridge mirror of core/playerlists — the access-list files live in the
 * instance directory, so reads and writes run on the daemon that owns the
 * instance; the RPC layer routes each call there.
 */

import type * as core from "../../core/playerlists";

import { call } from "../rpc";

export { offlineUuid, ACCESS_LIST_FILES } from "../../core/playerlists";
export type {
	AccessListKind,
	AccessLists,
	AccessChange,
	AccessChangeResult,
	WhitelistEntry,
	OpEntry,
	BanEntry,
	IpBanEntry,
	WhitelistToggleResult,
} from "../../core/playerlists";

export const getAccessLists = call("playerlists.get", { cfg: 0 }) as typeof core.getAccessLists;
export const applyAccessChange = call("playerlists.apply", { cfg: 0 }) as typeof core.applyAccessChange;
export const setWhitelistEnabled = call("playerlists.setWhitelist", { cfg: 0 }) as typeof core.setWhitelistEnabled;
