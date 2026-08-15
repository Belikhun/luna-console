// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The server selector, as luna owns it.
 *
 * The proxy's LunaCore plugin renders its `/servers` chest GUI from
 * `proxy/plugins/lunacore/servers.yml`. That file is now **generated**:
 * cluster.json holds the per-instance half (display name, accent, icon,
 * description, placement) and a cluster-level `serverSelector` section holds the
 * rest, and `applySelector` writes the file and asks the proxy to reload.
 *
 * Going the other way is a one-time affair; `importServersYml` reads a
 * hand-written file into cluster.json, and refuses to save unless regenerating
 * from what it imported reproduces the same configuration, so the first apply
 * after a migration cannot change what players see.
 */

import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { root } from "./config";
import { ProgressReporter } from "./progress";
import * as luna from "./services/luna";
import {
	SELECTOR_STATUSES,
	isPlaced,
	selectorErrors,
	validateSelectorDraft,
	type SelectorConditionalRule,
	type SelectorDraft,
	type SelectorIssue,
	type SelectorServerDraft,
	type SelectorStatus,
	type SelectorTemplate,
	type SelectorTemplateOverride,
	type ServerSelectorConfig,
} from "../shared/selector";
import type { ClusterConfig, InstanceConfig, InstanceSelectorEntry } from "./types";
import { t } from "../shared/i18n";

export type {
	SelectorConditionalRule,
	SelectorDraft,
	SelectorIssue,
	SelectorServerDraft,
	SelectorStatus,
	SelectorTemplate,
	SelectorTemplateOverride,
	ServerSelectorConfig,
} from "../shared/selector";

/** How long to keep probing for the proxy's HTTP server after a reload. */
const RELOAD_PROBE_ATTEMPTS = 10;
const RELOAD_PROBE_INTERVAL_MS = 500;

/** Where the proxy plugin reads its selector configuration. */
export function serversYmlPath(): string {
	return join(root(), "proxy", "plugins", "lunacore", "servers.yml");
}

function backupPath(): string {
	return `${serversYmlPath()}.bak`;
}

/** Every instance that can appear in the selector, proxy excluded. */
function selectableInstances(cfg: ClusterConfig): Array<[string, InstanceConfig]> {
	return Object.entries(cfg.instances);
}

/**
 * Read the editor's view of the cluster.
 *
 * `hostName` is derived from ownership rather than stored: it is the daemon the
 * instance runs on, which is exactly what `server-info.host-name` means to the
 * plugin, and storing it would let it drift the moment an instance moved.
 */
export function draftFromCluster(cfg: ClusterConfig, primaryName: string): SelectorDraft {
	const servers: Record<string, SelectorServerDraft> = {};

	for (const [name, inst] of selectableInstances(cfg)) {
		servers[name] = {
			serverDisplay: inst.serverDisplay,
			accentColor: inst.accentColor,
			serverIcon: inst.serverIcon,
			serverStatusIcons: inst.serverStatusIcons,
			description: inst.description,
			selector: inst.selector,
			hostName: inst.daemon ?? primaryName,
			software: inst.software,
			mcVersion: inst.mcVersion,
			external: !!inst.external,
			publicListed: inst.publicListed === true,
		};
	}

	return {
		global: cfg.serverSelector ?? { enabled: true },
		servers,
	};
}

/** Assign a value, or delete the key when the value is empty. */
function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
	// the plugin treats "" as absent and falls back to its own default, so an
	// empty value must leave the key out rather than write it blank
	const empty =
		value === undefined ||
		value === null ||
		(typeof value === "string" && value.trim() === "") ||
		(Array.isArray(value) && value.length === 0) ||
		(typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0);

	if (empty) {
		delete target[key];

		return;
	}

	target[key] = value;
}

/**
 * Write an edited draft back into the cluster registry.
 *
 * The caller still owns saving; this only mutates, matching how every other
 * registry edit in luna works.
 */
