// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What one backend last saved about a player: the `playerdata/<uuid>.dat`
 * compound, the advancements file and the stats file under its world.
 *
 * Reading the save is the one source of a player's health, hunger, experience,
 * position, game mode and inventory that needs nothing from the server itself:
 * the proxy knows none of it, and no plugin publishes it. The price is that the
 * file is only as fresh as the server's last save (on disconnect, and on its
 * autosave cadence while the player is on), which is why every result carries
 * `savedAt` and the screens print it rather than pretending the values are live.
 *
 * Every JVM server writes these three files the same way, so this works on Paper,
 * Fabric, Forge and NeoForge alike, and on a follower's instance through the
 * instance-routed ops. It is read-only: luna never edits a player's save.
 */

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { instanceDir, managedInstances } from "./config";
import {
	ENDER_CHEST_SLOTS,
	INVENTORY_SLOTS,
	gameModeOf,
	isRecipeAdvancement,
} from "./playerdata";
import type {
	EquipmentSlot,
	PlayerAdvancement,
	PlayerAdvancements,
	PlayerDetail,
	PlayerEffect,
	PlayerItem,
	PlayerPosition,
	PlayerRosterEntry,
	PlayerSnapshot,
	PlayerStats,
	PlayerVitals,
	SavedPlayer,
} from "./playerdata";
import { offlineUuid } from "./playerlists";
import { parseNbt } from "./services/nbt";
import type { NbtCompound, NbtValue } from "./services/nbt";
import type { ClusterConfig, InstanceConfig } from "./types";
import { usercacheNameOf, usercacheNames, usercacheUuidOf } from "./usercache";
import { hasWorld, worldDir } from "./world";
import { t } from "../shared/i18n";
import { UUID_PATTERN } from "../shared/uuid";

/** A player file past this is not a player file; modded saves run to a few hundred KB. */
const MAX_PLAYER_FILE_BYTES = 8 * 1024 * 1024;

/** The `Inventory` slots vanilla used for armour and the offhand before `equipment` existed. */
const LEGACY_EQUIPMENT_SLOTS: Record<number, EquipmentSlot> = {
	100: "feet",
	101: "legs",
	102: "chest",
	103: "head",
	[-106]: "offhand",
};

/** Pre-1.16 saves store the dimension as a number. */
const LEGACY_DIMENSIONS: Record<number, string> = {
	0: "minecraft:overworld",
	[-1]: "minecraft:the_nether",
	1: "minecraft:the_end",
};

/** The three per-player directories under a world. */
interface PlayerDirs {
	playerdata: string;
	advancements: string;
	stats: string;
}

async function playerDirs(inst: InstanceConfig): Promise<PlayerDirs> {
	const world = await worldDir(inst);

	return {
		playerdata: join(world, "playerdata"),
		advancements: join(world, "advancements"),
		stats: join(world, "stats"),
	};
}

function instanceOf(cfg: ClusterConfig, name: string): InstanceConfig {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.playerstate.unknownInstance", { name }));
	}

	if (!hasWorld(inst)) {
		throw new Error(t("core.playerstate.noWorld", { name }));
	}

	return inst;
}

// -- NBT coercion -------------------------------------------------------------

function num(value: NbtValue | undefined): number | undefined {
	if (typeof value === "number") {
		return value;
	}

	if (typeof value === "bigint") {
		return Number(value);
	}

	return undefined;
}

function str(value: NbtValue | undefined): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function bool(value: NbtValue | undefined): boolean {
	return (num(value) ?? 0) !== 0;
}

function compound(value: NbtValue | undefined): NbtCompound | undefined {
	if (value && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value)) {
		return value as NbtCompound;
	}

	return undefined;
}

function list(value: NbtValue | undefined): NbtValue[] {
	return Array.isArray(value) ? value : [];
}

