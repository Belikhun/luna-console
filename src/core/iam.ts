// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Console authorization: managed policies, groups, what is attached to whom,
 * and the one function the console gate asks, `principalContext`, which gathers
 * every document that applies to an account so the shared evaluator can decide
 * a request on either side of the socket.
 *
 * The model is IAM's (docs/IAM.md). A policy is a YAML document in IAM's
 * grammar, parsed here (the daemon is the only place YAML is read) and stored
 * with its parsed form beside it so a request never re-parses. Built-in policies
 * are code; the store holds only their names where they are attached. An account
 * with no entry in the store has the defaults (`OwnerAccess`,
 * `SelfServiceAccess`), which is what makes a new account owner of what it
 * creates without anybody having to attach anything.
 *
 * Seeding: the first time the store is read on a console that already has
 * accounts, every one of them is made an administrator, so the release that
 * introduces authorization locks nobody out. The console then refuses to
 * detach, disable or delete the last administrator.
 *
 * `iam.json` is cluster state, primary-owned and mirrored.
 */

import { existsSync } from "node:fs";

import { t } from "../shared/i18n";
import { ADMINISTRATOR_POLICY, BUILTIN_POLICIES, DEFAULT_ATTACHMENTS, builtinPolicy } from "../shared/iam/builtin";
import {
	evaluate,
	normalizeDocument,
	policySourceKey,
	ROOT_VERDICT,
	type AccessRequest,
	type AttachedDocument,
	type PolicyDocument,
	type PolicyIssue,
	type PrincipalContext,
	type Verdict,
} from "../shared/iam/grammar";
import { iamAction } from "../shared/iam/actions";
import { parseResourceId, resourceId } from "../shared/iam/resources";
import { loadAccounts, ROOT_ACTOR, type AccountStore, type ConsoleAccount } from "./accounts";
import { notifySave, statePath } from "./config";
import { describeResource, describeResources, forgetResource, recordCreated, renameResource } from "./resources";
import { newId } from "./secrets";

const IAM_FILE = "iam.json";

/** Policy and group names: IAM's own rule, minus the characters a path would choke on. */
export const IAM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9+=,.@_-]{0,127}$/;

/** Audit entries kept, oldest dropped first. */
export const MAX_IAM_AUDIT = 2_000;

/** A document's YAML may not exceed this; a policy is a page, not a program. */
export const MAX_POLICY_BYTES = 64 * 1024;

export interface InlinePolicy {
	yaml: string;
	document: PolicyDocument;
	updatedAt: number;
	updatedBy?: string;
}

export interface ManagedPolicy {
	id: string;
	name: string;
	description?: string;
	yaml: string;
	document: PolicyDocument;
	createdAt: number;
	createdBy?: string;
	updatedAt: number;
	updatedBy?: string;
}

export interface IamGroup {
	id: string;
	name: string;
	description?: string;
	/** Account ids, not usernames: a rename must not drop a membership */
	members: string[];
	/** Managed and built-in policy names */
	policies: string[];
	inline: Record<string, InlinePolicy>;
	createdAt: number;
	createdBy?: string;
	updatedAt: number;
	updatedBy?: string;
}

export interface PrincipalEntry {
	policies: string[];
	inline: Record<string, InlinePolicy>;
}

export type IamAuditAction =
	| "policy.create"
	| "policy.update"
	| "policy.delete"
	| "group.create"
	| "group.update"
	| "group.delete"
	| "group.members.add"
	| "group.members.remove"
	| "attach"
	| "detach"
	| "inline.put"
	| "inline.delete"
	| "seed";

export interface IamAuditEntry {
	t: number;
	action: IamAuditAction;
	actor?: string;
	/** The policy, group or account the action was about */
	target?: string;
	detail?: string;
}

export interface IamStore {
	/** Set once the existing accounts were made administrators */
	seeded?: boolean;
	policies: ManagedPolicy[];
	groups: IamGroup[];
	/** Account id → what is attached to it directly */
	principals: Record<string, PrincipalEntry>;
	audit: IamAuditEntry[];
}

/** A policy as every listing sees it, built-ins included. */
export interface PolicySummary {
	id: string | null;
	name: string;
	description: string;
	builtin: boolean;
	yaml: string;
	document: PolicyDocument;
	createdAt: number | null;
	createdBy: string | null;
	updatedAt: number | null;
	updatedBy: string | null;
	/** Where it is attached: usernames and group names */
	attachedTo: { accounts: string[]; groups: string[] };
}

export interface InlineView {
	name: string;
	yaml: string;
	document: PolicyDocument;
	updatedAt: number;
	updatedBy: string | null;
}

export interface GroupMember {
	id: string;
	username: string;
}

export interface GroupSummary {
	id: string;
	name: string;
	description: string;
	members: GroupMember[];
	policies: string[];
	inline: InlineView[];
	createdAt: number;
	createdBy: string | null;
	updatedAt: number;
	updatedBy: string | null;
}

