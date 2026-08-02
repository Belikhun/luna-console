import { join } from "node:path";

import type { ClusterConfig } from "./types";
import { instanceDir } from "./config";

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
		// everything on the primary's own machine stays on loopback
		const daemonHost = inst.daemon ? cfg.daemons?.[inst.daemon]?.host : undefined;
		const local = daemonHost ? `${daemonHost}:${inst.port}` : `127.0.0.1:${inst.port}`;

		servers[name] = inst.external ?? local;

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

/** The proxy's modern-forwarding secret, shared with every backend. */
export async function readForwardingSecret(cfg: ClusterConfig): Promise<string> {
	const path = join(instanceDir(cfg.proxy), "forwarding.secret");

	return (await Bun.file(path).text()).trim();
}