/**
 * An NBT value as plain JSON: bigints as strings, typed arrays as arrays. Used for
 * the custom-data compound, which is handed to the screen as-is because what a
 * plugin keeps there is the plugin's business.
 */
function toJson(value: NbtValue | undefined): unknown {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value === "bigint") {
		return value.toString();
	}

	if (ArrayBuffer.isView(value)) {
		return Array.from(value as ArrayLike<number | bigint>, (entry) =>
			typeof entry === "bigint" ? entry.toString() : entry,
		);
	}

	if (Array.isArray(value)) {
		return value.map((entry) => toJson(entry));
	}

	if (typeof value === "object") {
		const out: Record<string, unknown> = {};

		for (const [key, entry] of Object.entries(value)) {
			out[key] = toJson(entry);
		}

		return out;
	}

	return value;
}

/**
 * The plain text of a text component in any of the shapes a save may hold it:
 * a literal string, a JSON string (pre-1.21.5 names and lore), or an NBT
 * compound (1.21.5+). Formatting codes and styling are dropped; only the words
 * survive, because a tooltip in the console is set in the console's own type.
 */
function plainText(value: NbtValue | unknown | undefined): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}

	if (typeof value === "string") {
		const trimmed = value.trim();

		if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) {
			try {
				return plainText(JSON.parse(trimmed));
			} catch {
				// a literal name that happens to start with a brace
			}
		}

		return stripCodes(value);
	}

	if (Array.isArray(value)) {
		return value.map((entry) => plainText(entry) ?? "").join("");
	}

	if (typeof value === "object") {
		const node = value as Record<string, unknown>;
		const own = typeof node.text === "string"
			? node.text
			: typeof node.translate === "string"
				? node.translate
				: "";
		const extra = Array.isArray(node.extra) ? node.extra.map((entry) => plainText(entry) ?? "").join("") : "";

		return stripCodes(`${own}${extra}`);
	}

	return String(value);
}

function stripCodes(text: string): string {
	return text.replace(/§[0-9a-fk-orA-FK-OR]/g, "");
}

// -- items --------------------------------------------------------------------

/** Enchantments as the 1.21.5+ flat map, the 1.20.5 `levels` wrapper, or the legacy list. */
function enchantmentsOf(value: NbtValue | undefined): Record<string, number> {
	const out: Record<string, number> = {};
	const asCompound = compound(value);

	if (asCompound) {
		const levels = compound(asCompound.levels) ?? asCompound;

		for (const [id, level] of Object.entries(levels)) {
			const parsed = num(level);

			if (parsed !== undefined && id !== "show_in_tooltip") {
				out[id] = parsed;
			}
		}

		return out;
	}

	for (const entry of list(value)) {
		const enchant = compound(entry);

		if (!enchant) {
			continue;
		}

		const id = str(enchant.id);
		const level = num(enchant.lvl) ?? num(enchant.level);

		if (id && level !== undefined) {
			out[id] = level;
		}
	}

	return out;
}

