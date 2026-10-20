// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Resource metadata and tags: who created what, when it last changed, and the
 * tags on it. One store across every resource type, the way AWS's tagging
 * service sits beside every other service, so a policy condition on
 * `luna:ResourceTag/team` reads the same record whether the resource is an
 * instance, a variable or a token.
 *
 * Records are written by the daemon's RPC dispatcher when an op that creates or
 * deletes a resource completes (the registry entry says which, `runOp` records
 * the actor the request carried), on first tagging, and by the boot sweep that
 * backfills what the stores already know. A resource nobody recorded still
 * describes: with nulls, so a policy about its creator matches nothing.
 *
 * `resources.json` is cluster state, primary-owned and mirrored like
 * `accounts.json`.
 */

import { existsSync } from "node:fs";

import type { IamResourceType } from "../shared/iam/actions";
import { isResourceType, parseResourceId, resourceId, tagFault } from "../shared/iam/resources";
import { t } from "../shared/i18n";
import { loadCluster, loadLock, notifySave, statePath } from "./config";

const RESOURCES_FILE = "resources.json";

export interface ResourceRecord {
	type: IamResourceType;
	name: string;
	createdAt: number | null;
	createdBy: string | null;
	updatedAt: number | null;
	updatedBy: string | null;
	tags: Record<string, string>;
}

export interface ResourceStore {
	resources: Record<string, ResourceRecord>;
}

/** A record as a listing or a detail screen sees it, with its id on it. */
export interface ResourceView extends ResourceRecord {
	id: string;
	/** True when the store holds no record and these are placeholders */
	unknown: boolean;
}

export interface ResourceFilter {
	type?: IamResourceType;
	/** Only resources carrying every one of these tags (a value of "" matches any value) */
	tags?: Record<string, string>;
	createdBy?: string;
}

function resourcesPath(): string {
	return statePath(RESOURCES_FILE);
}

/** Read the store, treating a missing file as empty. */
export async function loadResources(): Promise<ResourceStore> {
	if (!existsSync(resourcesPath())) {
		return { resources: {} };
	}

	const store: ResourceStore = await Bun.file(resourcesPath()).json();

	store.resources ??= {};

	return store;
}

/** Write the store back, id-sorted, and announce the save up the cluster link. */
export async function saveResources(store: ResourceStore): Promise<void> {
	const sorted: ResourceStore = { resources: {} };

	for (const id of Object.keys(store.resources).sort()) {
		sorted.resources[id] = store.resources[id]!;
	}

	await Bun.write(resourcesPath(), JSON.stringify(sorted, null, "\t") + "\n");

	await notifySave("resources", sorted);
}

function view(id: string, record: ResourceRecord | undefined): ResourceView {
	if (record) {
		return { id, ...record, tags: { ...record.tags }, unknown: false };
	}

	const parsed = parseResourceId(id);

	return {
		id,
		type: parsed?.type ?? "instance",
		name: parsed?.name ?? id,
		createdAt: null,
		createdBy: null,
		updatedAt: null,
		updatedBy: null,
		tags: {},
		unknown: true,
	};
}

function requireId(id: string): { type: IamResourceType; name: string } {
	const parsed = parseResourceId(id);

	if (!parsed) {
		throw new Error(t("core.resources.badId", { id }));
	}

	return parsed;
}

/** One resource's record, placeholders when nothing was recorded. */
export async function describeResource(id: string): Promise<ResourceView> {
	requireId(id);

	const store = await loadResources();

	return view(id, store.resources[id]);
}

/** Several resources' records in one read, for a listing that filters rows by tag or creator. */
export async function describeResources(ids: string[]): Promise<Record<string, ResourceView>> {
	const store = await loadResources();
	const out: Record<string, ResourceView> = {};

	for (const id of ids) {
		out[id] = view(id, store.resources[id]);
	}

	return out;
}