/** Everything attached to one account, as its Permissions tab shows it. */
export interface AccountPermissions {
	accountId: string;
	username: string;
	groups: Array<{ id: string; name: string; policies: string[]; inline: string[] }>;
	policies: string[];
	inline: InlineView[];
	tags: Record<string, string>;
	administrator: boolean;
	/** Every document the evaluator reads for this account, in evaluation order */
	effective: AttachedDocument[];
}

/** What a policy, inline or managed, is attached to. */
export type AttachTarget = { account: string } | { group: string };

/** What a simulation may change about the request or the principal, for testing a policy before it is real. */
export interface SimulationOptions {
	/**
	 * The attachments to evaluate, by `policySourceKey` or by plain policy name;
	 * every attachment when absent. Leaving one out answers "what if this were
	 * detached".
	 */
	policies?: string[];
	/** Stand-in tags for the resource, replacing its recorded ones */
	resourceTags?: Record<string, string>;
	/** Stand-in creator for the resource, replacing the recorded one */
	resourceCreator?: string | null;
	/** Tags the request asks to set, for `luna:RequestTag/*` and `luna:TagKeys` */
	requestTags?: Record<string, string>;
}

/** How many inline policies exist, per kind of holder. */
export interface InlinePolicyCounts {
	accounts: number;
	groups: number;
}

export interface SimulationResult {
	verdict: Verdict;
	request: AccessRequest;
	/** The resource's record, when the request named one */
	resource: { createdBy: string | null; tags: Record<string, string> } | null;
}

function iamPath(): string {
	return statePath(IAM_FILE);
}

async function readStore(): Promise<IamStore> {
	if (!existsSync(iamPath())) {
		return { policies: [], groups: [], principals: {}, audit: [] };
	}

	const store: IamStore = await Bun.file(iamPath()).json();

	store.policies ??= [];
	store.groups ??= [];
	store.principals ??= {};
	store.audit ??= [];

	for (const group of store.groups) {
		group.members ??= [];
		group.policies ??= [];
		group.inline ??= {};
	}

	for (const entry of Object.values(store.principals)) {
		entry.policies ??= [];
		entry.inline ??= {};
	}

	return store;
}

/** Write the store back and announce the save up the cluster link. */
export async function saveIam(store: IamStore): Promise<void> {
	const sorted: IamStore = {
		seeded: store.seeded,
		policies: [...store.policies].sort((left, right) => left.name.localeCompare(right.name)),
		groups: [...store.groups].sort((left, right) => left.name.localeCompare(right.name)),
		principals: store.principals,
		audit: store.audit.slice(-MAX_IAM_AUDIT),
	};

	await Bun.write(iamPath(), JSON.stringify(sorted, null, "\t") + "\n");

	await notifySave("iam", sorted);
}

function recordAudit(store: IamStore, entry: Omit<IamAuditEntry, "t">): void {
	store.audit.push({ t: Date.now(), ...entry });

	if (store.audit.length > MAX_IAM_AUDIT) {
		store.audit.splice(0, store.audit.length - MAX_IAM_AUDIT);
	}
}

/**
 * Read the store, seeding it on the first read that finds accounts: every
 * account that predates authorization becomes an administrator. A console with
 * no accounts yet stays unseeded, so the bootstrap account is caught by the read
 * that follows its creation.
 */
export async function loadIam(): Promise<IamStore> {
	const store = await readStore();

	if (store.seeded) {
		return store;
	}

	const accounts = await loadAccounts();

	if (accounts.accounts.length === 0) {
		return store;
	}

	for (const account of accounts.accounts) {
		const entry = principalEntry(store, account.id);

		if (!entry.policies.includes(ADMINISTRATOR_POLICY)) {
			entry.policies.push(ADMINISTRATOR_POLICY);
		}

		store.principals[account.id] = entry;
	}

	store.seeded = true;

	recordAudit(store, {
		action: "seed",
		detail: t("core.iam.seeded", { count: accounts.accounts.length }),
	});

	await saveIam(store);

	return store;
}

/** The daemon calls this at boot so the seeding is not left to the first request. */
export async function ensureIamSeeded(): Promise<void> {
	await loadIam();
}

/** An account's direct attachments, the defaults when the store has no entry. */
function principalEntry(store: IamStore, accountId: string): PrincipalEntry {
	const existing = store.principals[accountId];

	if (existing) {
		return existing;
	}

	return { policies: [...DEFAULT_ATTACHMENTS], inline: {} };
}

/**
 * Parse a policy written in YAML into a document, reporting every fault. A YAML
 * syntax error is one issue at the root; the grammar's own faults are located.
 */
export function parsePolicyYaml(yaml: string): { document?: PolicyDocument; issues: PolicyIssue[] } {
	if (yaml.length > MAX_POLICY_BYTES) {
		return { issues: [{ path: "", message: t("core.iam.policyTooLarge", { max: MAX_POLICY_BYTES }) }] };
	}

	let raw: unknown;

	try {
		raw = Bun.YAML.parse(yaml);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);

		return { issues: [{ path: "", message: t("core.iam.yamlError", { message }) }] };
	}

	if (raw === null || raw === undefined) {
		return { issues: [{ path: "", message: t("core.iam.grammar.notAMap") }] };
	}

	return normalizeDocument(raw);
}