function decodeItem(raw: NbtValue | undefined, slot: number): PlayerItem | undefined {
	const node = compound(raw);

	if (!node) {
		return undefined;
	}

	const id = str(node.id);

	if (!id) {
		// pre-1.13 numeric ids carry no name luna could draw
		return undefined;
	}

	const item: PlayerItem = {
		slot,
		id,
		count: num(node.count) ?? num(node.Count) ?? 1,
		enchantments: {},
		lore: [],
	};

	const components = compound(node.components);
	const tag = compound(node.tag);

	if (components) {
		item.enchantments = {
			...enchantmentsOf(components["minecraft:enchantments"]),
			...enchantmentsOf(components["minecraft:stored_enchantments"]),
		};

		const damage = num(components["minecraft:damage"]);
		const maxDamage = num(components["minecraft:max_damage"]);
		const name = plainText(components["minecraft:custom_name"]);
		const custom = compound(components["minecraft:custom_data"]);

		if (damage !== undefined) {
			item.damage = damage;
		}

		if (maxDamage !== undefined) {
			item.maxDamage = maxDamage;
		}

		if (name) {
			item.customName = name;
		}

		item.lore = list(components["minecraft:lore"])
			.map((line) => plainText(line))
			.filter((line): line is string => line !== undefined);

		if (custom) {
			item.customData = toJson(custom) as Record<string, unknown>;
		}

		const contents = decodeContainer(components["minecraft:container"]);
		const bundle = list(components["minecraft:bundle_contents"])
			.map((entry, index) => decodeItem(entry, index))
			.filter((entry): entry is PlayerItem => entry !== undefined);

		if (contents.length > 0) {
			item.contents = contents;
		} else if (bundle.length > 0) {
			item.contents = bundle;
		}
	} else if (tag) {
		item.enchantments = {
			...enchantmentsOf(tag.Enchantments),
			...enchantmentsOf(tag.StoredEnchantments),
		};

		const damage = num(tag.Damage);
		const display = compound(tag.display);

		if (damage !== undefined) {
			item.damage = damage;
		}

		if (display) {
			const name = plainText(display.Name);

			if (name) {
				item.customName = name;
			}

			item.lore = list(display.Lore)
				.map((line) => plainText(line))
				.filter((line): line is string => line !== undefined);
		}

		const blockEntity = compound(tag.BlockEntityTag);
		const contents = blockEntity ? decodeItems(blockEntity.Items) : [];

		if (contents.length > 0) {
			item.contents = contents;
		}

		const custom: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(tag)) {
			if (!["Enchantments", "StoredEnchantments", "Damage", "display", "BlockEntityTag", "RepairCost"].includes(key)) {
				custom[key] = toJson(value);
			}
		}

		if (Object.keys(custom).length > 0) {
			item.customData = custom;
		}
	}

	return item;
}

/** A `minecraft:container` component: `[{ slot, item }]`. */
function decodeContainer(value: NbtValue | undefined): PlayerItem[] {
	const out: PlayerItem[] = [];

	for (const entry of list(value)) {
		const node = compound(entry);

		if (!node) {
			continue;
		}

		const item = decodeItem(node.item, num(node.slot) ?? out.length);

		if (item) {
			out.push(item);
		}
	}

	return out;
}

/** An item list whose entries carry their own `Slot`. */
function decodeItems(value: NbtValue | undefined): PlayerItem[] {
	const out: PlayerItem[] = [];

	for (const entry of list(value)) {
		const node = compound(entry);

		if (!node) {
			continue;
		}

		const item = decodeItem(node, num(node.Slot) ?? out.length);

		if (item) {
			out.push(item);
		}
	}

	return out;
}

// -- the compound -------------------------------------------------------------

function positionOf(node: NbtCompound): PlayerPosition {
	const pos = list(node.Pos).map((entry) => num(entry) ?? 0);
	const rotation = list(node.Rotation).map((entry) => num(entry) ?? 0);
	const rawDimension = node.Dimension;
	const dimension = str(rawDimension)
		?? LEGACY_DIMENSIONS[num(rawDimension) ?? 0]
		?? "minecraft:overworld";

	return {
		x: pos[0] ?? 0,
		y: pos[1] ?? 0,
		z: pos[2] ?? 0,
		dimension,
		...(rotation.length === 2 ? { yaw: rotation[0], pitch: rotation[1] } : {}),
	};
}

/** The `respawn` / `LastDeathLocation` compounds: `{ pos: [x, y, z], dimension }`. */
function placeOf(value: NbtValue | undefined): PlayerPosition | undefined {
	const node = compound(value);

	if (!node) {
		return undefined;
	}

	const raw = node.pos;
	const pos = Array.isArray(raw)
		? raw.map((entry) => num(entry) ?? 0)
		: ArrayBuffer.isView(raw)
			? Array.from(raw as ArrayLike<number>, (entry) => Number(entry))
			: [];
	const dimension = str(node.dimension);

	if (pos.length < 3 || !dimension) {
		return undefined;
	}

	return { x: pos[0]!, y: pos[1]!, z: pos[2]!, dimension };
}

