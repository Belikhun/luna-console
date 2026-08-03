/**
 * Per-instance player access lists: whitelist, operators, player bans and IP
 * bans — the four JSON files every Paper server keeps next to `server.properties`.
 *
 * The rule of the module: **while the server runs, the server owns the files.**
 * A running instance gets console commands (`whitelist add`, `op`, `ban`, …),
 * which vanilla persists itself; only a stopped instance has its JSON edited
 * directly. Writing the files under a live server would be silently overwritten
 * on its next save, which is exactly the kind of ghost change this avoids.
 *
 * Name → UUID resolution for offline edits prefers the instance's own
 * `usercache.json` (what the server itself believes) and falls back to the
 * offline-mode UUID derivation, which is correct for this cluster because the
 * backends run behind the proxy with `online-mode=false`.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { instanceDir, managedInstances } from "./config";
import { readProperties, upsertProperty } from "./confedit";
import { getStatus, sendCommand } from "./instances";
import type { ClusterConfig } from "./types";

/** The four access lists and the file each one lives in. */
export const ACCESS_LIST_FILES = {
	whitelist: "whitelist.json",
	ops: "ops.json",
	bans: "banned-players.json",
	"ban-ips": "banned-ips.json",
} as const;

export type AccessListKind = keyof typeof ACCESS_LIST_FILES;

/** How long a console command gets to persist its change before we re-read. */
const COMMAND_SETTLE_MS = 900;

/** Valid Java Edition account name; bedrock names arrive prefixed and pass too. */
const NAME_PATTERN = /^[A-Za-z0-9_.]{1,16}$/;

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
	/** stopped | starting | running | unknown — mirrors InstanceStatus.state */
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
	action: "add" | "remove";
	/** Player name for whitelist/ops/bans; an IP address for ban-ips */
	target: string;
	/** Ban reason (bans and ban-ips only) */
	reason?: string;
	/** Op permission level 1–4; used only for file edits (default 4) */
	level?: number;
	/** Who performed the change; recorded in ban entries written to file */
	actor?: string;
}

export interface AccessChangeResult {
	instance: string;
	list: AccessListKind;
	action: "add" | "remove";
	target: string;
	ok: boolean;
	/** How the change was applied */
	method: "command" | "file";
	error?: string;
}