/** What validating a document answers; `document` is the normalized form, present only when it parses. */
export interface PolicyValidationResult {
	ok: boolean;
	issues: PolicyIssue[];
	statements: number;
	document?: PolicyDocument;
}

/**
 * Validate without saving; what the editor calls as the operator types. The
 * normalized document comes back with a valid answer, which is how the
 * console's visual editor reads YAML without parsing any itself.
 */
export async function validatePolicyYaml(yaml: string): Promise<PolicyValidationResult> {
	const parsed = parsePolicyYaml(yaml);

	return {
		ok: parsed.document !== undefined,
		issues: parsed.issues,
		statements: parsed.document?.Statement.length ?? 0,
		document: parsed.document,
	};
}

function requireDocument(yaml: string): PolicyDocument {
	const parsed = parsePolicyYaml(yaml);

	if (!parsed.document) {
		const first = parsed.issues[0];
		const where = first?.path ? `${first.path}: ` : "";

		throw new Error(t("core.iam.invalidPolicy", { count: parsed.issues.length, first: `${where}${first?.message ?? ""}` }));
	}

	return parsed.document;
}

function assertName(name: string): void {
	if (!IAM_NAME_PATTERN.test(name)) {
		throw new Error(t("core.iam.badName", { name }));
	}
}

function findPolicy(store: IamStore, name: string): ManagedPolicy | undefined {
	const wanted = name.toLowerCase();

	return store.policies.find((policy) => policy.id === name || policy.name.toLowerCase() === wanted);
}

function findGroup(store: IamStore, name: string): IamGroup | undefined {
	const wanted = name.toLowerCase();

	return store.groups.find((group) => group.id === name || group.name.toLowerCase() === wanted);
}

function requireGroup(store: IamStore, name: string): IamGroup {
	const group = findGroup(store, name);

	if (!group) {
		throw new Error(t("core.iam.unknownGroup", { name }));
	}

	return group;
}

/** Whether a policy name is attachable: a built-in, or a managed policy in the store. */
function policyExists(store: IamStore, name: string): boolean {
	return builtinPolicy(name) !== undefined || findPolicy(store, name) !== undefined;
}

/** The canonical spelling of a policy name, built-in or managed. */
function canonicalPolicyName(store: IamStore, name: string): string {
	const builtin = BUILTIN_POLICIES.find((policy) => policy.name.toLowerCase() === name.toLowerCase());

	if (builtin) {
		return builtin.name;
	}

	return findPolicy(store, name)?.name ?? name;
}

function accountByIdOrName(accounts: AccountStore, idOrName: string): ConsoleAccount {
	const wanted = idOrName.toLowerCase();
	const account = accounts.accounts.find(
		(entry) => entry.id === idOrName || entry.username.toLowerCase() === wanted,
	);

	if (!account) {
		throw new Error(t("core.accounts.unknown", { name: idOrName }));
	}

	return account;
}

function inlineView(name: string, inline: InlinePolicy): InlineView {
	return {
		name,
		yaml: inline.yaml,
		document: inline.document,
		updatedAt: inline.updatedAt,
		updatedBy: inline.updatedBy ?? null,
	};
}

function attachmentsOf(store: IamStore, accounts: AccountStore, policyName: string): { accounts: string[]; groups: string[] } {
	const wanted = policyName.toLowerCase();
	const holders: string[] = [];

	for (const account of accounts.accounts) {
		const entry = principalEntry(store, account.id);

		if (entry.policies.some((name) => name.toLowerCase() === wanted)) {
			holders.push(account.username);
		}
	}

	const groups = store.groups
		.filter((group) => group.policies.some((name) => name.toLowerCase() === wanted))
		.map((group) => group.name);

	return { accounts: holders.sort(), groups: groups.sort() };
}

function summarizePolicy(store: IamStore, accounts: AccountStore, policy: ManagedPolicy): PolicySummary {
	return {
		id: policy.id,
		name: policy.name,
		description: policy.description ?? "",
		builtin: false,
		yaml: policy.yaml,
		document: policy.document,
		createdAt: policy.createdAt,
		createdBy: policy.createdBy ?? null,
		updatedAt: policy.updatedAt,
		updatedBy: policy.updatedBy ?? null,
		attachedTo: attachmentsOf(store, accounts, policy.name),
	};
}

function summarizeBuiltin(store: IamStore, accounts: AccountStore, name: string): PolicySummary {
	const builtin = builtinPolicy(name)!;

	return {
		id: null,
		name: builtin.name,
		description: t(builtin.descriptionKey),
		builtin: true,
		yaml: builtin.yaml,
		document: builtin.document,
		createdAt: null,
		createdBy: null,
		updatedAt: null,
		updatedBy: null,
		attachedTo: attachmentsOf(store, accounts, builtin.name),
	};
}