function attributesOf(node: NbtCompound): Record<string, number> {
	const out: Record<string, number> = {};

	for (const entry of list(node.attributes ?? node.Attributes)) {
		const attribute = compound(entry);

		if (!attribute) {
			continue;
		}

		const id = str(attribute.id) ?? str(attribute.Name);
		const base = num(attribute.base) ?? num(attribute.Base);

		if (id && base !== undefined) {
			out[id] = base;
		}
	}

	return out;
}

function effectsOf(node: NbtCompound): PlayerEffect[] {
	const out: PlayerEffect[] = [];

	for (const entry of list(node.active_effects ?? node.ActiveEffects)) {
		const effect = compound(entry);

		if (!effect) {
			continue;
		}

		const id = str(effect.id) ?? `effect#${num(effect.Id) ?? 0}`;

		out.push({
			id,
			amplifier: num(effect.amplifier) ?? num(effect.Amplifier) ?? 0,
			duration: num(effect.duration) ?? num(effect.Duration) ?? 0,
			ambient: bool(effect.ambient ?? effect.Ambient),
		});
	}

	return out;
}

/** The max-health attribute under any of the names it has carried. */
function maxHealthOf(attributes: Record<string, number>): number {
	return attributes["minecraft:max_health"]
		?? attributes["minecraft:generic.max_health"]
		?? attributes["generic.max_health"]
		?? attributes["generic.maxHealth"]
		?? 20;
}

function vitalsOf(uuid: string, node: NbtCompound, savedAt: number): PlayerVitals {
	const attributes = attributesOf(node);
	const abilities = compound(node.abilities);
	const paper = compound(node.Paper);
	const bukkit = compound(node.bukkit);
	const gameModeId = num(node.playerGameType) ?? 0;

	return {
		uuid,
		savedAt,
		...(num(node.DataVersion) !== undefined ? { dataVersion: num(node.DataVersion) } : {}),
		health: num(node.Health) ?? 0,
		maxHealth: maxHealthOf(attributes),
		absorption: num(node.AbsorptionAmount) ?? 0,
		food: num(node.foodLevel) ?? 0,
		saturation: num(node.foodSaturationLevel) ?? 0,
		exhaustion: num(node.foodExhaustionLevel) ?? 0,
		xpLevel: num(node.XpLevel) ?? 0,
		xpProgress: Math.max(0, Math.min(1, num(node.XpP) ?? 0)),
		xpTotal: num(node.XpTotal) ?? 0,
		score: num(node.Score) ?? 0,
		air: num(node.Air) ?? 0,
		fire: num(node.Fire) ?? 0,
		gameModeId,
		gameMode: gameModeOf(gameModeId),
		position: positionOf(node),
		flying: bool(abilities?.flying),
		mayFly: bool(abilities?.mayfly),
		invulnerable: bool(abilities?.invulnerable) || bool(node.Invulnerable),
		selectedSlot: num(node.SelectedItemSlot) ?? 0,
		seenCredits: bool(node.seenCredits),
		...(num(bukkit?.firstPlayed) !== undefined ? { firstPlayed: num(bukkit?.firstPlayed) } : {}),
		...(num(bukkit?.lastPlayed) !== undefined ? { lastPlayed: num(bukkit?.lastPlayed) } : {}),
		...(num(paper?.LastLogin) !== undefined ? { lastLogin: num(paper?.LastLogin) } : {}),
		...(str(bukkit?.lastKnownName) ? { lastKnownName: str(bukkit?.lastKnownName) } : {}),
		effects: effectsOf(node),
	};
}

