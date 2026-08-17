// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Per-instance player access lists: whitelist, operators, player bans and IP
 * bans; the four JSON files every Paper server keeps next to `server.properties`.
 *
 * The rule of the module: **while the server runs, the server owns the files.**
 * A running instance gets console commands (`whitelist add`, `op`, `ban`, …),
 * which vanilla persists itself; only a stopped instance has its JSON edited
 * directly. Writing the files under a live server would be silently overwritten
 * on its next save, which is exactly the kind of ghost change this avoids.
 *
 * Name → UUID resolution for offline edits prefers the instance's own
 * `usercache.json` (what the server itself believes) and falls back to deriving
 * the offline-mode UUID, which is right for this cluster because the backends
 * run behind the proxy with `online-mode=false`. That derivation is the
 * software's own, not one rule: see `offlineUuid`.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { instanceDir, managedInstances } from "./config";
import { readProperties, upsertProperty } from "./confedit";
import { getStatus, sendCommand } from "./instances";
import { traitsOf } from "./software";
import type { ClusterConfig, Software } from "./types";
import { t } from "../shared/i18n";

/** The four access lists and the file each one lives in. */
export const ACCESS_LIST_FILES = {
	whitelist: "whitelist.json",
	ops: "ops.json",
	bans: "banned-players.json",
	"ban-ips": "banned-ips.json",
} as const;

export type AccessListKind = keyof typeof ACCESS_LIST_FILES;

/**
 * How a console command's effect is confirmed: the list file is re-read on
 * this cadence until it shows the change or the attempts run out. Vanilla
 * saves the list right away, but some forks flush it lazily (survival's took
 * 4 s to write ops.json, and a queued save can wait for the next trigger
 * entirely), so a single read after a fixed pause misreads a change that
 * landed in memory as a failure.
 */
const VERIFY_INTERVAL_MS = 700;
const VERIFY_ATTEMPTS = 10;

/** Valid Java Edition account name; bedrock names arrive prefixed and pass too. */
const NAME_PATTERN = /^[A-Za-z0-9_.]{1,16}$/;

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface WhitelistEntry {
	uuid: string;
	name: string;
}

export interface OpEntry {
	uuid: string;
	name: string;
	level: number;
	bypassesPlayerLimit: boolean;
}

export interface BanEntry {
	uuid: string;
	name: string;
	created: string;
	source: string;
	expires: string;
	reason?: string;
}

export interface IpBanEntry {
	ip: string;
	created: string;
	source: string;
	expires: string;
	reason?: string;
}

export interface AccessLists {
	instance: string;
	/** stopped | starting | running | unknown; mirrors InstanceStatus.state */
	state: string;
	whitelistEnabled: boolean;
	enforceWhitelist: boolean;
	whitelist: WhitelistEntry[];
	ops: OpEntry[];
	bans: BanEntry[];
	ipBans: IpBanEntry[];
}

export interface AccessChange {
	list: AccessListKind;
	action: "add" | "remove" | "update";
	/**
	 * Player name for whitelist/ops/bans; an IP address for ban-ips. A bare
	 * UUID is accepted too and is treated as `uuid`, with the name resolved
	 * from the server's usercache when one is needed.
	 */
	target: string;
	/**
	 * Exact profile id. Two profiles can share a name (a premium account and
	 * an offline-derived id), so when the caller knows which one it means -
	 * a table row, a directory pick - file edits match and write this id
	 * instead of resolving the name, and verification checks it too. Console
	 * commands still go by name; vanilla has no UUID form.
	 */
	uuid?: string;
	/** Ban reason (bans and ban-ips only) */
	reason?: string;
	/** Op permission level 1-4; used only for file edits (default 4) */
	level?: number;
	/** Whether the operator may join past the player limit; file edits only */
	bypassesPlayerLimit?: boolean;
	/** Who performed the change; recorded in ban entries written to file */
	actor?: string;
}