function summarizeGroup(group: IamGroup, accounts: AccountStore): GroupSummary {
	const members: GroupMember[] = [];

	for (const id of group.members) {
		const account = accounts.accounts.find((entry) => entry.id === id);

		if (account) {
			members.push({ id, username: account.username });
		}
	}

	return {
		id: group.id,
		name: group.name,
		description: group.description ?? "",
		members: members.sort((left, right) => left.username.localeCompare(right.username)),
		policies: [...group.policies],
		inline: Object.entries(group.inline).map(([name, inline]) => inlineView(name, inline)),
		createdAt: group.createdAt,
		createdBy: group.createdBy ?? null,
		updatedAt: group.updatedAt,
		updatedBy: group.updatedBy ?? null,
	};
}

/** Every policy, built-ins first, then the managed ones by name. */
export async function listPolicies(): Promise<PolicySummary[]> {
	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);

	return [
		...BUILTIN_POLICIES.map((builtin) => summarizeBuiltin(store, accounts, builtin.name)),
		...store.policies.map((policy) => summarizePolicy(store, accounts, policy)),
	];
}

/** One policy by name or id, built-in or managed. */
export async function getPolicy(name: string): Promise<PolicySummary | undefined> {
	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);
	const builtin = BUILTIN_POLICIES.find((policy) => policy.name.toLowerCase() === name.toLowerCase());

	if (builtin) {
		return summarizeBuiltin(store, accounts, builtin.name);
	}

	const policy = findPolicy(store, name);

	return policy ? summarizePolicy(store, accounts, policy) : undefined;
}

export interface CreatePolicyInput {
	name: string;
	description?: string;
	yaml: string;
}

/** Create a managed policy from its YAML; the document must parse cleanly. */
export async function createPolicy(input: CreatePolicyInput, actor?: string): Promise<PolicySummary> {
	const name = input.name.trim();

	assertName(name);

	const store = await loadIam();

	if (policyExists(store, name)) {
		throw new Error(t("core.iam.policyTaken", { name }));
	}

	const document = requireDocument(input.yaml);
	const now = Date.now();

	const policy: ManagedPolicy = {
		id: newId("pol"),
		name,
		description: input.description?.trim() || undefined,
		yaml: input.yaml,
		document,
		createdAt: now,
		createdBy: actor,
		updatedAt: now,
		updatedBy: actor,
	};

	store.policies.push(policy);

	recordAudit(store, { action: "policy.create", actor, target: name });

	await saveIam(store);
	await recordCreated("policy", name, actor ?? null);

	return summarizePolicy(store, await loadAccounts(), policy);
}

export interface PolicyPatch {
	name?: string;
	description?: string;
	yaml?: string;
}

/** Change a managed policy's name, description or document. Built-ins are refused. */
export async function updatePolicy(idOrName: string, patch: PolicyPatch, actor?: string): Promise<PolicySummary> {
	if (builtinPolicy(idOrName)) {
		throw new Error(t("core.iam.builtinReadOnly", { name: idOrName }));
	}

	const store = await loadIam();
	const policy = findPolicy(store, idOrName);

	if (!policy) {
		throw new Error(t("core.iam.unknownPolicy", { name: idOrName }));
	}

	const changed: string[] = [];

	if (patch.name !== undefined && patch.name.trim() !== policy.name) {
		const name = patch.name.trim();

		assertName(name);

		if (policyExists(store, name)) {
			throw new Error(t("core.iam.policyTaken", { name }));
		}

		// attachments hold the name, so a rename follows it everywhere
		for (const entry of Object.values(store.principals)) {
			entry.policies = entry.policies.map((held) => (held === policy.name ? name : held));
		}

		for (const group of store.groups) {
			group.policies = group.policies.map((held) => (held === policy.name ? name : held));
		}

		changed.push(`name ${policy.name} → ${name}`);

		await renameResource("policy", policy.name, name);

		policy.name = name;
	}

	if (patch.description !== undefined && (patch.description.trim() || undefined) !== policy.description) {
		policy.description = patch.description.trim() || undefined;
		changed.push("description");
	}

	if (patch.yaml !== undefined && patch.yaml !== policy.yaml) {
		policy.document = requireDocument(patch.yaml);
		policy.yaml = patch.yaml;
		changed.push("document");
	}

	if (changed.length === 0) {
		return summarizePolicy(store, await loadAccounts(), policy);
	}

	policy.updatedAt = Date.now();
	policy.updatedBy = actor;

	recordAudit(store, { action: "policy.update", actor, target: policy.name, detail: changed.join(", ") });

	await saveIam(store);

	return summarizePolicy(store, await loadAccounts(), policy);
}

/** Delete a managed policy. Refused while anything is attached to it, as IAM does. */
export async function deletePolicy(idOrName: string, actor?: string): Promise<void> {
	if (builtinPolicy(idOrName)) {
		throw new Error(t("core.iam.builtinReadOnly", { name: idOrName }));
	}

	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);
	const policy = findPolicy(store, idOrName);

	if (!policy) {
		throw new Error(t("core.iam.unknownPolicy", { name: idOrName }));
	}

	const attached = attachmentsOf(store, accounts, policy.name);

	if (attached.accounts.length > 0 || attached.groups.length > 0) {
		throw new Error(
			t("core.iam.policyAttached", {
				name: policy.name,
				holders: [...attached.accounts, ...attached.groups.map((name) => `group ${name}`)].join(", "),
			}),
		);
	}

	store.policies = store.policies.filter((entry) => entry.id !== policy.id);

	recordAudit(store, { action: "policy.delete", actor, target: policy.name });

	await saveIam(store);
	await forgetResource("policy", policy.name);
}

