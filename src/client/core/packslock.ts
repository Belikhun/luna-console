/**
 * Bridge mirror of core/packslock: key derivation and zip validation are pure;
 * the lock file itself lives on the daemon's disk.
 */

import type * as core from "../../core/packslock";

import { call } from "../rpc";

export { PACK_KEY_PATTERN, packKeyFrom, decodePackZip } from "../../core/packslock";
export type {
	PackSource,
	PackChannel,
	PackInstall,
	PackEntry,
	DataPackEntry,
	PacksLock,
} from "../../core/packslock";

export const loadPacksLock = call("packslock.loadPacksLock") as typeof core.loadPacksLock;
export const savePacksLock = call("packslock.savePacksLock", { lock: 0 }) as typeof core.savePacksLock;