export interface AccessChangeResult {
	instance: string;
	list: AccessListKind;
	action: "add" | "remove" | "update";
	target: string;
	ok: boolean;
	/** How the change was applied */
	method: "command" | "file";
	/**
	 * Whether the list file showed the change before the poll window closed.
	 * False on the command path when the server has not persisted yet (a lazy
	 * save, or a command the server rejected); the caller reports it as sent
	 * but unconfirmed, not as failed.
	 */
	verified?: boolean;
	error?: string;
}

/** Lay 16 bytes out as a UUID. */
function formatUuid(bytes: Buffer): string {
	const hex = bytes.toString("hex");

	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The UUID a server derives from a player name when authentication is off.
 *
 * The scheme is the software's, not a constant: vanilla and its descendants hash
 * `OfflinePlayer:<name>` with MD5 into a v3 UUID, and pumpkin takes the first 16
 * bytes of SHA-256 over the bare name. Both are stable, and they disagree, so a
 * whitelist entry written with the wrong one names a player who never connects.
 */
export function offlineUuid(name: string, software: Software): string {
	if (traitsOf(software).offlineIdentity === "pumpkin") {
		return formatUuid(createHash("sha256").update(name, "utf8").digest().subarray(0, 16));
	}

	const hash = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();

	// UUID v3: overwrite the version and variant nibbles per RFC 4122.
	hash[6] = (hash[6]! & 0x0f) | 0x30;
	hash[8] = (hash[8]! & 0x3f) | 0x80;

	return formatUuid(hash);
}

/** Read one of the JSON list files, tolerating absence and malformed content. */
async function readListFile<T>(dir: string, file: string): Promise<T[]> {
	const path = join(dir, file);

	if (!existsSync(path)) {
		return [];
	}

	try {
		const parsed = (await Bun.file(path).json()) as unknown;

		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}

/** Write a list file the way vanilla's Gson does: two-space indent, LF. */
async function writeListFile(dir: string, file: string, entries: unknown[]): Promise<void> {
	await Bun.write(join(dir, file), JSON.stringify(entries, null, 2));
}

/** The server's own name→uuid cache, when it has one. */
async function usercacheLookup(dir: string, name: string): Promise<string | undefined> {
	const entries = await readListFile<{ name?: string; uuid?: string }>(dir, "usercache.json");
	const lowered = name.toLowerCase();

	for (const entry of entries) {
		if (entry.name?.toLowerCase() === lowered && entry.uuid) {
			return entry.uuid;
		}
	}

	return undefined;
}

/** The reverse: the name the server knows a profile id by, for bare-UUID targets. */
async function usercacheNameOf(dir: string, uuid: string): Promise<string | undefined> {
	const entries = await readListFile<{ name?: string; uuid?: string }>(dir, "usercache.json");
	const lowered = uuid.toLowerCase();

	for (const entry of entries) {
		if (entry.uuid?.toLowerCase() === lowered && entry.name) {
			return entry.name;
		}
	}

	return undefined;
}

/** Timestamp in the `yyyy-MM-dd HH:mm:ss Z` shape vanilla writes in ban entries. */
function banTimestamp(date = new Date()): string {
	const pad = (value: number): string => String(value).padStart(2, "0");

	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absolute = Math.abs(offsetMinutes);
	const offset = `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`;

	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
		+ `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset}`;
}

/**
 * All four access lists of one instance, plus its whitelist settings and live
 * state, in a single read.
 */
export async function getAccessLists(cfg: ClusterConfig, name: string): Promise<AccessLists> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const dir = instanceDir(inst);
	const status = await getStatus(cfg, name);

	let whitelistEnabled = false;
	let enforceWhitelist = false;

	const propsPath = join(dir, "server.properties");

	if (existsSync(propsPath)) {
		const props = await readProperties(propsPath);

		whitelistEnabled = props["white-list"] === "true";
		enforceWhitelist = props["enforce-whitelist"] === "true";
	}

	const [whitelist, ops, bans, ipBans] = await Promise.all([
		readListFile<WhitelistEntry>(dir, ACCESS_LIST_FILES.whitelist),
		readListFile<OpEntry>(dir, ACCESS_LIST_FILES.ops),
		readListFile<BanEntry>(dir, ACCESS_LIST_FILES.bans),
		readListFile<IpBanEntry>(dir, ACCESS_LIST_FILES["ban-ips"]),
	]);

	return {
		instance: name,
		state: status.state,
		whitelistEnabled,
		enforceWhitelist,
		whitelist,
		ops,
		bans,
		ipBans,
	};
}

/** Loose IPv4/IPv6 shape check; enough to keep garbage out of a console line. */
function looksLikeIp(value: string): boolean {
	return /^[0-9a-fA-F:.]{3,45}$/.test(value) && (value.includes(".") || value.includes(":"));
}

/** Validate a change's target before it reaches a console line or a file. */
function validateTarget(change: AccessChange): string | undefined {
	if (change.list === "ban-ips") {
		return looksLikeIp(change.target) ? undefined : `not a valid IP address: ${change.target}`;
	}

	if (change.uuid && !UUID_PATTERN.test(change.uuid)) {
		return `not a valid profile id: ${change.uuid}`;
	}

	if (NAME_PATTERN.test(change.target)) {
		return undefined;
	}

	// a bare UUID whose name is unknown; file-path removes/updates match by id
	if (change.uuid) {
		return undefined;
	}

	return `not a valid player name: ${change.target}`;
}

/**
 * The console commands that apply a change on a running server. Vanilla has no
 * command that edits a ban in place, so an update is a pardon followed by a
 * fresh ban carrying the new reason; the entry's created/source change with it,
 * which is what re-banning means on a live server.
 */
function commandsFor(change: AccessChange): string[] {
	const reason = (change.reason ?? "").trim();

	switch (change.list) {
		case "whitelist": {
			return [`whitelist ${change.action === "add" ? "add" : "remove"} ${change.target}`];
		}
		case "ops": {
			return [`${change.action === "add" ? "op" : "deop"} ${change.target}`];
		}
		case "bans": {
			const ban = `ban ${change.target}${reason ? ` ${reason}` : ""}`;

			if (change.action === "add") {
				return [ban];
			}

			if (change.action === "update") {
				return [`pardon ${change.target}`, ban];
			}

			return [`pardon ${change.target}`];
		}
		case "ban-ips": {
			const ban = `ban-ip ${change.target}${reason ? ` ${reason}` : ""}`;

			if (change.action === "add") {
				return [ban];
			}

			if (change.action === "update") {
				return [`pardon-ip ${change.target}`, ban];
			}

			return [`pardon-ip ${change.target}`];
		}
	}
}

/**
 * Whether a player-list entry is the one a change means: the exact profile id
 * when the caller supplied one, the name otherwise. Matching by name alone
 * would sweep up a same-named entry with a different id, which is exactly the
 * premium/offline pair this exists to keep apart.
 */
function matchesPlayer(
	change: AccessChange,
	entry: { uuid?: string; name?: string },
): boolean {
	if (change.uuid) {
		return (entry.uuid ?? "").toLowerCase() === change.uuid.toLowerCase();
	}

	return (entry.name ?? "").toLowerCase() === change.target.toLowerCase();
}

/** Whether a list currently contains a target, for post-command verification. */
function listContains(lists: AccessLists, change: AccessChange): boolean {
	switch (change.list) {
		case "whitelist": {
			return lists.whitelist.some((entry) => matchesPlayer(change, entry));
		}
		case "ops": {
			return lists.ops.some((entry) => matchesPlayer(change, entry));
		}
		case "bans": {
			return lists.bans.some((entry) => matchesPlayer(change, entry));
		}
		case "ban-ips": {
			return lists.ipBans.some((entry) => entry.ip === change.target);
		}
	}
}

/**
 * Apply a change to a stopped instance by editing the JSON file in place.
 * Returns an error message instead of writing when the change cannot apply
 * (an update naming an entry the list does not hold).
 */
async function applyToFile(
	cfg: ClusterConfig,
	name: string,
	dir: string,
	change: AccessChange,
): Promise<string | undefined> {
	if (change.list === "ban-ips") {
		const entries = await readListFile<IpBanEntry>(dir, ACCESS_LIST_FILES["ban-ips"]);

		if (change.action === "update") {
			const entry = entries.find((candidate) => candidate.ip === change.target);

			if (!entry) {
				return t("core.playerlists.notInList", { target: change.target, list: change.list });
			}

			if (change.reason) {
				entry.reason = change.reason;
			} else {
				delete entry.reason;
			}

			await writeListFile(dir, ACCESS_LIST_FILES["ban-ips"], entries);
			return undefined;
		}

		const remaining = entries.filter((entry) => entry.ip !== change.target);

		if (change.action === "add") {
			remaining.push({
				ip: change.target,
				created: banTimestamp(),
				source: change.actor ?? "luna",
				expires: "forever",
				...(change.reason ? { reason: change.reason } : {}),
			});
		}

		await writeListFile(dir, ACCESS_LIST_FILES["ban-ips"], remaining);
		return undefined;
	}

	const software = managedInstances(cfg)[name]?.software ?? "paper";
	const uuid =
		change.uuid
			?? (await usercacheLookup(dir, change.target))
			?? offlineUuid(change.target, software);

	if (change.list === "whitelist") {
		const entries = await readListFile<WhitelistEntry>(dir, ACCESS_LIST_FILES.whitelist);
		const remaining = entries.filter((entry) => !matchesPlayer(change, entry));

		if (change.action === "add") {
			remaining.push({ uuid, name: change.target });
		}

		await writeListFile(dir, ACCESS_LIST_FILES.whitelist, remaining);
		return undefined;
	}

	if (change.list === "ops") {
		const entries = await readListFile<OpEntry>(dir, ACCESS_LIST_FILES.ops);

		if (change.action === "update") {
			const entry = entries.find((candidate) => matchesPlayer(change, candidate));

			if (!entry) {
				return t("core.playerlists.notInList", { target: change.target, list: change.list });
			}

			if (change.level !== undefined) {
				entry.level = Math.min(4, Math.max(1, change.level));
			}

			if (change.bypassesPlayerLimit !== undefined) {
				entry.bypassesPlayerLimit = change.bypassesPlayerLimit;
			}

			await writeListFile(dir, ACCESS_LIST_FILES.ops, entries);
			return undefined;
		}

		const remaining = entries.filter((entry) => !matchesPlayer(change, entry));

		if (change.action === "add") {
			remaining.push({
				uuid,
				name: change.target,
				level: Math.min(4, Math.max(1, change.level ?? 4)),
				bypassesPlayerLimit: change.bypassesPlayerLimit ?? false,
			});
		}

		await writeListFile(dir, ACCESS_LIST_FILES.ops, remaining);
		return undefined;
	}

	const entries = await readListFile<BanEntry>(dir, ACCESS_LIST_FILES.bans);

	if (change.action === "update") {
		const entry = entries.find((candidate) => matchesPlayer(change, candidate));

		if (!entry) {
			return t("core.playerlists.notInList", { target: change.target, list: change.list });
		}

		if (change.reason) {
			entry.reason = change.reason;
		} else {
			delete entry.reason;
		}

		await writeListFile(dir, ACCESS_LIST_FILES.bans, entries);
		return undefined;
	}

	const remaining = entries.filter((entry) => !matchesPlayer(change, entry));

	if (change.action === "add") {
		remaining.push({
			uuid,
			name: change.target,
			created: banTimestamp(),
			source: change.actor ?? "luna",
			expires: "forever",
			...(change.reason ? { reason: change.reason } : {}),
		});
	}

	await writeListFile(dir, ACCESS_LIST_FILES.bans, remaining);
	return undefined;
}

/**
 * Apply one access-list change to one instance; via the console when the
 * server runs, via the JSON file when it is stopped. The result reports which
 * path was taken and, for the command path, whether the list file confirmed
 * the change within the poll window (`verified`); an unconfirmed change was
 * still sent, and on lazily-saving forks it usually applied in memory.
 *
 * Updates edit an existing entry: a ban's reason, an operator's level or
 * player-limit bypass. A live server has no command that sets an op's level,
 * and its ops.json would overwrite an edit on the next save, so an operator
 * update requires the instance stopped; a live ban update is a pardon plus a
 * fresh ban carrying the new reason.
 */
export async function applyAccessChange(
	cfg: ClusterConfig,
	name: string,
	change: AccessChange,
): Promise<AccessChangeResult> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const dir = instanceDir(inst);

	// a bare UUID target names a profile, not a name: carry it as the id and
	// pick up the name the server knows it by, when it knows one
	const req: AccessChange = { ...change };

	if (req.list !== "ban-ips" && !req.uuid && UUID_PATTERN.test(req.target)) {
		req.uuid = req.target;

		const known = await usercacheNameOf(dir, req.target);

		if (known) {
			req.target = known;
		}
	}

	const nameless = req.uuid !== undefined && !NAME_PATTERN.test(req.target);

	const refusal = (error: string, method: "command" | "file" = "file"): AccessChangeResult => ({
		instance: name,
		list: req.list,
		action: req.action,
		target: req.target,
		ok: false,
		method,
		error,
	});

	const invalid = validateTarget(req);

	if (invalid) {
		return refusal(invalid);
	}

	if (req.action === "update" && req.list === "whitelist") {
		return refusal(t("core.playerlists.whitelistHasNoFields"));
	}

	const status = await getStatus(cfg, name);

	if (status.state === "running") {
		if (req.action === "update" && req.list === "ops") {
			return refusal(t("core.playerlists.opEditNeedsStop"), "command");
		}

		if (nameless) {
			return refusal(t("core.playerlists.nameNeeded", { uuid: req.uuid ?? "" }), "command");
		}

		for (const command of commandsFor(req)) {
			await sendCommand(cfg, name, command);
		}

		let verified = false;

		for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
			await Bun.sleep(VERIFY_INTERVAL_MS);

			const after = await getAccessLists(cfg, name);
			const present = listContains(after, req);

			if (req.action === "remove" ? !present : present) {
				verified = true;
				break;
			}
		}

		return {
			instance: name,
			list: req.list,
			action: req.action,
			target: req.target,
			ok: true,
			method: "command",
			verified,
		};
	}

	if (status.state === "starting") {
		return refusal("instance is starting; retry once it is up", "command");
	}

	if (nameless && req.action === "add") {
		return refusal(t("core.playerlists.nameNeeded", { uuid: req.uuid ?? "" }));
	}

	const failed = await applyToFile(cfg, name, dir, req);

	if (failed) {
		return refusal(failed);
	}

	return {
		instance: name,
		list: req.list,
		action: req.action,
		target: req.target,
		ok: true,
		method: "file",
		verified: true,
	};
}

export interface WhitelistToggleResult {
	instance: string;
	enabled: boolean;
	method: "command" | "file";
}

/**
 * Turn an instance's whitelist on or off. A running server gets the
 * `whitelist on|off` command (vanilla persists `server.properties` itself);
 * a stopped one has the property edited surgically.
 */
export async function setWhitelistEnabled(
	cfg: ClusterConfig,
	name: string,
	enabled: boolean,
): Promise<WhitelistToggleResult> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(t("core.instances.unknown", { name }));
	}

	const status = await getStatus(cfg, name);

	if (status.state === "running") {
		await sendCommand(cfg, name, `whitelist ${enabled ? "on" : "off"}`);

		return { instance: name, enabled, method: "command" };
	}

	const propsPath = join(instanceDir(inst), "server.properties");

	await upsertProperty(propsPath, "white-list", enabled ? "true" : "false");

	return { instance: name, enabled, method: "file" };
}