/** Every group, by name. */
export async function listGroups(): Promise<GroupSummary[]> {
	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);

	return store.groups.map((group) => summarizeGroup(group, accounts));
}

/** One group by name or id. */
export async function getGroup(name: string): Promise<GroupSummary | undefined> {
	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);
	const group = findGroup(store, name);

	return group ? summarizeGroup(group, accounts) : undefined;
}

export interface CreateGroupInput {
	name: string;
	description?: string;
	policies?: string[];
	/** Account ids or usernames */
	members?: string[];
}

/** Create a group, optionally with policies and members from the start. */
export async function createGroup(input: CreateGroupInput, actor?: string): Promise<GroupSummary> {
	const name = input.name.trim();

	assertName(name);

	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);

	if (findGroup(store, name)) {
		throw new Error(t("core.iam.groupTaken", { name }));
	}

	const policies: string[] = [];

	for (const policyName of input.policies ?? []) {
		if (!policyExists(store, policyName)) {
			throw new Error(t("core.iam.unknownPolicy", { name: policyName }));
		}

		policies.push(canonicalPolicyName(store, policyName));
	}

	const members = (input.members ?? []).map((member) => accountByIdOrName(accounts, member).id);
	const now = Date.now();

	const group: IamGroup = {
		id: newId("grp"),
		name,
		description: input.description?.trim() || undefined,
		members: [...new Set(members)],
		policies: [...new Set(policies)],
		inline: {},
		createdAt: now,
		createdBy: actor,
		updatedAt: now,
		updatedBy: actor,
	};

	store.groups.push(group);

	recordAudit(store, { action: "group.create", actor, target: name });

	await saveIam(store);
	await recordCreated("group", name, actor ?? null);

	return summarizeGroup(group, accounts);
}

export interface GroupPatch {
	name?: string;
	description?: string;
}

/** Rename or describe a group. */
export async function updateGroup(idOrName: string, patch: GroupPatch, actor?: string): Promise<GroupSummary> {
	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);
	const group = requireGroup(store, idOrName);
	const changed: string[] = [];

	if (patch.name !== undefined && patch.name.trim() !== group.name) {
		const name = patch.name.trim();

		assertName(name);

		if (findGroup(store, name)) {
			throw new Error(t("core.iam.groupTaken", { name }));
		}

		changed.push(`name ${group.name} → ${name}`);

		await renameResource("group", group.name, name);

		group.name = name;
	}

	if (patch.description !== undefined && (patch.description.trim() || undefined) !== group.description) {
		group.description = patch.description.trim() || undefined;
		changed.push("description");
	}

	if (changed.length === 0) {
		return summarizeGroup(group, accounts);
	}

	group.updatedAt = Date.now();
	group.updatedBy = actor;

	recordAudit(store, { action: "group.update", actor, target: group.name, detail: changed.join(", ") });

	await saveIam(store);

	return summarizeGroup(group, accounts);
}

/** Delete a group; its members simply lose what it granted. */
export async function deleteGroup(idOrName: string, actor?: string): Promise<void> {
	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);
	const group = requireGroup(store, idOrName);

	await assertAdministratorsRemain(store, accounts, (draft) => {
		draft.groups = draft.groups.filter((entry) => entry.id !== group.id);
	});

	store.groups = store.groups.filter((entry) => entry.id !== group.id);

	recordAudit(store, { action: "group.delete", actor, target: group.name });

	await saveIam(store);
	await forgetResource("group", group.name);
}

/** Add accounts (ids or usernames) to a group; ones already in it are ignored. */
export async function addGroupMembers(idOrName: string, members: string[], actor?: string): Promise<GroupSummary> {
	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);
	const group = requireGroup(store, idOrName);
	const added: string[] = [];

	for (const member of members) {
		const account = accountByIdOrName(accounts, member);

		if (!group.members.includes(account.id)) {
			group.members.push(account.id);
			added.push(account.username);
		}
	}

	if (added.length === 0) {
		return summarizeGroup(group, accounts);
	}

	group.updatedAt = Date.now();
	group.updatedBy = actor;

	recordAudit(store, { action: "group.members.add", actor, target: group.name, detail: added.join(", ") });

	await saveIam(store);

	return summarizeGroup(group, accounts);
}

/** Remove accounts from a group, unless that would leave the console without an administrator. */
export async function removeGroupMembers(idOrName: string, members: string[], actor?: string): Promise<GroupSummary> {
	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);
	const group = requireGroup(store, idOrName);
	const leaving = new Set(members.map((member) => accountByIdOrName(accounts, member).id));
	const removed = group.members.filter((id) => leaving.has(id));

	if (removed.length === 0) {
		return summarizeGroup(group, accounts);
	}

	await assertAdministratorsRemain(store, accounts, (draft) => {
		const target = draft.groups.find((entry) => entry.id === group.id)!;

		target.members = target.members.filter((id) => !leaving.has(id));
	});

	group.members = group.members.filter((id) => !leaving.has(id));
	group.updatedAt = Date.now();
	group.updatedBy = actor;

	recordAudit(store, {
		action: "group.members.remove",
		actor,
		target: group.name,
		detail: removed.map((id) => accounts.accounts.find((entry) => entry.id === id)?.username ?? id).join(", "),
	});

	await saveIam(store);

	return summarizeGroup(group, accounts);
}

