// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";

import type { ClusterConfig, ProxyRegistration } from "./types";
import { instanceDir } from "./config";
import { instanceAddress } from "./ports";
import { t } from "../shared/i18n";

/** Path of the proxy's velocity.toml. */
export function velocityTomlPath(cfg: ClusterConfig): string {
	return join(instanceDir(cfg.proxy), "velocity.toml");
}

export interface ProxySyncResult {
	changed: boolean;
	servers: Record<string, string>;
	tryList: string[];
	forcedHosts: Record<string, string[]>;
}

interface ProxySections {
	servers: Record<string, string>;
	tryList: string[];
	forcedHosts: Record<string, string[]>;
}

/** Derive the proxy routing tables from the registry's per-instance `proxy` blocks. */
function buildSections(cfg: ClusterConfig): ProxySections {
	const servers: Record<string, string> = {};
	const tryEntries: Array<{ name: string; priority: number }> = [];
	const forcedHosts: Record<string, string[]> = {};

	for (const [name, inst] of Object.entries(cfg.instances)) {
		const reg = inst.proxy;

		if (!reg?.register) {
			continue;
		}

		// a follower-owned instance is reached over the LAN at its daemon's host;
		// everything on the primary's own machine stays on loopback (the port audit
		// compares against the same helper, so the two can never disagree)
		servers[name] = instanceAddress(cfg, inst);

		if (reg.priority !== undefined) {
			tryEntries.push({ name, priority: reg.priority });
		}

		for (const host of reg.forcedHosts ?? []) {
			(forcedHosts[host] ??= []).push(name);
		}
	}

	tryEntries.sort((a, b) => a.priority - b.priority);

	return {
		servers,
		tryList: tryEntries.map((entry) => entry.name),
		forcedHosts,
	};
}

/**
 * Replace a top-level `[section]` block: from its header up to the next
 * top-level header. A file that has no such section gets one appended.
 */
function replaceSection(text: string, header: string, replacement: string): string {
	const pattern = new RegExp(
		String.raw`(^|\n)\[${header}\][^\n]*\n(?:(?!\[[A-Za-z0-9-]+\])[^\n]*\n?)*`,
	);

	if (!pattern.test(text)) {
		return text + `\n${replacement}\n`;
	}

	return text.replace(pattern, (_match, lead) => `${lead}${replacement}\n\n`);
}

/**
 * Surgically regenerate the [servers] and [forced-hosts] sections of velocity.toml,
 * preserving everything else in the file. Keeps a `.bak` of the previous contents,
 * and with `dryRun` reports what it would write without touching the file.
 */
export async function syncVelocityToml(
	cfg: ClusterConfig,
	dryRun = false,
): Promise<ProxySyncResult & { diffPreview: string }> {
	const path = velocityTomlPath(cfg);
	const original = await Bun.file(path).text();
	const { servers, tryList, forcedHosts } = buildSections(cfg);

	const serverLines = ["[servers]"];

	for (const [name, addr] of Object.entries(servers)) {
		serverLines.push(`\t${name} = "${addr}"`);
	}

	serverLines.push(`\ttry = [${tryList.map((name) => `"${name}"`).join(", ")}]`);

	const forcedLines = ["[forced-hosts]"];

	for (const [host, names] of Object.entries(forcedHosts)) {
		forcedLines.push(`\t"${host}" = [${names.map((name) => `"${name}"`).join(", ")}]`);
	}

	let updated = replaceSection(original, "servers", serverLines.join("\n"));

	updated = replaceSection(updated, "forced-hosts", forcedLines.join("\n"));
	updated = updated.replace(/\n{3,}/g, "\n\n");

	const changed = updated !== original;

	if (changed && !dryRun) {
		await Bun.write(path + ".bak", original);
		await Bun.write(path, updated);
	}

	return {
		changed,
		servers,
		tryList,
		forcedHosts,
		diffPreview: [serverLines.join("\n"), "", forcedLines.join("\n")].join("\n"),
	};
}