export function applyDraftToCluster(cfg: ClusterConfig, draft: SelectorDraft): void {
	cfg.serverSelector = draft.global;

	for (const [name, server] of Object.entries(draft.servers)) {
		const inst = cfg.instances[name];

		if (!inst) {
			continue;
		}

		assign(inst, "serverDisplay", server.serverDisplay);
		assign(inst, "accentColor", server.accentColor);
		assign(inst, "serverIcon", server.serverIcon);
		assign(inst, "serverStatusIcons", server.serverStatusIcons);
		assign(inst, "description", server.description);
		assign(inst, "selector", server.selector);

		// `assign` deletes a falsy value, which is exactly right here: not listed is
		// the absence of the flag rather than a `false` stored against every server
		assign(inst, "publicListed", server.publicListed === true ? true : undefined);
	}
}

export function validateSelector(cfg: ClusterConfig, primaryName: string): SelectorIssue[] {
	return validateSelectorDraft(draftFromCluster(cfg, primaryName));
}

// -- generation ---------------------------------------------------------------

type YamlValue = string | number | boolean | YamlValue[] | { [key: string]: YamlValue };
type YamlMap = { [key: string]: YamlValue };

/** Put a key only when it carries something the plugin would read. */
function put(map: YamlMap, key: string, value: YamlValue | undefined): void {
	if (value === undefined || value === null) {
		return;
	}

	if (typeof value === "string" && value.trim() === "") {
		return;
	}

	if (Array.isArray(value) && value.length === 0) {
		return;
	}

	if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
		return;
	}

	map[key] = value;
}

function statusMap<T extends YamlValue>(source: Partial<Record<SelectorStatus, T>> | undefined): YamlMap {
	const out: YamlMap = {};

	if (!source) {
		return out;
	}

	for (const status of SELECTOR_STATUSES) {
		put(out, status, source[status]);
	}

	return out;
}

function templateOverrideMap(override: SelectorTemplateOverride | undefined): YamlMap {
	const out: YamlMap = {};

	if (!override) {
		return out;
	}

	put(out, "name", override.name);
	put(out, "header", override.header);
	put(out, "body-line", override.bodyLine);
	put(out, "footer", override.footer);

	return out;
}

function templateMap(template: SelectorTemplate | undefined): YamlMap {
	const out: YamlMap = templateOverrideMap(template);

	if (!template) {
		return out;
	}

	put(out, "material", template.material);

	const byStatus: YamlMap = {};

	for (const status of SELECTOR_STATUSES) {
		put(byStatus, status, templateOverrideMap(template.byStatus?.[status]));
	}

	put(out, "by-status", byStatus);

	return out;
}

function conditionalList(rules: SelectorConditionalRule[] | undefined): YamlValue[] {
	const out: YamlValue[] = [];

	for (const rule of rules ?? []) {
		const entry: YamlMap = {};

		put(entry, "when", rule.when);
		put(entry, "material", rule.material);

		if (rule.glint !== undefined) {
			entry.glint = rule.glint;
		}

		put(entry, "description", rule.description);
		put(entry, "template", rule.template as YamlValue | undefined);

		if (Object.keys(entry).length > 0) {
			out.push(entry);
		}
	}

	return out;
}

/** Sort placed servers by where they sit, so a diff reads like the grid. */
function placementOrder(draft: SelectorDraft): Array<[string, SelectorServerDraft]> {
	return Object.entries(draft.servers)
		.filter(([, server]) => isPlaced(server))
		.sort(([leftName, left], [rightName, right]) => {
			const a = left.selector!;
			const b = right.selector!;

			return a.page - b.page || a.slot - b.slot || leftName.localeCompare(rightName);
		});
}

/**
 * Servers that need a `server-info` block: everything with an identity, placed
 * or not.
 *
 * `server-info` is not the grid. The proxy reads it whenever it needs a
 * backend's display name or accent; for the heartbeat registry, placeholders,
 * TAB, connect messages; so a server that never appears in the selector still
 * belongs here. `lobby` is exactly that case: it has no item in the grid because
 * the GUI gives it a dedicated footer button, but dropping its entry would
 * rename it from SẢNH to "lobby" everywhere.
 */
