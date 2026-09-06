// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/playerstate; a player's save lives under the instance's
 * world, so every read runs on the daemon that owns the instance and the RPC
 * layer routes each call there. The shapes and the pure helpers are in
 * `core/playerdata`, re-exported by the sibling bridge of that name.
 */

import type * as core from "../../core/playerstate";

import { call } from "../rpc";

export const readPlayerRoster = call("playerstate.roster", { cfg: 0 }) as typeof core.readPlayerRoster;
export const readPlayerDetail = call("playerstate.detail", { cfg: 0 }) as typeof core.readPlayerDetail;
export const resolvePlayerRef = call("playerstate.resolve", { cfg: 0 }) as typeof core.resolvePlayerRef;
export const listSavedPlayers = call("playerstate.saved", { cfg: 0 }) as typeof core.listSavedPlayers;
