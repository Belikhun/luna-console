// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The shape of a player as one backend last saved them, and the pure helpers
 * that turn the raw numbers into words.
 *
 * Nothing here touches a file: this module is imported by the console's
 * components as well as by `core/playerstate.ts`, which does the reading, so it
 * must stay free of `core/config` and of every node built-in. The values are
 * what vanilla writes into `<world>/playerdata/<uuid>.dat`, `advancements/` and
 * `stats/`, which every JVM server keeps in the same format whatever the loader.
 */

/** Vanilla's four modes, indexed by the id `playerGameType` stores. */
export const GAME_MODES = ["survival", "creative", "adventure", "spectator"] as const;

export type GameMode = (typeof GAME_MODES)[number];

/** Armour and offhand slots, in the order the inventory screen draws them. */
export const EQUIPMENT_SLOTS = ["head", "chest", "legs", "feet", "offhand"] as const;

export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];

/** How many main-inventory slots a player has, hotbar included. */
export const INVENTORY_SLOTS = 36;

/** Slots in an ender chest. */
export const ENDER_CHEST_SLOTS = 27;

/** One item stack, flattened out of whichever item format the save used. */
export interface PlayerItem {
	/** Container slot index; hotbar 0-8, main 9-35, ender chest 0-26 */
	slot: number;
	/** Namespaced id, e.g. `minecraft:diamond_helmet` */
	id: string;
	count: number;
	/** Enchantment id to level; stored enchantments on a book count too */
	enchantments: Record<string, number>;
	/** Damage taken, for something with durability */
	damage?: number;
	maxDamage?: number;
	/** Plain text of a custom name, formatting stripped */
	customName?: string;
	lore: string[];
	/** `minecraft:custom_data`, the compound plugins hang their identity on */
	customData?: Record<string, unknown>;
	/** What a shulker box or bundle holds */
	contents?: PlayerItem[];
}

export interface PlayerPosition {
	x: number;
	y: number;
	z: number;
	/** Namespaced dimension id, e.g. `minecraft:the_nether` */
	dimension: string;
	yaw?: number;
	pitch?: number;
}

export interface PlayerEffect {
	id: string;
	amplifier: number;
	/** Ticks left; -1 is infinite */
	duration: number;
	ambient: boolean;
}

/**
 * The facts the online table shows for a player: everything in the save except
 * what they are carrying. Cheap to build for a roster, and the detail view adds
 * the rest.
 */
export interface PlayerVitals {
	uuid: string;
	/** When the backend last wrote the file, epoch ms */
	savedAt: number;
	dataVersion?: number;
	health: number;
	maxHealth: number;
	absorption: number;
	food: number;
	saturation: number;
	exhaustion: number;
	xpLevel: number;
	/** 0-1, progress into the current level */
	xpProgress: number;
	xpTotal: number;
	score: number;
	/** Air ticks left, out of 300 */
	air: number;
	/** Fire ticks; negative while not burning */
	fire: number;
	gameModeId: number;
	gameMode: GameMode | "unknown";
	position: PlayerPosition;
	flying: boolean;
	mayFly: boolean;
	invulnerable: boolean;
	selectedSlot: number;
	seenCredits: boolean;
	/** Paper's own bookkeeping, when the fork writes it */
	firstPlayed?: number;
	lastPlayed?: number;
	lastLogin?: number;
	lastKnownName?: string;
	effects: PlayerEffect[];
}

/** The full save: vitals plus the inventories and the rest of the compound. */
export interface PlayerSnapshot extends PlayerVitals {
	inventory: PlayerItem[];
	equipment: Partial<Record<EquipmentSlot, PlayerItem>>;
	enderChest: PlayerItem[];
	respawn?: PlayerPosition;
	lastDeath?: PlayerPosition;
	walkSpeed: number;
	flySpeed: number;
	/** Attribute id to base value */
	attributes: Record<string, number>;
	deathTime: number;
	sleepTimer: number;
	portalCooldown: number;
	ticksLived?: number;
}

