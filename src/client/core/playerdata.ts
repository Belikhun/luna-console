// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/playerdata: pure shapes and label helpers, nothing
 * else. Nothing here may reach the RPC client; console components import this
 * module directly, so it has to stay free of every node built-in (see
 * `software.ts` for the rule and the reason).
 */

export {
	GAME_MODES,
	EQUIPMENT_SLOTS,
	INVENTORY_SLOTS,
	ENDER_CHEST_SLOTS,
	gameModeOf,
	dimensionLabel,
	idLabel,
	xpToNextLevel,
	ticksToMillis,
	advancementGroup,
	isRecipeAdvancement,
	heartsOf,
} from "../../core/playerdata";

export type {
	GameMode,
	EquipmentSlot,
	PlayerItem,
	PlayerPosition,
	PlayerEffect,
	PlayerVitals,
	PlayerSnapshot,
	AdvancementCriterion,
	PlayerAdvancement,
	PlayerAdvancements,
	PlayerStats,
	PlayerDetail,
	PlayerRosterEntry,
	SavedPlayer,
} from "../../core/playerdata";
