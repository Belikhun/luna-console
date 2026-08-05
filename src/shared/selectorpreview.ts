// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What an item in the selector looks like for a given status.
 *
 * This is a port of the plugin's own assembly; material resolution order,
 * template merging, the way a description line is wrapped in `body-line`; so
 * that the editor's preview and the game agree. Where the plugin's rules are
 * surprising, the comment says so; the surprising ones are exactly what makes a
 * hand-written config hard to reason about and an editor worth having.
 */

import {
	DEFAULT_STATUS_MATERIALS,
	type SelectorConditionalRule,
	type SelectorDraft,
	type SelectorServerDraft,
	type SelectorStatus,
	type SelectorTemplate,
	type SelectorTemplateOverride,
} from "./selector";
import { evaluateWhen, type WhenContext } from "./selectorwhen";

/**
 * What a backend last reported, as far as the console knows it.
 *
 * Everything is optional because a preview is routinely asked for a server that
 * is not running, or for a status it is not in; an admin flipping through all
 * four to see how each looks. A field nobody has reported is not zero, it is
 * unknown, and the difference matters: a tooltip that reads `0/0 người chơi` and
 * `đã chạy 0s` shows the admin a card no player will ever see.
 */
export interface PreviewMetrics {
	online?: number;
	max?: number;
	tps?: number;
	uptimeMillis?: number;
	version?: string;
	software?: string;
	cpuUsage?: number;
	ramUsedBytes?: number;
	ramMaxBytes?: number;
	latencyMs?: number;
	motd?: string;
}

export interface ResolvedItem {
	/** The item's name line, still MiniMessage */
	name: string;
	/** Its lore, one MiniMessage string per line */
	lore: string[];
	material: string;
	glint?: boolean;
	status: SelectorStatus;
	/** The `%placeholder%` values this preview resolved */
	values: Record<string, string>;
}

/** The template a status sees: the global one with its by-status overrides on top. */
function resolveTemplate(template: SelectorTemplate | undefined, status: SelectorStatus): SelectorTemplateOverride & {
	material?: string;
} {
	const base: SelectorTemplateOverride & { material?: string } = {
		name: template?.name ?? "<b>%server_display%</b>",
		header: template?.header ?? [],
		bodyLine: template?.bodyLine ?? "%line%",
		footer: template?.footer ?? [],
		material: template?.material,
	};

	const override = template?.byStatus?.[status];

	if (!override) {
		return base;
	}

	// a by-status block overrides field by field; and only these four fields;
	// `material` is never overridable this way
	return {
		name: override.name ?? base.name,
		header: override.header ?? base.header,
		bodyLine: override.bodyLine ?? base.bodyLine,
		footer: override.footer ?? base.footer,
		material: base.material,
	};
}

/** Every conditional rule that matches, merged in file order, later winning. */
function mergeConditionals(rules: SelectorConditionalRule[] | undefined, context: WhenContext): SelectorConditionalRule {
	const merged: SelectorConditionalRule = { when: "" };

	for (const rule of rules ?? []) {
		if (!evaluateWhen(rule.when, context)) {
			continue;
		}

		if (rule.material !== undefined) {
			merged.material = rule.material;
		}

		if (rule.glint !== undefined) {
			merged.glint = rule.glint;
		}

		if (rule.description !== undefined) {
			merged.description = rule.description;
		}
	}

	return merged;
}

function formatNumber(value: number | undefined, digits: number): string {
	return (value ?? 0).toFixed(digits);
}

/** `Formatters.compactDuration`; `3h 51m 36s`, the unit dropped when it is zero. */
export function compactDuration(millis: number): string {
	let total = Math.max(1, Math.floor(millis / 1000));

	const days = Math.floor(total / 86400);
	total %= 86400;

	const hours = Math.floor(total / 3600);
	total %= 3600;

	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	const parts: string[] = [];

	if (days > 0) {
		parts.push(`${days}d`);
	}

	if (hours > 0) {
		parts.push(`${hours}h`);
	}

	if (minutes > 0) {
		parts.push(`${minutes}m`);
	}

	if (seconds > 0 || parts.length === 0) {
		parts.push(`${seconds}s`);
	}

	return parts.join(" ");
}