function snapshotOf(uuid: string, node: NbtCompound, savedAt: number): PlayerSnapshot {
	const vitals = vitalsOf(uuid, node, savedAt);
	const abilities = compound(node.abilities);
	const inventory: PlayerItem[] = [];
	const equipment: Partial<Record<EquipmentSlot, PlayerItem>> = {};

	// 1.21.5 moved armour and the offhand out of `Inventory` into `equipment`;
	// an older save still carries them as the 100-103 / -106 slots
	for (const item of decodeItems(node.Inventory)) {
		const legacySlot = LEGACY_EQUIPMENT_SLOTS[item.slot];

		if (legacySlot) {
			equipment[legacySlot] = item;
		} else if (item.slot >= 0 && item.slot < INVENTORY_SLOTS) {
			inventory.push(item);
		}
	}

	const worn = compound(node.equipment);

	if (worn) {
		for (const slot of ["head", "chest", "legs", "feet", "offhand"] as const) {
			const item = decodeItem(worn[slot], 0);

			if (item) {
				equipment[slot] = item;
			}
		}
	}

	const enderChest = decodeItems(node.EnderItems).filter(
		(item) => item.slot >= 0 && item.slot < ENDER_CHEST_SLOTS,
	);

	const respawn = placeOf(node.respawn);
	const lastDeath = placeOf(node.LastDeathLocation);

	return {
		...vitals,
		inventory,
		equipment,
		enderChest,
		...(respawn ? { respawn } : {}),
		...(lastDeath ? { lastDeath } : {}),
		walkSpeed: num(abilities?.walkSpeed) ?? 0.1,
		flySpeed: num(abilities?.flySpeed) ?? 0.05,
		attributes: attributesOf(node),
		deathTime: num(node.DeathTime) ?? 0,
		sleepTimer: num(node.SleepTimer) ?? 0,
		portalCooldown: num(node.PortalCooldown) ?? 0,
		...(num(node["Spigot.ticksLived"]) !== undefined ? { ticksLived: num(node["Spigot.ticksLived"]) } : {}),
	};
}

/** The parsed compound and the file's write time, or undefined when there is no save. */
async function readCompound(dir: string, uuid: string): Promise<{ node: NbtCompound; savedAt: number } | undefined> {
	const path = join(dir, `${uuid.toLowerCase()}.dat`);

	if (!existsSync(path)) {
		return undefined;
	}

	const info = await stat(path);

	if (info.size > MAX_PLAYER_FILE_BYTES) {
		throw new Error(t("core.playerstate.fileTooLarge", { path }));
	}

	const raw = new Uint8Array(await Bun.file(path).arrayBuffer());

	return { node: parseNbt(raw), savedAt: info.mtimeMs };
}

// -- advancements and stats ---------------------------------------------------

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;

/** The `yyyy-MM-dd HH:mm:ss Z` stamp the game writes per criterion, as epoch ms. */
function parseGameDate(text: unknown): number {
	if (typeof text !== "string") {
		return 0;
	}

	const match = DATE_PATTERN.exec(text.trim());

	if (!match) {
		const fallback = Date.parse(text);

		return Number.isNaN(fallback) ? 0 : fallback;
	}

	const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = match;
	const utc = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second),
	);
	const offset = (Number(offsetHours) * 60 + Number(offsetMinutes)) * 60_000;

	return sign === "+" ? utc - offset : utc + offset;
}

async function readJsonFile(dir: string, uuid: string): Promise<Record<string, unknown> | undefined> {
	const path = join(dir, `${uuid.toLowerCase()}.json`);

	if (!existsSync(path)) {
		return undefined;
	}

	const info = await stat(path);

	if (info.size > MAX_PLAYER_FILE_BYTES) {
		throw new Error(t("core.playerstate.fileTooLarge", { path }));
	}

	const parsed = (await Bun.file(path).json()) as unknown;

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(t("core.playerstate.notAnObject", { path }));
	}

	return parsed as Record<string, unknown>;
}