/** Every recorded resource matching the filter, name-sorted within type. */
export async function listResources(filter: ResourceFilter = {}): Promise<ResourceView[]> {
	const store = await loadResources();
	const out: ResourceView[] = [];

	for (const [id, record] of Object.entries(store.resources)) {
		if (filter.type && record.type !== filter.type) {
			continue;
		}

		if (filter.createdBy && record.createdBy !== filter.createdBy) {
			continue;
		}

		if (filter.tags) {
			const matches = Object.entries(filter.tags).every(([key, value]) => {
				const held = record.tags[key];

				if (held === undefined) {
					return false;
				}

				return value === "" || held === value;
			});

			if (!matches) {
				continue;
			}
		}

		out.push(view(id, record));
	}

	return out.sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));
}

/**
 * Note that a resource was created, by whom. Idempotent: an existing record
 * keeps its creator, because a second create of the same name (a re-adopt, a
 * re-install) is not a new resource to the policy that mentions its creator.
 */
export async function recordCreated(
	type: IamResourceType,
	name: string,
	actor: string | null,
	tags: Record<string, string> = {},
): Promise<ResourceView> {
	const id = resourceId(type, name);
	const store = await loadResources();
	const now = Date.now();
	const existing = store.resources[id];

	if (existing) {
		existing.updatedAt = now;
		existing.updatedBy = actor;

		for (const [key, value] of Object.entries(tags)) {
			existing.tags[key] = value;
		}
	} else {
		const fault = tagFault(tags);

		if (fault) {
			throw new Error(t(fault.key, fault.params));
		}

		store.resources[id] = {
			type,
			name,
			createdAt: now,
			createdBy: actor,
			updatedAt: now,
			updatedBy: actor,
			tags: { ...tags },
		};
	}

	await saveResources(store);

	return view(id, store.resources[id]);
}

/** Note that a resource changed, for the modified-by fields; a resource never recorded is left alone. */
export async function recordUpdated(type: IamResourceType, name: string, actor: string | null): Promise<void> {
	const id = resourceId(type, name);
	const store = await loadResources();
	const record = store.resources[id];

	if (!record) {
		return;
	}

	record.updatedAt = Date.now();
	record.updatedBy = actor;

	await saveResources(store);
}

/** Drop a resource's record; what a delete does. */
export async function forgetResource(type: IamResourceType, name: string): Promise<void> {
	const id = resourceId(type, name);
	const store = await loadResources();

	if (!store.resources[id]) {
		return;
	}

	delete store.resources[id];

	await saveResources(store);
}

/** Move a record to a new name; what a rename does, so the creator survives it. */
export async function renameResource(type: IamResourceType, from: string, to: string): Promise<void> {
	const fromId = resourceId(type, from);
	const toId = resourceId(type, to);
	const store = await loadResources();
	const record = store.resources[fromId];

	if (!record || fromId === toId) {
		return;
	}

	delete store.resources[fromId];
	store.resources[toId] = { ...record, name: to };

	await saveResources(store);
}

/**
 * Set tags on a resource (existing keys overwritten, others kept). A resource
 * with no record gains one, with no creator, so tags can be put on anything the
 * cluster had before this store existed.
 */
export async function tagResource(
	id: string,
	tags: Record<string, string>,
	actor: string | null,
): Promise<ResourceView> {
	const { type, name } = requireId(id);
	const store = await loadResources();
	const now = Date.now();
	const record = store.resources[id] ?? {
		type,
		name,
		createdAt: null,
		createdBy: null,
		updatedAt: null,
		updatedBy: null,
		tags: {},
	};

	const merged = { ...record.tags, ...tags };
	const fault = tagFault(merged);

	if (fault) {
		throw new Error(t(fault.key, fault.params));
	}

	record.tags = merged;
	record.updatedAt = now;
	record.updatedBy = actor;
	store.resources[id] = record;

	await saveResources(store);

	return view(id, record);
}

/** Remove tags by key; unknown keys are ignored. */
export async function untagResource(id: string, keys: string[], actor: string | null): Promise<ResourceView> {
	requireId(id);

	const store = await loadResources();
	const record = store.resources[id];

	if (!record) {
		return view(id, undefined);
	}

	for (const key of keys) {
		delete record.tags[key];
	}

	record.updatedAt = Date.now();
	record.updatedBy = actor;

	await saveResources(store);

	return view(id, record);
}