function identityOrder(draft: SelectorDraft): Array<[string, SelectorServerDraft]> {
	const placed = placementOrder(draft);
	const seen = new Set(placed.map(([name]) => name));
	const rest = Object.entries(draft.servers)
		.filter(([name, server]) => !seen.has(name) && (server.serverDisplay || server.accentColor))
		.sort(([leftName], [rightName]) => leftName.localeCompare(rightName));

	return [...placed, ...rest];
}

const GENERATED_HEADER = [
	" GENERATED BY luna. Do not edit by hand.",
	" Edit it in the console (Instances → Server selector) or with `luna selector`,",
	" then run `luna selector apply`. The next apply overwrites whatever is here.",
].join("\n");

/**
 * Render the whole selector configuration as `servers.yml`.
 *
 * Deterministic on purpose: the same cluster.json always produces the same
 * bytes, which is what lets `selectorStatus` detect drift and what makes the
 * migration's round-trip check meaningful.
 */
export function buildServersYml(cfg: ClusterConfig, primaryName: string): string {
	const draft = draftFromCluster(cfg, primaryName);
	const placed = placementOrder(draft);

	const serverInfo: YamlMap = {};
	const servers: YamlMap = {};
	const descriptions: YamlMap = {};

	for (const [name, server] of identityOrder(draft)) {
		const info: YamlMap = {};
		put(info, "display", server.serverDisplay);
		put(info, "accent-color", server.accentColor);
		put(info, "host-name", server.hostName);
		put(serverInfo, name.toLowerCase(), info);
	}

	for (const [name, server] of placed) {
		const key = name.toLowerCase();
		const entry = server.selector as InstanceSelectorEntry;

		const definition: YamlMap = {};
		definition.page = entry.page;
		definition.slot = entry.slot;
		put(definition, "permission", entry.permission);
		put(definition, "connect-message", entry.connectMessage);
		put(definition, "material", server.serverIcon);
		put(definition, "material-by-status", statusMap(server.serverStatusIcons));

		if (entry.glint !== undefined) {
			definition.glint = entry.glint;
		}

		put(definition, "glint-by-status", statusMap(entry.glintByStatus));
		put(definition, "conditional", conditionalList(entry.conditional));
		put(definition, "descriptions-by-status", statusMap(entry.descriptionByStatus));
		put(definition, "template", entry.template as YamlValue | undefined);
		put(servers, key, definition);

		// description keys are matched case-sensitively against the already
		// lowercased backend name, so they must be written lowercase
		put(descriptions, key, server.description);
	}

	const global = draft.global;
	const selector: YamlMap = {};

	selector.enabled = global.enabled !== false;

	if (global.failOnServerCommandOverrideFailure !== undefined) {
		selector["fail-on-server-command-override-failure"] = global.failOnServerCommandOverrideFailure;
	}

	const diagnostics: YamlMap = {};

	if (global.diagnostics?.enabled !== undefined) {
		diagnostics.enabled = global.diagnostics.enabled;
	}

	if (global.diagnostics?.failOnValidationError !== undefined) {
		diagnostics["fail-on-validation-error"] = global.diagnostics.failOnValidationError;
	}

	if (global.diagnostics?.unknownPlaceholderAsError !== undefined) {
		diagnostics["unknown-placeholder-as-error"] = global.diagnostics.unknownPlaceholderAsError;
	}

	put(selector, "title", global.title);
	put(selector, "diagnostics", diagnostics);
	put(selector, "template", templateMap(global.template));

	const messages: YamlMap = {};
	put(messages, "opening", global.messages?.opening);
	put(messages, "player-only", global.messages?.playerOnly);
	put(messages, "not-found", global.messages?.notFound);
	put(messages, "offline", global.messages?.offline);
	put(messages, "maint", global.messages?.maint);
	put(messages, "no-permission", global.messages?.noPermission);
	put(messages, "connecting", global.messages?.connecting);
	put(selector, "messages", messages);

	put(selector, "status-colors", statusMap(global.statusColors));
	put(selector, "status-icons", statusMap(global.statusIcons));
	put(selector, "servers", servers);
	put(selector, "descriptions", descriptions);

	const document: YamlMap = {};
	put(document, "server-info", serverInfo);
	document["server-selector"] = selector;

	const body = renderYaml(document, 0);

	return `#${GENERATED_HEADER.split("\n").join("\n#")}\n\n${body}`;
}

