// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The policy grammar and its evaluator: IAM's, written in YAML.
 *
 * A document is `Version` plus a list of statements; a statement is an `Effect`,
 * the actions and resources it covers (or the ones it does not, through
 * `NotAction`/`NotResource`), and an optional `Condition` block. Evaluation
 * follows IAM exactly: every applicable statement is read, an explicit Deny wins
 * over everything, any matching Allow allows, and nothing matching is a denial.
 *
 * This module is pure and runs on both sides of the socket: the daemon decides a
 * request with it, and the browser hides a nav entry or disables a button with
 * the same code over the same documents, so the two can never disagree. Parsing
 * the YAML is the daemon's job (`core/iam.ts`); what travels is the normalized
 * document.
 */

import { t } from "../i18n";

export type PolicyEffect = "Allow" | "Deny";

/** A statement after normalization: every list field is a list, every string trimmed. */
export interface PolicyStatement {
	Sid?: string;
	Effect: PolicyEffect;
	Action?: string[];
	NotAction?: string[];
	Resource?: string[];
	NotResource?: string[];
	/** operator → condition key → accepted values */
	Condition?: Record<string, Record<string, string[]>>;
}

export interface PolicyDocument {
	Version: 1;
	Statement: PolicyStatement[];
}

/** One thing wrong with a document, located by a JSON-pointer-like path. */
export interface PolicyIssue {
	path: string;
	message: string;
}

/** Where a document attached to a principal came from, for the verdict and the UI. */
export interface PolicySource {
	kind: "builtin" | "managed" | "inline";
	/** The policy's name, or the inline document's name */
	name: string;
	/** The group it arrived through, when it did */
	group?: string;
}

/**
 * A key naming one attachment: the same policy reached directly and through a
 * group are two attachments, and a simulation can leave either one out.
 */
export function policySourceKey(source: PolicySource): string {
	return `${source.kind}:${source.group ?? ""}:${source.name}`;
}

export interface AttachedDocument {
	source: PolicySource;
	document: PolicyDocument;
}

/**
 * Everything the evaluator knows about who is asking. Built once per request by
 * the daemon (`iam.principalContext`) and handed to the browser as is.
 */
export interface PrincipalContext {
	accountId: string;
	username: string;
	tags: Record<string, string>;
	policies: AttachedDocument[];
	/** Group names the account is in, for display; the policies above already include theirs */
	groups: string[];
}

/** What is being asked. The resource facts are what the condition keys read. */
export interface AccessRequest {
	action: string;
	/** `luna:<type>/<name>`, or null for an action that names no resource */
	resource: string | null;
	resourceType?: string | null;
	resourceTags?: Record<string, string>;
	resourceCreator?: string | null;
	/**
	 * For a player: who created each server the player has played on. What
	 * `luna:PlayerServerCreators` reads, so a policy can grant "players who
	 * joined a server I own" without listing either.
	 */
	playerServerCreators?: string[];
	/** Tags a create or tag call is asking to set */
	requestTags?: Record<string, string>;
}

export type VerdictReason = "explicit-deny" | "allow" | "implicit-deny" | "root";

export interface Verdict {
	allowed: boolean;
	reason: VerdictReason;
	/** The statement that decided it, when one did */
	matched?: {
		source: PolicySource;
		sid: string | null;
		index: number;
	};
}

/** The condition operators the grammar accepts, without the set prefix and `IfExists`. */
export const CONDITION_OPERATORS = [
	"StringEquals",
	"StringNotEquals",
	"StringEqualsIgnoreCase",
	"StringNotEqualsIgnoreCase",
	"StringLike",
	"StringNotLike",
	"Bool",
	"Null",
	"NumericEquals",
	"NumericNotEquals",
	"NumericLessThan",
	"NumericLessThanEquals",
	"NumericGreaterThan",
	"NumericGreaterThanEquals",
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/** The condition keys a policy may read, with `<k>` standing for a tag key. */
export const CONDITION_KEYS = [
	"luna:username",
	"luna:PrincipalTag/<k>",
	"luna:ResourceTag/<k>",
	"luna:ResourceCreator",
	"luna:ResourceType",
	"luna:PlayerServerCreators",
	"luna:RequestTag/<k>",
	"luna:TagKeys",
] as const;

const ACTION_PATTERN = /^(\*|[a-z*?][a-z0-9*?-]*:[A-Za-z0-9*?]+)$/;
const RESOURCE_PATTERN = /^(\*|luna:[A-Za-z0-9*?-]+(\/[^\s]*)?)$/;
const SID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function issue(path: string, key: string, params: Record<string, string | number> = {}): PolicyIssue {
	return { path, message: t(`core.iam.grammar.${key}`, params) };
}

/** A string or a list of strings, trimmed; anything else is reported. */
function stringList(value: unknown, path: string, issues: PolicyIssue[]): string[] | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}

	const list = Array.isArray(value) ? value : [value];
	const out: string[] = [];

	for (const [index, entry] of list.entries()) {
		if (typeof entry !== "string" || entry.trim() === "") {
			issues.push(issue(`${path}[${index}]`, "notAString"));

			continue;
		}

		out.push(entry.trim());
	}

	return out;
}