/** Every distinct tag key in the store with its values, for a filter's pick list. */
export async function tagVocabulary(): Promise<Record<string, string[]>> {
	const store = await loadResources();
	const out: Record<string, Set<string>> = {};

	for (const record of Object.values(store.resources)) {
		for (const [key, value] of Object.entries(record.tags)) {
			(out[key] ??= new Set()).add(value);
		}
	}

	return Object.fromEntries(
		Object.entries(out)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, values]) => [key, [...values].sort()]),
	);
}

/**
 * Backfill records for the resources the stores already know, keeping what each
 * store records about itself (an instance's `createdAt`, an account's
 * `createdBy`). Runs at daemon boot and from `luna resources sync`; a record
 * that exists is never touched, so a sweep after a delete does not resurrect
 * the deleted resource's metadata.
 */
export async function sweepResources(): Promise<{ added: number; total: number }> {
	const store = await loadResources();
	let added = 0;

	const add = (
		type: IamResourceType,
		name: string,
		facts: { createdAt?: number | null; createdBy?: string | null } = {},
	): void => {
		const id = resourceId(type, name);

		if (store.resources[id]) {
			return;
		}

		store.resources[id] = {
			type,
			name,
			createdAt: facts.createdAt ?? null,
			createdBy: facts.createdBy ?? null,
			updatedAt: null,
			updatedBy: null,
			tags: {},
		};

		added += 1;
	};

	const cfg = await loadCluster();

	// the proxy is kept apart from the backends in the registry, but it is an
	// instance like any other to a policy and to the screens
	if (cfg.proxy) {
		add("instance", "proxy");
	}

	for (const [name, instance] of Object.entries(cfg.instances)) {
		add("instance", name, { createdAt: (instance as { createdAt?: number }).createdAt ?? null });
	}

	for (const pool of cfg.portPools ?? []) {
		add("port-pool", pool.id);
	}

	const lock = await loadLock();

	for (const name of Object.keys(lock.plugins)) {
		add("plugin", name);
	}

	for (const name of Object.keys(lock.groups ?? {})) {
		add("addon-group", name);
	}

	const { loadPacksLock } = await import("./packslock");
	const packs = await loadPacksLock();

	for (const key of Object.keys(packs.resourcepacks)) {
		add("pack", key);
	}

	for (const name of Object.keys(packs.datapacks)) {
		add("datapack", name);
	}

	const { loadSchedules } = await import("./schedule");
	const schedules = await loadSchedules();

	for (const schedule of schedules.schedules) {
		add("schedule", schedule.id);
	}

	const { loadEnv } = await import("./environment");
	const env = await loadEnv();

	for (const name of Object.keys(env.variables)) {
		add("env", name);
	}

	const { loadAccounts } = await import("./accounts");
	const accounts = await loadAccounts();

	for (const account of accounts.accounts) {
		add("account", account.username, { createdAt: account.createdAt, createdBy: account.createdBy ?? null });
	}

	const { listMcpTokens, listKnowledge } = await import("./mcp");

	for (const token of await listMcpTokens()) {
		add("mcp-token", token.name, { createdAt: token.createdAt, createdBy: token.createdBy });
	}

	for (const item of await listKnowledge()) {
		add("knowledge", item.id, { createdAt: item.createdAt, createdBy: item.createdBy ?? null });
	}

	const { listPolicies, listGroups } = await import("./iam");

	for (const policy of await listPolicies()) {
		if (!policy.builtin) {
			add("policy", policy.name, { createdAt: policy.createdAt, createdBy: policy.createdBy });
		}
	}

	for (const group of await listGroups()) {
		add("group", group.name, { createdAt: group.createdAt, createdBy: group.createdBy });
	}

	const { listHostnames } = await import("./domains");

	for (const hostname of await listHostnames()) {
		add("domain", hostname.label, { createdAt: hostname.createdAt, createdBy: hostname.createdBy });
	}

	if (added > 0) {
		await saveResources(store);
	}

	return { added, total: Object.keys(store.resources).length };
}

/** Whether a string names a resource type; the route layer validates a `?type=` with it. */
export { isResourceType };