/** Quote every string: MiniMessage is full of `#`, `:` and `>`. */
function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderScalar(value: YamlValue): string {
	if (typeof value === "string") {
		return quote(value);
	}

	return String(value);
}

/**
 * Emit YAML by hand rather than through the library's stringifier.
 *
 * The output has to be stable down to key order and quoting style, because
 * drift detection compares what is on disk with what this produces; a
 * stringifier that decides for itself when to fold a line or drop quotes would
 * make an unchanged config look changed.
 */
function renderYaml(value: YamlValue, depth: number): string {
	const pad = "  ".repeat(depth);
	const lines: string[] = [];

	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === "object" && item !== null && !Array.isArray(item)) {
				const nested = renderYaml(item, depth + 1).split("\n");
				const first = nested.shift() ?? "";
				lines.push(`${pad}- ${first.trimStart()}`);

				for (const line of nested) {
					lines.push(line);
				}

				continue;
			}

			lines.push(`${pad}- ${renderScalar(item)}`);
		}

		return lines.join("\n");
	}

	if (typeof value === "object" && value !== null) {
		for (const [key, entry] of Object.entries(value)) {
			if (Array.isArray(entry)) {
				lines.push(`${pad}${key}:`);
				lines.push(renderYaml(entry, depth + 1));

				continue;
			}

			if (typeof entry === "object" && entry !== null) {
				lines.push(`${pad}${key}:`);
				lines.push(renderYaml(entry, depth + 1));

				continue;
			}

			lines.push(`${pad}${key}: ${renderScalar(entry)}`);
		}

		return lines.join("\n");
	}

	return `${pad}${renderScalar(value)}`;
}

// -- normalisation and comparison ---------------------------------------------

type Unknown = unknown;

/**
 * Reduce a parsed `servers.yml` to what the plugin actually sees.
 *
 * Comments and formatting are already gone by parse time; this removes the rest
 * of the noise; blank strings (which the plugin reads as absent), key order,
 * and the case of the keys it lowercases itself; so two files can be compared
 * on meaning rather than on text.
 */
export function normalizeSelectorDoc(value: Unknown): Unknown {
	if (Array.isArray(value)) {
		return value.map((item) => normalizeSelectorDoc(item));
	}

	if (value && typeof value === "object") {
		const out: Record<string, Unknown> = {};

		for (const key of Object.keys(value as Record<string, Unknown>).sort()) {
			const normalized = normalizeSelectorDoc((value as Record<string, Unknown>)[key]);

			if (normalized === undefined) {
				continue;
			}

			out[key.toLowerCase()] = normalized;
		}

		return Object.keys(out).length === 0 ? undefined : out;
	}

	if (typeof value === "string") {
		const trimmed = value.trim();

		return trimmed === "" ? undefined : trimmed;
	}

	return value ?? undefined;
}

/** Every path where two normalized documents disagree. */
function diffPaths(left: Unknown, right: Unknown, path = ""): string[] {
	if (JSON.stringify(left) === JSON.stringify(right)) {
		return [];
	}

	const bothMaps =
		left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right);

	if (!bothMaps) {
		return [`${path || "<root>"}: ${JSON.stringify(left) ?? "absent"} ≠ ${JSON.stringify(right) ?? "absent"}`];
	}

	const keys = new Set([
		...Object.keys(left as Record<string, Unknown>),
		...Object.keys(right as Record<string, Unknown>),
	]);
	const out: string[] = [];

	for (const key of [...keys].sort()) {
		out.push(
			...diffPaths(
				(left as Record<string, Unknown>)[key],
				(right as Record<string, Unknown>)[key],
				path ? `${path}.${key}` : key,
			),
		);
	}

	return out;
}

// -- import -------------------------------------------------------------------

function stringOr(value: Unknown, fallback?: string): string | undefined {
	if (typeof value !== "string") {
		return fallback;
	}

	const trimmed = value.trim();

	return trimmed === "" ? fallback : trimmed;
}