export interface AdvancementCriterion {
	name: string;
	/** Epoch ms parsed from the save's date string; 0 when unparseable */
	at: number;
}

export interface PlayerAdvancement {
	id: string;
	done: boolean;
	/** A recipe unlock, which the game never shows as an advancement */
	recipe: boolean;
	criteria: AdvancementCriterion[];
	/** The latest criterion date; when it was completed, for a done one */
	at: number;
}

export interface PlayerAdvancements {
	/** Advancements proper, recipes excluded */
	total: number;
	done: number;
	recipes: number;
	entries: PlayerAdvancement[];
	dataVersion?: number;
}

/** The stats file as the game keys it: `minecraft:mined` → `minecraft:stone` → count. */
export interface PlayerStats {
	sections: Record<string, Record<string, number>>;
	dataVersion?: number;
}

/** Everything the detail screen shows, in one read. */
export interface PlayerDetail {
	uuid: string;
	/** The name the server's own usercache knows the id by, when it does */
	name?: string;
	snapshot: PlayerSnapshot | null;
	advancements: PlayerAdvancements | null;
	stats: PlayerStats | null;
	/** Files that exist but could not be read, named so the screen can say so */
	problems: string[];
}

/** One row of the online roster's saved-state half. */
export interface PlayerRosterEntry {
	uuid: string;
	/** Null when the backend has never saved this player */
	vitals: PlayerVitals | null;
	advancements: { done: number; total: number } | null;
}

/** A player the backend holds a save for, online or not. */
export interface SavedPlayer {
	uuid: string;
	name?: string;
	savedAt: number;
}

/** The game mode a `playerGameType` id names. */
export function gameModeOf(id: number): GameMode | "unknown" {
	return GAME_MODES[id] ?? "unknown";
}

/**
 * A dimension id as a heading: the three vanilla ones by their in-game names,
 * anything else by its path with the namespace dropped and words capitalised.
 */
export function dimensionLabel(id: string): string {
	switch (id) {
		case "minecraft:overworld":
			return "Overworld";

		case "minecraft:the_nether":
			return "The Nether";

		case "minecraft:the_end":
			return "The End";

		default: {
			const path = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;

			return path
				.split(/[_/]/)
				.filter((word) => word.length > 0)
				.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
				.join(" ");
		}
	}
}

/** A namespaced id as a name: `minecraft:diamond_helmet` → `Diamond Helmet`. */
export function idLabel(id: string): string {
	return dimensionLabel(id);
}

/**
 * Experience needed to go from `level` to the next one, per the game's own
 * three-segment curve.
 */
export function xpToNextLevel(level: number): number {
	if (level >= 31) {
		return 9 * level - 158;
	}

	if (level >= 16) {
		return 5 * level - 38;
	}

	return 2 * level + 7;
}

/** Ticks as milliseconds; the stats file counts in ticks at twenty a second. */
export function ticksToMillis(ticks: number): number {
	return ticks * 50;
}

/**
 * The advancement's tab: `minecraft:story/mine_stone` → `story`. A mod that
 * files its advancements flat (`logistics:obtain_elite_cable`) has no tab in
 * the path, so its namespace stands in rather than the advancement's own name.
 */
export function advancementGroup(id: string): string {
	const colon = id.indexOf(":");
	const namespace = colon === -1 ? "" : id.slice(0, colon);
	const path = colon === -1 ? id : id.slice(colon + 1);
	const slash = path.indexOf("/");

	if (slash === -1) {
		return namespace || path;
	}

	return path.slice(0, slash);
}

/** Whether an advancement id is a recipe unlock rather than one the game displays. */
export function isRecipeAdvancement(id: string): boolean {
	return /^[^:]+:recipes\//.test(id);
}

/**
 * Hearts drawn for a health value: the game shows half a heart per point, ten
 * hearts for the vanilla twenty, and more when an attribute raises the maximum.
 */
export function heartsOf(health: number): number {
	return Math.max(0, health) / 2;
}