function advancementsOf(raw: Record<string, unknown>): PlayerAdvancements {
	const entries: PlayerAdvancement[] = [];
	let total = 0;
	let done = 0;
	let recipes = 0;

	for (const [id, value] of Object.entries(raw)) {
		if (id === "DataVersion" || !value || typeof value !== "object") {
			continue;
		}

		const node = value as { criteria?: Record<string, unknown>; done?: boolean };
		const criteria = Object.entries(node.criteria ?? {}).map(([name, at]) => ({
			name,
			at: parseGameDate(at),
		}));
		const recipe = isRecipeAdvancement(id);
		const completed = node.done === true;

		entries.push({
			id,
			done: completed,
			recipe,
			criteria,
			at: criteria.reduce((latest, criterion) => Math.max(latest, criterion.at), 0),
		});

		if (recipe) {
			recipes += 1;
		} else {
			total += 1;

			if (completed) {
				done += 1;
			}
		}
	}

	const dataVersion = typeof raw.DataVersion === "number" ? raw.DataVersion : undefined;

	return {
		total,
		done,
		recipes,
		entries,
		...(dataVersion !== undefined ? { dataVersion } : {}),
	};
}

function statsOf(raw: Record<string, unknown>): PlayerStats {
	const sections: Record<string, Record<string, number>> = {};
	const modern = raw.stats;

	if (modern && typeof modern === "object" && !Array.isArray(modern)) {
		for (const [section, values] of Object.entries(modern as Record<string, unknown>)) {
			if (!values || typeof values !== "object" || Array.isArray(values)) {
				continue;
			}

			const out: Record<string, number> = {};

			for (const [key, count] of Object.entries(values as Record<string, unknown>)) {
				if (typeof count === "number") {
					out[key] = count;
				}
			}

			sections[section] = out;
		}
	} else {
		// pre-1.13: one flat object of `stat.walkOneCm`-style keys
		const legacy: Record<string, number> = {};

		for (const [key, count] of Object.entries(raw)) {
			if (key !== "DataVersion" && typeof count === "number") {
				legacy[key] = count;
			}
		}

		sections.legacy = legacy;
	}

	const dataVersion = typeof raw.DataVersion === "number" ? raw.DataVersion : undefined;

	return {
		sections,
		...(dataVersion !== undefined ? { dataVersion } : {}),
	};
}

// -- public surface -----------------------------------------------------------

/**
 * The saved vitals of a set of players on one instance, keyed by uuid, for the
 * online table. A player without a save (never joined, or not yet flushed) maps
 * to null vitals; a save that fails to parse does too, since a roster row is
 * not the place to raise a corrupt file.
 *
 * @param uuids the players to look up, as the proxy identifies them
 */
export async function readPlayerRoster(
	cfg: ClusterConfig,
	instance: string,
	uuids: string[],
): Promise<PlayerRosterEntry[]> {
	const inst = instanceOf(cfg, instance);
	const dirs = await playerDirs(inst);

	return await Promise.all(
		uuids.map(async (uuid): Promise<PlayerRosterEntry> => {
			let vitals: PlayerVitals | null = null;
			let advancements: { done: number; total: number } | null = null;

			try {
				const save = await readCompound(dirs.playerdata, uuid);

				if (save) {
					vitals = vitalsOf(uuid, save.node, save.savedAt);
				}
			} catch {
				vitals = null;
			}

			try {
				const raw = await readJsonFile(dirs.advancements, uuid);

				if (raw) {
					const summary = advancementsOf(raw);

					advancements = { done: summary.done, total: summary.total };
				}
			} catch {
				advancements = null;
			}

			return { uuid, vitals, advancements };
		}),
	);
}

/**
 * Everything the backend has saved about one player: the full compound with
 * both inventories, the advancements and the stats. Missing files are null;
 * unreadable ones are null too and named in `problems`.
 */