function targetLabel(target: AttachTarget, accounts: AccountStore): string {
	if ("account" in target) {
		return accountByIdOrName(accounts, target.account).username;
	}

	return `group ${target.group}`;
}

/** Attach a managed or built-in policy to an account or a group. */
export async function attachPolicy(target: AttachTarget, policyName: string, actor?: string): Promise<void> {
	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);

	if (!policyExists(store, policyName)) {
		throw new Error(t("core.iam.unknownPolicy", { name: policyName }));
	}

	const name = canonicalPolicyName(store, policyName);
	let list: string[];

	if ("account" in target) {
		const account = accountByIdOrName(accounts, target.account);
		const entry = principalEntry(store, account.id);

		store.principals[account.id] = entry;
		list = entry.policies;
	} else {
		const group = requireGroup(store, target.group);

		group.updatedAt = Date.now();
		group.updatedBy = actor;
		list = group.policies;
	}

	if (list.includes(name)) {
		return;
	}

	list.push(name);

	recordAudit(store, { action: "attach", actor, target: targetLabel(target, accounts), detail: name });

	await saveIam(store);
}

/** Detach a policy from an account or a group, unless it was the last administrator's. */
export async function detachPolicy(target: AttachTarget, policyName: string, actor?: string): Promise<void> {
	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);
	const wanted = policyName.toLowerCase();
	const without = (list: string[]): string[] => list.filter((name) => name.toLowerCase() !== wanted);

	if ("account" in target) {
		const account = accountByIdOrName(accounts, target.account);
		const entry = principalEntry(store, account.id);

		if (entry.policies.length === without(entry.policies).length) {
			return;
		}

		await assertAdministratorsRemain(store, accounts, (draft) => {
			draft.principals[account.id] = { ...entry, policies: without(entry.policies) };
		});

		store.principals[account.id] = { ...entry, policies: without(entry.policies) };
	} else {
		const group = requireGroup(store, target.group);

		if (group.policies.length === without(group.policies).length) {
			return;
		}

		await assertAdministratorsRemain(store, accounts, (draft) => {
			const draftGroup = draft.groups.find((entry) => entry.id === group.id)!;

			draftGroup.policies = without(draftGroup.policies);
		});

		group.policies = without(group.policies);
		group.updatedAt = Date.now();
		group.updatedBy = actor;
	}

	recordAudit(store, { action: "detach", actor, target: targetLabel(target, accounts), detail: policyName });

	await saveIam(store);
}

/** Put an inline policy on an account or a group, replacing one of the same name. */
export async function putInlinePolicy(target: AttachTarget, name: string, yaml: string, actor?: string): Promise<InlineView> {
	const trimmed = name.trim();

	assertName(trimmed);

	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);
	const document = requireDocument(yaml);
	const inline: InlinePolicy = { yaml, document, updatedAt: Date.now(), updatedBy: actor };

	if ("account" in target) {
		const account = accountByIdOrName(accounts, target.account);
		const entry = principalEntry(store, account.id);

		entry.inline[trimmed] = inline;
		store.principals[account.id] = entry;
	} else {
		const group = requireGroup(store, target.group);

		group.inline[trimmed] = inline;
		group.updatedAt = Date.now();
		group.updatedBy = actor;
	}

	recordAudit(store, { action: "inline.put", actor, target: targetLabel(target, accounts), detail: trimmed });

	await saveIam(store);

	return inlineView(trimmed, inline);
}

/** Remove an inline policy from an account or a group. */
export async function deleteInlinePolicy(target: AttachTarget, name: string, actor?: string): Promise<void> {
	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);

	if ("account" in target) {
		const account = accountByIdOrName(accounts, target.account);
		const entry = principalEntry(store, account.id);

		if (!entry.inline[name]) {
			throw new Error(t("core.iam.unknownInline", { name }));
		}

		delete entry.inline[name];
		store.principals[account.id] = entry;
	} else {
		const group = requireGroup(store, target.group);

		if (!group.inline[name]) {
			throw new Error(t("core.iam.unknownInline", { name }));
		}

		delete group.inline[name];
		group.updatedAt = Date.now();
		group.updatedBy = actor;
	}

	recordAudit(store, { action: "inline.delete", actor, target: targetLabel(target, accounts), detail: name });

	await saveIam(store);
}

/** The documents a policy name resolves to: a built-in's, or a managed policy's; nothing for a name that was deleted. */
function documentOf(store: IamStore, name: string): { document: PolicyDocument; kind: "builtin" | "managed"; name: string } | null {
	const builtin = builtinPolicy(name);

	if (builtin) {
		return { document: builtin.document, kind: "builtin", name: builtin.name };
	}

	const managed = findPolicy(store, name);

	if (managed) {
		return { document: managed.document, kind: "managed", name: managed.name };
	}

	return null;
}