function normalizeCondition(
	value: unknown,
	path: string,
	issues: PolicyIssue[],
): Record<string, Record<string, string[]>> | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}

	if (typeof value !== "object" || Array.isArray(value)) {
		issues.push(issue(path, "conditionNotAMap"));

		return undefined;
	}

	const out: Record<string, Record<string, string[]>> = {};

	for (const [operator, block] of Object.entries(value as Record<string, unknown>)) {
		if (!parseOperator(operator)) {
			issues.push(issue(`${path}.${operator}`, "unknownOperator", { operator }));

			continue;
		}

		if (typeof block !== "object" || block === null || Array.isArray(block)) {
			issues.push(issue(`${path}.${operator}`, "operatorNotAMap", { operator }));

			continue;
		}

		const keys: Record<string, string[]> = {};

		for (const [key, raw] of Object.entries(block as Record<string, unknown>)) {
			if (!isConditionKey(key)) {
				issues.push(issue(`${path}.${operator}.${key}`, "unknownConditionKey", { key }));

				continue;
			}

			const list = Array.isArray(raw) ? raw : [raw];
			const values: string[] = [];

			for (const entry of list) {
				if (typeof entry === "string") {
					values.push(entry);
				} else if (typeof entry === "number" || typeof entry === "boolean") {
					values.push(String(entry));
				} else {
					issues.push(issue(`${path}.${operator}.${key}`, "conditionValue"));
				}
			}

			keys[key] = values;
		}

		out[operator] = keys;
	}

	return out;
}

/** Whether a condition key is one the evaluator can answer. */
export function isConditionKey(key: string): boolean {
	if (key === "luna:username" || key === "luna:ResourceCreator" || key === "luna:ResourceType" || key === "luna:TagKeys" || key === "luna:PlayerServerCreators") {
		return true;
	}

	return /^luna:(PrincipalTag|ResourceTag|RequestTag)\/[^\s/]+$/.test(key);
}

interface ParsedOperator {
	base: ConditionOperator;
	ifExists: boolean;
	set: "any" | "all" | null;
}

/** Split `ForAnyValue:StringEqualsIfExists` into its parts, or null for an unknown operator. */
export function parseOperator(operator: string): ParsedOperator | null {
	let rest = operator;
	let set: ParsedOperator["set"] = null;

	if (rest.startsWith("ForAnyValue:")) {
		set = "any";
		rest = rest.slice("ForAnyValue:".length);
	} else if (rest.startsWith("ForAllValues:")) {
		set = "all";
		rest = rest.slice("ForAllValues:".length);
	}

	let ifExists = false;

	if (rest.endsWith("IfExists") && rest !== "Null") {
		ifExists = true;
		rest = rest.slice(0, -"IfExists".length);
	}

	if (!(CONDITION_OPERATORS as readonly string[]).includes(rest)) {
		return null;
	}

	return { base: rest as ConditionOperator, ifExists, set };
}

/**
 * Turn a parsed YAML/JSON value into a document, reporting everything wrong with
 * it at once rather than stopping at the first fault, so an editor can mark every
 * line in one pass. `document` is absent when any issue is fatal.
 */