/** Parse the [servers] entries actually present in velocity.toml on disk. */
export async function readVelocityServers(cfg: ClusterConfig): Promise<Record<string, string>> {
	const text = await Bun.file(velocityTomlPath(cfg)).text();
	const section = text.match(/(^|\n)\[servers\][^\n]*\n((?:(?!\[[A-Za-z0-9-]+\])[^\n]*\n?)*)/);
	const servers: Record<string, string> = {};

	if (!section) {
		return servers;
	}

	for (const line of section[2]!.split("\n")) {
		const pair = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/);

		if (pair && pair[1] !== "try") {
			servers[pair[1]!] = pair[2]!;
		}
	}

	return servers;
}

export interface ProxyRegistrationUpdate {
	register?: boolean;
	/** New try-list priority; null takes the instance out of the try list. */
	priority?: number | null;
	/** Replacement forced-host list; an empty array clears it. */
	forcedHosts?: string[];
}

// velocity matches forced hosts literally against what the client asked for,
// so anything that is not a plain hostname could never route a player
const FORCED_HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Lowercased, trimmed hostname; throws when velocity could never be asked for it. */
function normalizeForcedHost(host: string): string {
	const clean = host.trim().toLowerCase();

	if (!clean || !FORCED_HOST.test(clean)) {
		throw new Error(t("core.proxy.badHost", { host: host.trim() }));
	}

	return clean;
}

/**
 * Change how an instance is registered with the velocity proxy: whether it is
 * in [servers] at all, where it sits in the try list, and which hostnames are
 * force-routed to it.
 *
 * Registry only, and everything is validated before anything is written: the
 * caller saves the cluster config and runs `syncVelocityToml` to land the
 * change in velocity.toml. Returns the fields that actually changed value
 * (a field set to what it already held is not one of them) and the resulting
 * registration, absent when the instance ends up with no proxy block at all.
 */
export function setProxyRegistration(
	cfg: ClusterConfig,
	name: string,
	update: ProxyRegistrationUpdate,
): { changed: string[]; registration?: ProxyRegistration } {
	// the proxy itself lives outside cfg.instances, so "proxy" lands here too:
	// velocity cannot be registered with itself
	const inst = cfg.instances[name];

	if (!inst) {
		throw new Error(t("core.proxy.notRegistrable", { name }));
	}

	if (typeof update.priority === "number") {
		if (!Number.isInteger(update.priority) || update.priority < 0 || update.priority > 9999) {
			throw new Error(t("core.proxy.badPriority", { value: String(update.priority) }));
		}
	}

	const hosts =
		update.forcedHosts !== undefined
			? [...new Set(update.forcedHosts.map(normalizeForcedHost))]
			: undefined;

	const current: ProxyRegistration = inst.proxy ?? { register: false };
	const next: ProxyRegistration = { register: update.register ?? current.register };

	const priority =
		update.priority === undefined
			? current.priority
			: update.priority ?? undefined;

	if (priority !== undefined) {
		next.priority = priority;
	}

	const forcedHosts = hosts ?? current.forcedHosts ?? [];

	if (forcedHosts.length) {
		next.forcedHosts = forcedHosts;
	}

	const changed: string[] = [];

	if (next.register !== current.register) {
		changed.push("register");
	}

	if (next.priority !== current.priority) {
		changed.push("priority");
	}

	if ((next.forcedHosts ?? []).join(",") !== (current.forcedHosts ?? []).join(",")) {
		changed.push("forcedHosts");
	}

	// a block saying only "not registered" is the same as no block at all
	if (!next.register && next.priority === undefined && !next.forcedHosts?.length) {
		delete inst.proxy;
	} else {
		inst.proxy = next;
	}

	return { changed, registration: inst.proxy };
}

/**
 * The proxy's modern-forwarding secret, shared with every backend.
 *
 * Velocity writes this file itself on its first start, but luna reads it
 * *before* that: the secret goes into a backend's forwarding config when the
 * instance is created, and into the proxy's own environment when it is started.
 * On a cluster that has never run the proxy neither of those can happen, so a
 * missing file is generated here rather than reported - which is what velocity
 * would do a moment later anyway, with the same 12 random bytes.
 */
export async function readForwardingSecret(cfg: ClusterConfig): Promise<string> {
	const path = join(instanceDir(cfg.proxy), "forwarding.secret");

	if (existsSync(path)) {
		const existing = (await Bun.file(path).text()).trim();

		if (existing) {
			return existing;
		}
	}

	const secret = randomBytes(12).toString("base64url");

	await mkdir(dirname(path), { recursive: true });
	await Bun.write(path, secret);

	return secret;
}