/** Every document that applies to an account, in evaluation order. */
function effectiveDocuments(store: IamStore, account: ConsoleAccount): AttachedDocument[] {
	const out: AttachedDocument[] = [];
	const entry = principalEntry(store, account.id);

	for (const name of entry.policies) {
		const resolved = documentOf(store, name);

		if (resolved) {
			out.push({ source: { kind: resolved.kind, name: resolved.name }, document: resolved.document });
		}
	}

	for (const [name, inline] of Object.entries(entry.inline)) {
		out.push({ source: { kind: "inline", name }, document: inline.document });
	}

	for (const group of store.groups) {
		if (!group.members.includes(account.id)) {
			continue;
		}

		for (const name of group.policies) {
			const resolved = documentOf(store, name);

			if (resolved) {
				out.push({
					source: { kind: resolved.kind, name: resolved.name, group: group.name },
					document: resolved.document,
				});
			}
		}

		for (const [name, inline] of Object.entries(group.inline)) {
			out.push({ source: { kind: "inline", name, group: group.name }, document: inline.document });
		}
	}

	return out;
}

/** Whether the administrator policy reaches an account, directly or through a group. */
function isAdministrator(store: IamStore, account: ConsoleAccount): boolean {
	return effectiveDocuments(store, account).some(
		(attached) => attached.source.kind === "builtin" && attached.source.name === ADMINISTRATOR_POLICY,
	);
}

/** Enabled accounts the administrator policy reaches. */
function administrators(store: IamStore, accounts: AccountStore): ConsoleAccount[] {
	return accounts.accounts.filter((account) => account.enabled && isAdministrator(store, account));
}

/**
 * Refuse a change that would leave the console without an enabled
 * administrator. `apply` makes the change on a deep copy of the store, which is
 * then counted; the caller applies the same change for real only if this
 * returns.
 */
async function assertAdministratorsRemain(
	store: IamStore,
	accounts: AccountStore,
	apply: (draft: IamStore) => void,
	accountsAfter: AccountStore = accounts,
): Promise<void> {
	if (administrators(store, accounts).length === 0) {
		// nothing to protect: a console with no administrator yet (or one that lost
		// its last through a hand edit) must still be editable
		return;
	}

	const draft: IamStore = JSON.parse(JSON.stringify(store));

	apply(draft);

	if (administrators(draft, accountsAfter).length === 0) {
		throw new Error(t("core.iam.lastAdministrator"));
	}
}

/**
 * Whether disabling or deleting an account would leave no administrator; what
 * `accounts.ts` asks before it does either. Never throws for a non-administrator.
 */
export async function assertNotLastAdministrator(accountId: string): Promise<void> {
	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);
	const account = accounts.accounts.find((entry) => entry.id === accountId);

	if (!account || !account.enabled || !isAdministrator(store, account)) {
		return;
	}

	const remaining: AccountStore = {
		accounts: accounts.accounts.filter((entry) => entry.id !== accountId),
		audit: [],
	};

	await assertAdministratorsRemain(store, accounts, () => {}, remaining);
}

/** Drop an account's attachments and memberships; what deleting the account does. */
export async function forgetPrincipal(accountId: string): Promise<void> {
	const store = await readStore();
	let changed = false;

	if (store.principals[accountId]) {
		delete store.principals[accountId];
		changed = true;
	}

	for (const group of store.groups) {
		if (group.members.includes(accountId)) {
			group.members = group.members.filter((id) => id !== accountId);
			changed = true;
		}
	}

	if (changed) {
		await saveIam(store);
	}
}

/**
 * Everything the evaluator needs for one account: its documents in order and the
 * tags on its own resource record. The console gate builds this once per
 * request and the browser receives it as is.
 */
export async function principalContext(accountIdOrName: string): Promise<PrincipalContext | null> {
	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);
	const wanted = accountIdOrName.toLowerCase();
	const account = accounts.accounts.find(
		(entry) => entry.id === accountIdOrName || entry.username.toLowerCase() === wanted,
	);

	if (!account) {
		return null;
	}

	const record = await describeResource(resourceId("account", account.username));

	return {
		accountId: account.id,
		username: account.username,
		tags: record.tags,
		policies: effectiveDocuments(store, account),
		groups: store.groups.filter((group) => group.members.includes(account.id)).map((group) => group.name),
	};
}

/** An account's Permissions tab: groups, attachments, inline documents, tags and the effective set. */
export async function accountPermissions(accountIdOrName: string): Promise<AccountPermissions> {
	const [store, accounts] = await Promise.all([loadIam(), loadAccounts()]);
	const account = accountByIdOrName(accounts, accountIdOrName);
	const entry = principalEntry(store, account.id);
	const record = await describeResource(resourceId("account", account.username));

	return {
		accountId: account.id,
		username: account.username,
		groups: store.groups
			.filter((group) => group.members.includes(account.id))
			.map((group) => ({
				id: group.id,
				name: group.name,
				policies: [...group.policies],
				inline: Object.keys(group.inline),
			})),
		policies: [...entry.policies],
		inline: Object.entries(entry.inline).map(([name, inline]) => inlineView(name, inline)),
		tags: record.tags,
		administrator: isAdministrator(store, account),
		effective: effectiveDocuments(store, account),
	};
}