export function normalizeDocument(raw: unknown): { document?: PolicyDocument; issues: PolicyIssue[] } {
	const issues: PolicyIssue[] = [];

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { issues: [issue("", "notAMap")] };
	}

	const top = raw as Record<string, unknown>;

	if (top.Version !== undefined && top.Version !== 1 && top.Version !== "1") {
		issues.push(issue("Version", "badVersion"));
	}

	const rawStatements = top.Statement;

	if (rawStatements === undefined) {
		issues.push(issue("Statement", "missingStatement"));

		return { issues };
	}

	const list = Array.isArray(rawStatements) ? rawStatements : [rawStatements];
	const statements: PolicyStatement[] = [];
	const sids = new Set<string>();

	for (const [index, entry] of list.entries()) {
		const path = `Statement[${index}]`;

		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			issues.push(issue(path, "statementNotAMap"));

			continue;
		}

		const stmt = entry as Record<string, unknown>;
		const effect = stmt.Effect;

		if (effect !== "Allow" && effect !== "Deny") {
			issues.push(issue(`${path}.Effect`, "badEffect"));
		}

		const out: PolicyStatement = { Effect: effect === "Deny" ? "Deny" : "Allow" };

		if (stmt.Sid !== undefined) {
			if (typeof stmt.Sid !== "string" || !SID_PATTERN.test(stmt.Sid)) {
				issues.push(issue(`${path}.Sid`, "badSid"));
			} else if (sids.has(stmt.Sid)) {
				issues.push(issue(`${path}.Sid`, "duplicateSid", { sid: stmt.Sid }));
			} else {
				sids.add(stmt.Sid);
				out.Sid = stmt.Sid;
			}
		}

		const action = stringList(stmt.Action, `${path}.Action`, issues);
		const notAction = stringList(stmt.NotAction, `${path}.NotAction`, issues);
		const resource = stringList(stmt.Resource, `${path}.Resource`, issues);
		const notResource = stringList(stmt.NotResource, `${path}.NotResource`, issues);

		if (action && notAction) {
			issues.push(issue(`${path}`, "actionAndNotAction"));
		}

		if (!action && !notAction) {
			issues.push(issue(`${path}`, "noAction"));
		}

		if (resource && notResource) {
			issues.push(issue(`${path}`, "resourceAndNotResource"));
		}

		if (!resource && !notResource) {
			issues.push(issue(`${path}`, "noResource"));
		}

		for (const [listName, values] of [["Action", action], ["NotAction", notAction]] as const) {
			for (const [i, value] of (values ?? []).entries()) {
				if (!ACTION_PATTERN.test(value)) {
					issues.push(issue(`${path}.${listName}[${i}]`, "badAction", { value }));
				}
			}
		}

		for (const [listName, values] of [["Resource", resource], ["NotResource", notResource]] as const) {
			for (const [i, value] of (values ?? []).entries()) {
				if (!RESOURCE_PATTERN.test(value)) {
					issues.push(issue(`${path}.${listName}[${i}]`, "badResource", { value }));
				}
			}
		}

		for (const key of Object.keys(stmt)) {
			if (!["Sid", "Effect", "Action", "NotAction", "Resource", "NotResource", "Condition"].includes(key)) {
				issues.push(issue(`${path}.${key}`, "unknownField", { field: key }));
			}
		}

		if (action) {
			out.Action = action;
		}

		if (notAction) {
			out.NotAction = notAction;
		}

		if (resource) {
			out.Resource = resource;
		}

		if (notResource) {
			out.NotResource = notResource;
		}

		const condition = normalizeCondition(stmt.Condition, `${path}.Condition`, issues);

		if (condition && Object.keys(condition).length > 0) {
			out.Condition = condition;
		}

		statements.push(out);
	}

	for (const key of Object.keys(top)) {
		if (key !== "Version" && key !== "Statement") {
			issues.push(issue(key, "unknownField", { field: key }));
		}
	}

	if (issues.length > 0) {
		return { issues };
	}

	return { document: { Version: 1, Statement: statements }, issues };
}

/** The regex for an IAM wildcard pattern (`*` any run, `?` one character). */
function wildcard(pattern: string, caseInsensitive: boolean): RegExp {
	const escaped = pattern
		.split("")
		.map((char) => {
			if (char === "*") {
				return ".*";
			}

			if (char === "?") {
				return ".";
			}

			return char.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
		})
		.join("");

	return new RegExp(`^${escaped}$`, caseInsensitive ? "is" : "s");
}

/** Whether an action string matches an action pattern; actions compare case-insensitively. */
export function actionMatches(pattern: string, action: string): boolean {
	return wildcard(pattern, true).test(action);
}

/** Whether a resource id matches a resource pattern; resources compare exactly. */
export function resourceMatches(pattern: string, resource: string): boolean {
	return wildcard(pattern, false).test(resource);
}