function stringList(value: Unknown): string[] | undefined {
	if (typeof value === "string") {
		return value.split(/\r?\n/);
	}

	if (!Array.isArray(value)) {
		return undefined;
	}

	return value.map((item) => (typeof item === "string" ? item : String(item ?? "")));
}

function statusRecord<T>(value: Unknown, read: (entry: Unknown) => T | undefined): Partial<Record<SelectorStatus, T>> | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	const source = value as Record<string, Unknown>;
	const out: Partial<Record<SelectorStatus, T>> = {};

	for (const status of SELECTOR_STATUSES) {
		const entry = read(source[status]);

		if (entry !== undefined) {
			out[status] = entry;
		}
	}

	return Object.keys(out).length === 0 ? undefined : out;
}

function readTemplateOverride(value: Unknown): SelectorTemplateOverride | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	const source = value as Record<string, Unknown>;
	const out: SelectorTemplateOverride = {};

	const name = stringOr(source.name);
	const bodyLine = stringOr(source["body-line"]);
	const header = stringList(source.header);
	const footer = stringList(source.footer);

	if (name !== undefined) {
		out.name = name;
	}

	if (bodyLine !== undefined) {
		out.bodyLine = bodyLine;
	}

	if (header !== undefined) {
		out.header = header;
	}

	if (footer !== undefined) {
		out.footer = footer;
	}

	return Object.keys(out).length === 0 ? undefined : out;
}

function readTemplate(value: Unknown): SelectorTemplate | undefined {
	const base = readTemplateOverride(value);

	if (!value || typeof value !== "object") {
		return base;
	}

	const source = value as Record<string, Unknown>;
	const out: SelectorTemplate = { ...(base ?? {}) };
	const material = stringOr(source.material);

	if (material !== undefined) {
		out.material = material;
	}

	const byStatus = statusRecord(source["by-status"], readTemplateOverride);

	if (byStatus) {
		out.byStatus = byStatus;
	}

	return Object.keys(out).length === 0 ? undefined : out;
}

function readConditional(value: Unknown): SelectorConditionalRule[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const out: SelectorConditionalRule[] = [];

	for (const item of value) {
		if (!item || typeof item !== "object") {
			continue;
		}

		const source = item as Record<string, Unknown>;
		const when = stringOr(source.when) ?? stringOr(source.condition);

		if (!when) {
			continue;
		}

		const rule: SelectorConditionalRule = { when };
		const material = stringOr(source.material);
		const description = stringList(source.description);

		if (material !== undefined) {
			rule.material = material;
		}

		if (typeof source.glint === "boolean") {
			rule.glint = source.glint;
		}

		if (description !== undefined) {
			rule.description = description;
		}

		if (source.template && typeof source.template === "object") {
			rule.template = source.template as Record<string, unknown>;
		}

		out.push(rule);
	}

	return out.length === 0 ? undefined : out;
}

export interface ImportReport {
	/** Instances that received selector metadata */
	imported: string[];
	warnings: string[];
	/** Whether regenerating from what was imported reproduces the source file */
	equal: boolean;
	diff: string[];
	saved: boolean;
}

/**
 * Read a hand-written `servers.yml` into the cluster registry.
 *
 * The gate that matters is the round-trip: after importing, this regenerates the
 * file and compares it with the source on meaning. If they differ, nothing is
 * saved unless `force` is set; an import that loses a field would otherwise
 * show up much later as the first apply silently changing the GUI.
 *
 * @param write persists the mutated cluster; the caller supplies it so core
 *              stays out of the save path's routing
 */