/**
 * Decide one request for one account, reading the resource's record for the
 * condition keys. `root` is allowed without evaluation. The web gate and the
 * simulator both call this; the simulator just shows its answer.
 */
export async function authorize(
	accountIdOrName: string,
	action: string,
	resource: string | null,
	requestTags?: Record<string, string>,
): Promise<SimulationResult> {
	const spec = iamAction(action);
	const parsed = resource ? parseResourceId(resource) : null;
	const record = resource ? await describeResource(resource) : null;

	const request: AccessRequest = {
		action: spec?.name ?? action,
		resource,
		resourceType: parsed?.type ?? spec?.resourceType ?? null,
		resourceTags: record?.tags ?? {},
		resourceCreator: record?.createdBy ?? null,
		requestTags,
	};

	if (accountIdOrName === ROOT_ACTOR) {
		return { verdict: ROOT_VERDICT, request, resource: record ? { createdBy: record.createdBy, tags: record.tags } : null };
	}

	const principal = await principalContext(accountIdOrName);

	if (!principal) {
		return { verdict: { allowed: false, reason: "implicit-deny" }, request, resource: null };
	}

	return {
		verdict: evaluate(principal, request),
		request,
		resource: record ? { createdBy: record.createdBy, tags: record.tags } : null,
	};
}

/**
 * The policy simulator's question: decide one request for one account with
 * only some of its attachments in play, and with the resource's facts or the
 * request's tags replaced. Nothing is stored and nothing is enforced; the
 * answer is what the gate would say if the account looked like this.
 */
export async function simulatePrincipal(
	accountIdOrName: string,
	action: string,
	resource: string | null,
	options: SimulationOptions = {},
): Promise<SimulationResult> {
	const spec = iamAction(action);
	const parsed = resource ? parseResourceId(resource) : null;
	const record = resource ? await describeResource(resource) : null;

	const request: AccessRequest = {
		action: spec?.name ?? action,
		resource,
		resourceType: parsed?.type ?? spec?.resourceType ?? null,
		resourceTags: options.resourceTags ?? record?.tags ?? {},
		resourceCreator: options.resourceCreator !== undefined
			? options.resourceCreator
			: (record?.createdBy ?? null),
		requestTags: options.requestTags,
	};

	const facts = record
		? { createdBy: record.createdBy, tags: record.tags }
		: null;

	if (accountIdOrName === ROOT_ACTOR) {
		return { verdict: ROOT_VERDICT, request, resource: facts };
	}

	const principal = await principalContext(accountIdOrName);

	if (!principal) {
		return { verdict: { allowed: false, reason: "implicit-deny" }, request, resource: null };
	}

	if (options.policies) {
		const wanted = new Set(options.policies);

		principal.policies = principal.policies.filter(
			(attached) => wanted.has(policySourceKey(attached.source)) || wanted.has(attached.source.name),
		);
	}

	return { verdict: evaluate(principal, request), request, resource: facts };
}

/** How many inline policies the accounts and the groups hold; the IAM dashboard's count. */
export async function inlinePolicyCounts(): Promise<InlinePolicyCounts> {
	const store = await loadIam();
	let accounts = 0;

	for (const entry of Object.values(store.principals)) {
		accounts += Object.keys(entry.inline).length;
	}

	const groups = store.groups.reduce((sum, group) => sum + Object.keys(group.inline).length, 0);

	return { accounts, groups };
}

/**
 * Decide the same action for many resources in one read; what a list route
 * uses to keep only the rows the account may see.
 */
export async function authorizeMany(
	accountIdOrName: string,
	action: string,
	resources: string[],
): Promise<Record<string, boolean>> {
	const out: Record<string, boolean> = {};

	if (accountIdOrName === ROOT_ACTOR) {
		for (const id of resources) {
			out[id] = true;
		}

		return out;
	}

	const principal = await principalContext(accountIdOrName);

	if (!principal) {
		for (const id of resources) {
			out[id] = false;
		}

		return out;
	}

	const spec = iamAction(action);
	const records = await describeResources(resources);

	for (const id of resources) {
		const record = records[id];
		const parsed = parseResourceId(id);

		out[id] = evaluate(principal, {
			action: spec?.name ?? action,
			resource: id,
			resourceType: parsed?.type ?? spec?.resourceType ?? null,
			resourceTags: record?.tags ?? {},
			resourceCreator: record?.createdBy ?? null,
		}).allowed;
	}

	return out;
}

/** The IAM audit trail, newest first. */
export async function iamAudit(opts: { target?: string; limit?: number } = {}): Promise<IamAuditEntry[]> {
	const store = await loadIam();
	let entries = [...store.audit].reverse();

	if (opts.target) {
		const wanted = opts.target.toLowerCase();

		entries = entries.filter(
			(entry) => entry.target?.toLowerCase() === wanted || entry.detail?.toLowerCase().includes(wanted),
		);
	}

	return entries.slice(0, opts.limit ?? 200);
}