/**
 * Substitute `${luna:username}` and `${luna:PrincipalTag/k}` in a string. A
 * variable the principal cannot answer makes the string match nothing, which is
 * how IAM treats an unresolvable variable.
 */
export function substituteVariables(value: string, principal: PrincipalContext): string | null {
	let failed = false;

	const out = value.replace(/\$\{([^}]+)\}/g, (_whole, name: string) => {
		if (name === "luna:username") {
			return principal.username;
		}

		if (name.startsWith("luna:PrincipalTag/")) {
			const tag = principal.tags[name.slice("luna:PrincipalTag/".length)];

			if (tag === undefined) {
				failed = true;

				return "";
			}

			return tag;
		}

		failed = true;

		return "";
	});

	return failed ? null : out;
}

/** The values a condition key has for this request; absent when the key does not apply. */
function conditionValues(key: string, principal: PrincipalContext, request: AccessRequest): string[] | undefined {
	if (key === "luna:username") {
		return [principal.username];
	}

	if (key === "luna:ResourceCreator") {
		return request.resourceCreator ? [request.resourceCreator] : undefined;
	}

	if (key === "luna:ResourceType") {
		return request.resourceType ? [request.resourceType] : undefined;
	}

	if (key === "luna:PlayerServerCreators") {
		return request.playerServerCreators && request.playerServerCreators.length > 0
			? request.playerServerCreators
			: undefined;
	}

	if (key === "luna:TagKeys") {
		const keys = Object.keys(request.requestTags ?? {});

		return keys.length > 0 ? keys : undefined;
	}

	if (key.startsWith("luna:PrincipalTag/")) {
		const value = principal.tags[key.slice("luna:PrincipalTag/".length)];

		return value === undefined ? undefined : [value];
	}

	if (key.startsWith("luna:ResourceTag/")) {
		const value = request.resourceTags?.[key.slice("luna:ResourceTag/".length)];

		return value === undefined ? undefined : [value];
	}

	if (key.startsWith("luna:RequestTag/")) {
		const value = request.requestTags?.[key.slice("luna:RequestTag/".length)];

		return value === undefined ? undefined : [value];
	}

	return undefined;
}

function compareOne(base: ConditionOperator, actual: string, expected: string): boolean {
	switch (base) {
		case "StringEquals":
			return actual === expected;

		case "StringNotEquals":
			return actual !== expected;

		case "StringEqualsIgnoreCase":
			return actual.toLowerCase() === expected.toLowerCase();

		case "StringNotEqualsIgnoreCase":
			return actual.toLowerCase() !== expected.toLowerCase();

		case "StringLike":
			return wildcard(expected, false).test(actual);

		case "StringNotLike":
			return !wildcard(expected, false).test(actual);

		case "Bool":
			return (actual.toLowerCase() === "true") === (expected.toLowerCase() === "true");

		case "NumericEquals":
			return Number(actual) === Number(expected);

		case "NumericNotEquals":
			return Number(actual) !== Number(expected);

		case "NumericLessThan":
			return Number(actual) < Number(expected);

		case "NumericLessThanEquals":
			return Number(actual) <= Number(expected);

		case "NumericGreaterThan":
			return Number(actual) > Number(expected);

		case "NumericGreaterThanEquals":
			return Number(actual) >= Number(expected);

		case "Null":
			return false;
	}
}

/**
 * One condition key under one operator. The "Not" operators are negations of a
 * match against *any* expected value; a multi-valued key goes through the set
 * prefix, or `ForAnyValue` semantics when none is given, as IAM does.
 */
function conditionHolds(
	parsed: ParsedOperator,
	key: string,
	expectedRaw: string[],
	principal: PrincipalContext,
	request: AccessRequest,
): boolean {
	const actual = conditionValues(key, principal, request);

	if (parsed.base === "Null") {
		const wantsAbsent = expectedRaw.some((value) => value.toLowerCase() === "true");

		return wantsAbsent ? actual === undefined : actual !== undefined;
	}

	if (actual === undefined) {
		return parsed.ifExists;
	}

	const expected: string[] = [];

	for (const value of expectedRaw) {
		const substituted = substituteVariables(value, principal);

		if (substituted !== null) {
			expected.push(substituted);
		}
	}

	const negated = parsed.base.startsWith("StringNot") || parsed.base === "NumericNotEquals";

	const oneMatches = (value: string): boolean => {
		if (negated) {
			return expected.every((candidate) => compareOne(parsed.base, value, candidate));
		}

		return expected.some((candidate) => compareOne(parsed.base, value, candidate));
	};

	if (parsed.set === "all") {
		return actual.every(oneMatches);
	}

	return actual.some(oneMatches);
}