/** Compute the offline-mode UUID vanilla derives from a player name. */
export function offlineUuid(name: string): string {
	const hash = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();

	// UUID v3: overwrite the version and variant nibbles per RFC 4122.
	hash[6] = (hash[6]! & 0x0f) | 0x30;
	hash[8] = (hash[8]! & 0x3f) | 0x80;

	const hex = hash.toString("hex");

	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
		throw new Error(`unknown instance: ${name}`);
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

/** Loose IPv4/IPv6 shape check — enough to keep garbage out of a console line. */
function looksLikeIp(value: string): boolean {
	return /^[0-9a-fA-F:.]{3,45}$/.test(value) && (value.includes(".") || value.includes(":"));
}

/** Validate a change's target before it reaches a console line or a file. */
function validateTarget(change: AccessChange): string | undefined {
	if (change.list === "ban-ips") {
		return looksLikeIp(change.target) ? undefined : `not a valid IP address: ${change.target}`;
	}

	return NAME_PATTERN.test(change.target)
		? undefined
		: `not a valid player name: ${change.target}`;
}

/** The console command that applies a change on a running server. */
function commandFor(change: AccessChange): string {
	const reason = (change.reason ?? "").trim();

	switch (change.list) {
		case "whitelist": {
			return `whitelist ${change.action === "add" ? "add" : "remove"} ${change.target}`;
		}
		case "ops": {
			return `${change.action === "add" ? "op" : "deop"} ${change.target}`;
		}
		case "bans": {
			return change.action === "add"
				? `ban ${change.target}${reason ? ` ${reason}` : ""}`
				: `pardon ${change.target}`;
		}
		case "ban-ips": {
			return change.action === "add"
				? `ban-ip ${change.target}${reason ? ` ${reason}` : ""}`
				: `pardon-ip ${change.target}`;
		}
	}
}

/** Whether a list currently contains a target, for post-command verification. */
function listContains(lists: AccessLists, change: AccessChange): boolean {
	const lowered = change.target.toLowerCase();

	switch (change.list) {
		case "whitelist": {
			return lists.whitelist.some((entry) => entry.name.toLowerCase() === lowered);
		}
		case "ops": {
			return lists.ops.some((entry) => entry.name.toLowerCase() === lowered);
		}
		case "bans": {
			return lists.bans.some((entry) => entry.name.toLowerCase() === lowered);
		}
		case "ban-ips": {
			return lists.ipBans.some((entry) => entry.ip === change.target);
		}
	}
}

/** Apply a change to a stopped instance by editing the JSON file in place. */
async function applyToFile(
	cfg: ClusterConfig,
	name: string,
	dir: string,
	change: AccessChange,
): Promise<void> {
	const lowered = change.target.toLowerCase();

	if (change.list === "ban-ips") {
		const entries = await readListFile<IpBanEntry>(dir, ACCESS_LIST_FILES["ban-ips"]);
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
		return;
	}

	const uuid = (await usercacheLookup(dir, change.target)) ?? offlineUuid(change.target);

	if (change.list === "whitelist") {
		const entries = await readListFile<WhitelistEntry>(dir, ACCESS_LIST_FILES.whitelist);
		const remaining = entries.filter((entry) => entry.name.toLowerCase() !== lowered);

		if (change.action === "add") {
			remaining.push({ uuid, name: change.target });
		}

		await writeListFile(dir, ACCESS_LIST_FILES.whitelist, remaining);
		return;
	}

	if (change.list === "ops") {
		const entries = await readListFile<OpEntry>(dir, ACCESS_LIST_FILES.ops);
		const remaining = entries.filter((entry) => entry.name.toLowerCase() !== lowered);

		if (change.action === "add") {
			remaining.push({
				uuid,
				name: change.target,
				level: Math.min(4, Math.max(1, change.level ?? 4)),
				bypassesPlayerLimit: false,
			});
		}

		await writeListFile(dir, ACCESS_LIST_FILES.ops, remaining);
		return;
	}

	const entries = await readListFile<BanEntry>(dir, ACCESS_LIST_FILES.bans);
	const remaining = entries.filter((entry) => entry.name.toLowerCase() !== lowered);

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
}

/**
 * Apply one access-list change to one instance — via the console when the
 * server runs, via the JSON file when it is stopped. The result reports which
 * path was taken and, for the command path, whether the file actually shows
 * the change after the command settled.
 */
export async function applyAccessChange(
	cfg: ClusterConfig,
	name: string,
	change: AccessChange,
): Promise<AccessChangeResult> {
	const inst = managedInstances(cfg)[name];

	if (!inst) {
		throw new Error(`unknown instance: ${name}`);
	}

	const invalid = validateTarget(change);

	if (invalid) {
		return {
			instance: name,
			list: change.list,
			action: change.action,
			target: change.target,
			ok: false,
			method: "file",
			error: invalid,
		};
	}

	const dir = instanceDir(inst);
	const status = await getStatus(cfg, name);

	if (status.state === "running") {
		await sendCommand(cfg, name, commandFor(change));
		await Bun.sleep(COMMAND_SETTLE_MS);

		const after = await getAccessLists(cfg, name);
		const present = listContains(after, change);
		const ok = change.action === "add" ? present : !present;

		return {
			instance: name,
			list: change.list,
			action: change.action,
			target: change.target,
			ok,
			method: "command",
			...(ok ? {} : { error: "the server did not persist the change; check the instance console" }),
		};
	}

	if (status.state === "starting") {
		return {
			instance: name,
			list: change.list,
			action: change.action,
			target: change.target,
			ok: false,
			method: "command",
			error: "instance is starting; retry once it is up",
		};
	}

	await applyToFile(cfg, name, dir, change);

	return {
		instance: name,
		list: change.list,
		action: change.action,
		target: change.target,
		ok: true,
		method: "file",
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
		throw new Error(`unknown instance: ${name}`);
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