export async function importServersYml(
	cfg: ClusterConfig,
	primaryName: string,
	opts: { dryRun?: boolean; force?: boolean; write?: (cfg: ClusterConfig) => Promise<void> } = {},
): Promise<ImportReport> {
	const file = Bun.file(serversYmlPath());

	if (!(await file.exists())) {
		throw new Error(t("core.selector.noFile", { path: serversYmlPath() }));
	}

	// the live file carries a UTF-8 BOM, which the YAML parser reads as content
	const text = (await file.text()).replace(/^﻿/, "");
	const document = parseYaml(text) as Record<string, Unknown> | null;

	if (!document || typeof document !== "object") {
		throw new Error(t("core.selector.badYaml"));
	}

	const warnings: string[] = [];
	const imported: string[] = [];

	const serverInfo = (document["server-info"] ?? {}) as Record<string, Unknown>;
	const selector = (document["server-selector"] ?? {}) as Record<string, Unknown>;
	const definitions = (selector.servers ?? {}) as Record<string, Unknown>;
	const descriptions = (selector.descriptions ?? {}) as Record<string, Unknown>;

	const global: ServerSelectorConfig = { enabled: selector.enabled !== false };

	const title = stringOr(selector.title);

	if (title !== undefined) {
		global.title = title;
	}

	if (typeof selector["fail-on-server-command-override-failure"] === "boolean") {
		global.failOnServerCommandOverrideFailure = selector["fail-on-server-command-override-failure"] as boolean;
	}

	const diagnosticsSource = (selector.diagnostics ?? {}) as Record<string, Unknown>;
	const diagnostics: ServerSelectorConfig["diagnostics"] = {};

	if (typeof diagnosticsSource.enabled === "boolean") {
		diagnostics.enabled = diagnosticsSource.enabled;
	}

	if (typeof diagnosticsSource["fail-on-validation-error"] === "boolean") {
		diagnostics.failOnValidationError = diagnosticsSource["fail-on-validation-error"] as boolean;
	}

	if (typeof diagnosticsSource["unknown-placeholder-as-error"] === "boolean") {
		diagnostics.unknownPlaceholderAsError = diagnosticsSource["unknown-placeholder-as-error"] as boolean;
	}

	if (Object.keys(diagnostics).length > 0) {
		global.diagnostics = diagnostics;
	}

	const template = readTemplate(selector.template);

	if (template) {
		global.template = template;
	}

	const messagesSource = (selector.messages ?? {}) as Record<string, Unknown>;
	const messages: ServerSelectorConfig["messages"] = {};
	const messageKeys: Array<[keyof NonNullable<ServerSelectorConfig["messages"]>, string]> = [
		["opening", "opening"],
		["playerOnly", "player-only"],
		["notFound", "not-found"],
		["offline", "offline"],
		["maint", "maint"],
		["noPermission", "no-permission"],
		["connecting", "connecting"],
	];

	for (const [field, key] of messageKeys) {
		const value = stringOr(messagesSource[key]);

		if (value !== undefined) {
			messages[field] = value;
		}
	}

	if (Object.keys(messages).length > 0) {
		global.messages = messages;
	}

	const statusColors = statusRecord(selector["status-colors"], (entry) => stringOr(entry));
	const statusIcons = statusRecord(selector["status-icons"], (entry) => stringOr(entry));

	if (statusColors) {
		global.statusColors = statusColors;
	}

	if (statusIcons) {
		global.statusIcons = statusIcons;
	}

	// index the registry by lowercased name; servers.yml keys are lowercase and
	// an instance name that differs only in case is still the same instance
	const byLowerName = new Map<string, string>();

	for (const [name] of selectableInstances(cfg)) {
		byLowerName.set(name.toLowerCase(), name);
	}

	for (const [rawKey, rawDefinition] of Object.entries(definitions)) {
		const key = rawKey.trim().toLowerCase();
		const name = byLowerName.get(key);

		if (!name) {
			warnings.push(t("core.selector.unknownServer", { key: `servers.${rawKey}` }));

			continue;
		}

		const inst = cfg.instances[name] as InstanceConfig;
		const definition = (rawDefinition ?? {}) as Record<string, Unknown>;
		const info = (serverInfo[key] ?? {}) as Record<string, Unknown>;

		const display = stringOr(info.display) ?? stringOr(definition.display);
		const accent = stringOr(info["accent-color"]) ?? stringOr(definition["accent-color"]);
		const hostName = stringOr(info["host-name"]);
		const expectedHost = inst.daemon ?? primaryName;

		if (hostName && hostName !== expectedHost) {
			warnings.push(
				t("core.selector.hostMismatch", { key, hostName, name, expected: expectedHost }),
			);
		}

		const entry: InstanceSelectorEntry = {
			page: typeof definition.page === "number" ? definition.page : 1,
			slot: typeof definition.slot === "number" ? definition.slot : 0,
		};

		if (typeof definition.page !== "number" || typeof definition.slot !== "number") {
			warnings.push(t("core.selector.pinnedSlot", { key, page: entry.page, slot: entry.slot }));
		}

		const permission = stringOr(definition.permission);
		const connectMessage = stringOr(definition["connect-message"]);

		if (permission !== undefined) {
			entry.permission = permission;
		}

		if (connectMessage !== undefined) {
			entry.connectMessage = connectMessage;
		}

		if (typeof definition.glint === "boolean") {
			entry.glint = definition.glint;
		}

		const glintByStatus = statusRecord(definition["glint-by-status"], (value) =>
			typeof value === "boolean" ? value : undefined,
		);

		if (glintByStatus) {
			entry.glintByStatus = glintByStatus;
		}

		const conditional = readConditional(definition.conditional);

		if (conditional) {
			entry.conditional = conditional;
		}

		const descriptionByStatus = statusRecord(definition["descriptions-by-status"], (value) => stringList(value));

		if (descriptionByStatus) {
			entry.descriptionByStatus = descriptionByStatus;
		}

		if (definition.template && typeof definition.template === "object") {
			entry.template = definition.template as Record<string, unknown>;
			warnings.push(t("core.selector.templateKept", { key }));
		}

		assign(inst, "serverDisplay", display);
		assign(inst, "accentColor", accent);
		assign(inst, "serverIcon", stringOr(definition.material));
		assign(inst, "serverStatusIcons", statusRecord(definition["material-by-status"], (value) => stringOr(value)));
		assign(inst, "description", stringList(descriptions[key]));
		inst.selector = entry;

		imported.push(name);
	}

	// a server-info entry without a servers entry is a backend that has an identity
	// but no item in the grid; lobby, which the GUI reaches by its footer button.
	// Its display name still feeds the registry, so import it as an unplaced server.
	for (const [rawKey, rawInfo] of Object.entries(serverInfo)) {
		const key = rawKey.trim().toLowerCase();

		if (definitions[key]) {
			continue;
		}

		const name = byLowerName.get(key);

		if (!name) {
			warnings.push(t("core.selector.unknownServer", { key: `server-info.${rawKey}` }));

			continue;
		}

		const inst = cfg.instances[name] as InstanceConfig;
		const info = (rawInfo ?? {}) as Record<string, Unknown>;

		assign(inst, "serverDisplay", stringOr(info.display));
		assign(inst, "accentColor", stringOr(info["accent-color"]));
		delete inst.selector;
		imported.push(name);
	}

	cfg.serverSelector = global;

	const regenerated = normalizeSelectorDoc(parseYaml(buildServersYml(cfg, primaryName)));
	const original = normalizeSelectorDoc(document);
	const diff = diffPaths(original, regenerated);
	const equal = diff.length === 0;

	let saved = false;

	if (!opts.dryRun && (equal || opts.force) && opts.write) {
		await opts.write(cfg);
		saved = true;
	}

	return { imported, warnings, equal, diff, saved };
}