export async function readPlayerDetail(
	cfg: ClusterConfig,
	instance: string,
	uuid: string,
): Promise<PlayerDetail> {
	const inst = instanceOf(cfg, instance);
	const dirs = await playerDirs(inst);
	const problems: string[] = [];

	let snapshot: PlayerSnapshot | null = null;
	let advancements: PlayerAdvancements | null = null;
	let stats: PlayerStats | null = null;

	try {
		const save = await readCompound(dirs.playerdata, uuid);

		if (save) {
			snapshot = snapshotOf(uuid, save.node, save.savedAt);
		}
	} catch (err) {
		problems.push(t("core.playerstate.unreadable", { file: `playerdata/${uuid}.dat`, error: (err as Error).message }));
	}

	try {
		const raw = await readJsonFile(dirs.advancements, uuid);

		if (raw) {
			advancements = advancementsOf(raw);
		}
	} catch (err) {
		problems.push(t("core.playerstate.unreadable", { file: `advancements/${uuid}.json`, error: (err as Error).message }));
	}

	try {
		const raw = await readJsonFile(dirs.stats, uuid);

		if (raw) {
			stats = statsOf(raw);
		}
	} catch (err) {
		problems.push(t("core.playerstate.unreadable", { file: `stats/${uuid}.json`, error: (err as Error).message }));
	}

	const name = snapshot?.lastKnownName ?? (await usercacheNameOf(instanceDir(inst), uuid));

	return {
		uuid,
		...(name ? { name } : {}),
		snapshot,
		advancements,
		stats,
		problems,
	};
}

/**
 * Turn whatever names a player into the uuid the backend files them under: a
 * uuid passes through, a username is looked up in the server's own usercache and
 * failing that derived the way the software derives an offline id. Undefined when
 * nothing on this instance answers to it.
 */
export async function resolvePlayerRef(
	cfg: ClusterConfig,
	instance: string,
	ref: string,
): Promise<{ uuid: string; name?: string } | undefined> {
	const inst = instanceOf(cfg, instance);
	const trimmed = ref.trim();

	if (UUID_PATTERN.test(trimmed)) {
		const name = await usercacheNameOf(instanceDir(inst), trimmed);

		return { uuid: trimmed.toLowerCase(), ...(name ? { name } : {}) };
	}

	const cached = await usercacheUuidOf(instanceDir(inst), trimmed);

	if (cached) {
		return { uuid: cached.toLowerCase(), name: trimmed };
	}

	const derived = offlineUuid(trimmed, inst.software);
	const dirs = await playerDirs(inst);

	if (existsSync(join(dirs.playerdata, `${derived}.dat`))) {
		return { uuid: derived, name: trimmed };
	}

	return undefined;
}

/**
 * Every player the backend holds a save for, newest save first, with the name
 * its usercache knows them by. The list the detail screen offers when the player
 * asked for is not online.
 */
export async function listSavedPlayers(cfg: ClusterConfig, instance: string): Promise<SavedPlayer[]> {
	const inst = instanceOf(cfg, instance);
	const dirs = await playerDirs(inst);

	if (!existsSync(dirs.playerdata)) {
		return [];
	}

	const names = await usercacheNames(instanceDir(inst));
	const files = await readdir(dirs.playerdata);
	const out: SavedPlayer[] = [];

	for (const file of files) {
		if (!file.endsWith(".dat")) {
			continue;
		}

		const uuid = file.slice(0, -4).toLowerCase();

		if (!UUID_PATTERN.test(uuid)) {
			continue;
		}

		const info = await stat(join(dirs.playerdata, file)).catch(() => undefined);

		if (!info) {
			continue;
		}

		const name = names.get(uuid);

		out.push({ uuid, ...(name ? { name } : {}), savedAt: info.mtimeMs });
	}

	out.sort((left, right) => right.savedAt - left.savedAt);

	return out;
}