/** `Formatters.duration`; the same span spelled out, in the plugin's Vietnamese. */
export function longDuration(millis: number): string {
	const total = Math.max(0, Math.floor(millis / 1000));
	const days = Math.floor(total / 86400);
	const hours = Math.floor((total % 86400) / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const parts: string[] = [];

	if (days > 0) {
		parts.push(`${days} ngày`);
	}

	if (hours > 0) {
		parts.push(`${hours} giờ`);
	}

	if (minutes > 0) {
		parts.push(`${minutes} phút`);
	}

	if (seconds > 0 || parts.length === 0) {
		parts.push(`${seconds} giây`);
	}

	return parts.join(" ");
}

/** FNV-1a, only so a server's sample numbers are the same on every render. */
function seedOf(name: string): number {
	let hash = 0x811c9dc5;

	for (let index = 0; index < name.length; index++) {
		hash ^= name.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}

	return hash;
}

/**
 * Stand-in numbers for a backend nothing has reported for.
 *
 * A preview exists to show what a card will look like, and a card is mostly its
 * numbers: how long they are decides where the line ends and whether the name's
 * padding still lines up. Zeroes make every one of them the shortest it can be,
 * so an offline server; or a status being simulated; is drawn from a plausible
 * sample instead, derived from the name so it does not shuffle on every repaint.
 */
function sampleMetrics(name: string): Required<Omit<PreviewMetrics, "version" | "software" | "motd">> {
	// unsigned shifts throughout: the hash fills all thirty-two bits, and a signed
	// one turns half of them into a negative count of players
	const seed = seedOf(name);
	const max = [20, 25, 40, 60][seed % 4] ?? 20;

	return {
		online: (seed >>> 3) % Math.max(1, Math.floor(max / 2)),
		max,
		tps: 20,
		uptimeMillis:
			(2 + ((seed >>> 5) % 46)) * 3600_000 + ((seed >>> 11) % 60) * 60_000 + ((seed >>> 17) % 60) * 1000,
		cpuUsage: 3 + ((seed >>> 7) % 40),
		ramUsedBytes: (1 + ((seed >>> 9) % 5)) * 1024 * 1024 * 1024,
		ramMaxBytes: 8 * 1024 * 1024 * 1024,
		latencyMs: 1 + ((seed >>> 13) % 12),
	};
}

/** Live where it is known, sampled where it is not. */
export function previewMetrics(name: string, metrics: PreviewMetrics): PreviewMetrics &
	Required<Omit<PreviewMetrics, "version" | "software" | "motd">> {
	return { ...sampleMetrics(name), ...reported(metrics) };
}

/** Drop the keys nobody reported, so a sample can show through underneath. */
function reported(metrics: PreviewMetrics): PreviewMetrics {
	const out: PreviewMetrics = {};

	for (const [key, value] of Object.entries(metrics)) {
		if (value === undefined || value === null || value === "") {
			continue;
		}

		out[key as keyof PreviewMetrics] = value as never;
	}

	return out;
}

/** The placeholder table, matching what the plugin resolves for an item. */
export function previewValues(
	name: string,
	server: SelectorServerDraft,
	draft: SelectorDraft,
	status: SelectorStatus,
	metrics: PreviewMetrics,
	playerName: string,
): Record<string, string> {
	const live = previewMetrics(name, metrics);
	const version = live.version ?? server.mcVersion ?? "unknown";
	const software = live.software ?? server.software ?? "unknown";
	const ramUsedMb = Math.floor(live.ramUsedBytes / 1024 / 1024);
	const ramMaxMb = Math.floor(live.ramMaxBytes / 1024 / 1024);

	return {
		server_name: name,
		luna_host_name: server.hostName,
		luna_server_name: server.hostName,
		server_display: server.serverDisplay ?? name,
		server_accent_color: server.accentColor ?? "",
		server_status: status,
		server_status_color: draft.global.statusColors?.[status] ?? "<white>",
		server_status_icon: draft.global.statusIcons?.[status] ?? "●",
		online: String(live.online),
		max: String(live.max),
		uptime: compactDuration(live.uptimeMillis),
		uptime_long: longDuration(live.uptimeMillis),
		tps: formatNumber(live.tps, 2),
		cpu_usage: formatNumber(live.cpuUsage, 1),
		ram_used_mb: String(ramUsedMb),
		ram_max_mb: String(ramMaxMb),
		ram_percent: formatNumber(ramMaxMb <= 0 ? 0 : Math.min(100, (live.ramUsedBytes * 100) / live.ramMaxBytes), 1),
		latency_ms: String(live.latencyMs),
		version,
		server_version: version,
		server_version_full: version,
		software,
		server_software: software,
		motd: live.motd ?? "",
		player_name: playerName,
	};
}

/**
 * Build the item a player would see.
 *
 * @param status the status being previewed; the editor lets an admin flip
 *               through all four without the servers actually being in them
 */
export function resolveItem(
	name: string,
	server: SelectorServerDraft,
	draft: SelectorDraft,
	status: SelectorStatus,
	metrics: PreviewMetrics = {},
	playerName = "Steve",
): ResolvedItem {
	const values = previewValues(name, server, draft, status, metrics, playerName);
	const live = previewMetrics(name, metrics);
	const context: WhenContext = {
		status,
		server_status: status,
		server_name: name,
		luna_host_name: server.hostName,
		luna_server_name: server.hostName,
		server_display: server.serverDisplay ?? name,
		online: live.online,
		max: live.max,
		whitelist: status === "MAINT",
		maint: status === "MAINT",
		no_permission: status === "NOP",
		nop: status === "NOP",
		has_permission: status !== "NOP",
		tps: live.tps,
		cpu_usage: live.cpuUsage,
		latency_ms: live.latencyMs,
		ram_percent: live.ramMaxBytes <= 0 ? 0 : Math.min(100, (live.ramUsedBytes * 100) / live.ramMaxBytes),
		is_online: status === "ONLINE",
		is_offline: status === "OFFLINE",
		is_maint: status === "MAINT",
		is_nop: status === "NOP",
	};

	const conditional = mergeConditionals(server.selector?.conditional, context);
	const template = resolveTemplate(draft.global.template, status);

	const material =
		conditional.material ??
		server.serverStatusIcons?.[status] ??
		server.serverIcon ??
		template.material ??
		DEFAULT_STATUS_MATERIALS[status];

	const glint = conditional.glint ?? server.selector?.glintByStatus?.[status] ?? server.selector?.glint;

	const description =
		conditional.description ?? server.selector?.descriptionByStatus?.[status] ?? server.description ?? [];

	const lore = [
		...(template.header ?? []),
		...description.map((line) => (template.bodyLine ?? "%line%").replace(/%line%/g, line)),
		...(template.footer ?? []),
	];

	return {
		name: template.name ?? "%server_display%",
		lore,
		material,
		glint,
		status,
		values,
	};
}