// -- state and apply ----------------------------------------------------------

export interface SelectorState {
	/** cluster.json carries a selector section */
	configured: boolean;
	fileExists: boolean;
	/** The file on disk differs from what cluster.json would generate */
	drift: boolean;
	driftPaths: string[];
	issues: SelectorIssue[];
	placed: number;
	pages: number;
	proxyReachable: boolean;
}

/** What the selector looks like right now, on disk and in the registry. */
export async function selectorStatus(cfg: ClusterConfig, primaryName: string): Promise<SelectorState> {
	const draft = draftFromCluster(cfg, primaryName);
	const placed = placementOrder(draft);
	const file = Bun.file(serversYmlPath());
	const fileExists = await file.exists();

	let driftPaths: string[] = [];

	if (fileExists) {
		const text = (await file.text()).replace(/^﻿/, "");

		try {
			const current = normalizeSelectorDoc(parseYaml(text));
			const generated = normalizeSelectorDoc(parseYaml(buildServersYml(cfg, primaryName)));
			driftPaths = diffPaths(current, generated);
		} catch (err) {
			driftPaths = [`servers.yml did not parse: ${(err as Error).message}`];
		}
	}

	const health = await luna.call<unknown>("/health");

	return {
		configured: !!cfg.serverSelector,
		fileExists,
		drift: driftPaths.length > 0,
		driftPaths,
		issues: validateSelectorDraft(draft),
		placed: placed.length,
		pages: placed.reduce((max, [, server]) => Math.max(max, server.selector?.page ?? 1), 0),
		proxyReachable: health.ok,
	};
}