function statementApplies(stmt: PolicyStatement, principal: PrincipalContext, request: AccessRequest): boolean {
	if (stmt.Action && !stmt.Action.some((pattern) => actionMatches(pattern, request.action))) {
		return false;
	}

	if (stmt.NotAction && stmt.NotAction.some((pattern) => actionMatches(pattern, request.action))) {
		return false;
	}

	// an action that names no resource is matched against the empty string, so
	// only a bare `*` reaches it; `luna:instance/*` says nothing about it
	const resource = request.resource ?? "";

	const resolved = (patterns: string[]): string[] => {
		const out: string[] = [];

		for (const pattern of patterns) {
			const substituted = substituteVariables(pattern, principal);

			if (substituted !== null) {
				out.push(substituted);
			}
		}

		return out;
	};

	if (stmt.Resource && !resolved(stmt.Resource).some((pattern) => resourceMatches(pattern, resource))) {
		return false;
	}

	if (stmt.NotResource && resolved(stmt.NotResource).some((pattern) => resourceMatches(pattern, resource))) {
		return false;
	}

	for (const [operator, keys] of Object.entries(stmt.Condition ?? {})) {
		const parsed = parseOperator(operator);

		if (!parsed) {
			return false;
		}

		for (const [key, expected] of Object.entries(keys)) {
			if (!conditionHolds(parsed, key, expected, principal, request)) {
				return false;
			}
		}
	}

	return true;
}

/**
 * Decide one request for one principal. Every attached document is read; a Deny
 * that applies ends it, an Allow that applies is remembered, and the first Allow
 * found is the one the verdict names when nothing denied.
 */
export function evaluate(principal: PrincipalContext, request: AccessRequest): Verdict {
	let allow: Verdict["matched"] | undefined;

	for (const attached of principal.policies) {
		for (const [index, stmt] of attached.document.Statement.entries()) {
			if (!statementApplies(stmt, principal, request)) {
				continue;
			}

			const matched = { source: attached.source, sid: stmt.Sid ?? null, index };

			if (stmt.Effect === "Deny") {
				return { allowed: false, reason: "explicit-deny", matched };
			}

			allow ??= matched;
		}
	}

	if (allow) {
		return { allowed: true, reason: "allow", matched: allow };
	}

	return { allowed: false, reason: "implicit-deny" };
}

/**
 * Whether any policy could ever allow an action, for some resource. Used to
 * offer only the tools an account could possibly use; it is a superset, never a
 * decision: an Allow whose resource or condition never matches still counts,
 * and only a Deny on every resource with no condition rules an action out.
 */
export function actionPossible(principal: PrincipalContext, action: string, resourceless = false): boolean {
	let allowed = false;

	for (const attached of principal.policies) {
		for (const stmt of attached.document.Statement) {
			const named = stmt.Action
				? stmt.Action.some((pattern) => actionMatches(pattern, action))
				: !(stmt.NotAction ?? []).some((pattern) => actionMatches(pattern, action));

			if (!named) {
				continue;
			}

			// an action that names no resource is matched against nothing, so a
			// statement scoped to resources, or conditioned on one, can never apply
			if (resourceless && stmt.Effect === "Allow" && !reachesResourceless(stmt)) {
				continue;
			}

			const everywhere = (stmt.Resource ?? []).includes("*") && !stmt.NotResource && !stmt.Condition;

			if (stmt.Effect === "Deny" && everywhere) {
				return false;
			}

			if (stmt.Effect === "Allow") {
				allowed = true;
			}
		}
	}

	return allowed;
}

/** Whether a statement could match a request that names no resource. */
function reachesResourceless(stmt: PolicyStatement): boolean {
	if (stmt.Resource && !stmt.Resource.includes("*")) {
		return false;
	}

	for (const keys of Object.values(stmt.Condition ?? {})) {
		for (const key of Object.keys(keys)) {
			if (key.startsWith("luna:Resource")) {
				return false;
			}
		}
	}

	return true;
}

/** The verdict for the machine itself; nothing is evaluated for `root`. */
export const ROOT_VERDICT: Verdict = { allowed: true, reason: "root" };