export interface ApplyResult {
	wrote: boolean;
	proxyReloaded: boolean;
	/** What `lunacoreproxy reload` printed, when it answered */
	reloadOutput?: string;
	placed: number;
}

/**
 * Write `servers.yml` and make the proxy adopt it.
 *
 * Backends need no attention: since the registry rewrite they re-fetch the
 * selector configuration on every heartbeat and redraw open menus when it
 * changes, so a proxy reload is the whole job.
 */
export async function applySelector(
	cfg: ClusterConfig,
	primaryName: string,
	opts: { reporter?: ProgressReporter } = {},
): Promise<ApplyResult> {
	const progress = opts.reporter ?? new ProgressReporter("apply selector");
	progress.weighOwn(0);

	const checking = progress.child("Validation", 1);
	const writing = progress.child("servers.yml", 1);
	const reloading = progress.child("Proxy reload", 3);

	const issues = validateSelector(cfg, primaryName);
	const errors = selectorErrors(issues);

	if (errors.length > 0) {
		// the plugin aborts its own reload on these, leaving the old config live
		// with nothing in the console to say why; fail here, where the message is
		checking.say("error", t("core.selector.errorSummary", { count: errors.length, path: errors[0]?.path ?? "", message: errors[0]?.message ?? "" }));

		throw new Error(t("core.selector.hasErrors", { count: errors.length }));
	}

	checking.complete(issues.length ? t("core.selector.warnings", { count: issues.length }) : t("core.selector.noIssues"));

	const body = buildServersYml(cfg, primaryName);
	const target = serversYmlPath();
	const existing = Bun.file(target);

	if (await existing.exists()) {
		await Bun.write(backupPath(), await existing.arrayBuffer());
	}

	// stage and rename: a half-written servers.yml is a config the proxy would
	// refuse to load, and it would only find out on the next reload
	await Bun.write(`${target}.new`, body);
	await Bun.file(`${target}.new`).arrayBuffer();
	await Bun.$`mv ${`${target}.new`} ${target}`.quiet();
	writing.complete(t("core.selector.linesWritten", { count: body.split("\n").length }));

	const placed = placementOrder(draftFromCluster(cfg, primaryName)).length;
	const reload = await luna.runCommand("lunacoreproxy reload");

	if (reload.ok) {
		const output = (reload.data?.output ?? []).join(" ").trim();
		reloading.complete(t("core.selector.reloaded"));

		return { wrote: true, proxyReloaded: true, reloadOutput: output || undefined, placed };
	}

	// Reloading rebuilds the proxy's HTTP server, which is the one serving this
	// very request; so a dropped connection is the *expected* answer, not a
	// failure. Wait for it to come back up and let that be the verdict.
	reloading.say("info", t("core.selector.proxyDropped"));

	for (let attempt = 0; attempt < RELOAD_PROBE_ATTEMPTS; attempt++) {
		await Bun.sleep(RELOAD_PROBE_INTERVAL_MS);

		const health = await luna.call<unknown>("/health");

		if (health.ok) {
			reloading.complete(t("core.selector.reloaded"));

			return { wrote: true, proxyReloaded: true, placed };
		}
	}

	reloading.say("error", reload.error ?? t("core.selector.noAnswer"));

	return { wrote: true, proxyReloaded: false, placed };
}

/** Where an instance's selector item would be drawn, for callers that report it. */
export function selectorSlotLabel(entry: InstanceSelectorEntry | undefined): string {
	if (!entry) {
		return "not placed";
	}

	return `page ${entry.page}, slot ${entry.slot}`;
}
