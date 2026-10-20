// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The policy summary: a document read the way AWS's console reads one, one row
 * per service and effect, saying how much of the service a policy reaches, on
 * which resources and under which conditions.
 *
 * Pure and shared, so the policy screen, the create wizard's review step and
 * anything else that wants a document in plain words read it identically. The
 * rows carry codes and the patterns themselves; the caller turns them into
 * words.
 */

import { IAM_ACTIONS, IAM_SERVICES, type IamActionSpec } from "./actions";
import { actionMatches, type PolicyDocument, type PolicyEffect, type PolicyStatement } from "./grammar";

/** The access levels a summary groups actions by, in the order they are shown. */
export type SummaryAccessLevel = "List" | "Read" | "Write" | "Delete";

/** Every access level, in display order. */
export const SUMMARY_ACCESS_LEVELS: SummaryAccessLevel[] = ["List", "Read", "Write", "Delete"];

/** One condition as a summary shows it: the operator, the key, the values it accepts. */
export interface SummaryCondition {
	operator: string;
	key: string;
	values: string[];
}

/** One service under one effect. */
export interface ServiceSummaryRow {
	service: string;
	effect: PolicyEffect;
	/** Catalog actions of the service the statements reach, in catalog order */
	actions: string[];
	/** How many actions the catalog has for the service */
	total: number;
	/** Every action of the service is reached */
	full: boolean;
	/** The access levels the reached actions fall into, in display order */
	levels: SummaryAccessLevel[];
	/** Every resource is reached: some statement names `*` with no NotResource */
	allResources: boolean;
	/** The resource patterns named, when not every resource is */
	resources: string[];
	/** Patterns a NotResource excludes; the statement reaches everything else */
	exceptResources: string[];
	/** Conditions of the statements behind the row, in statement order */
	conditions: SummaryCondition[];
	/** Indexes of the statements that contribute to the row */
	statements: number[];
}

/** A whole document, summarized. */
export interface PolicyDocumentSummary {
	allow: ServiceSummaryRow[];
	deny: ServiceSummaryRow[];
	/** Services no statement reaches under either effect */
	remaining: string[];
	/** Every service the catalog knows */
	services: number;
}

/**
 * The access level of a catalog action: read actions whose verb starts with
 * `List` are listings, the rest of the reads are reads, writes are writes and
 * destructive actions are deletions.
 */
export function accessLevelOf(spec: IamActionSpec): SummaryAccessLevel {
	if (spec.access === "destructive") {
		return "Delete";
	}

	if (spec.access === "write") {
		return "Write";
	}

	return spec.verb.startsWith("List") ? "List" : "Read";
}

/** The catalog actions a statement names, through `Action` or the complement of `NotAction`. */
export function statementActions(stmt: PolicyStatement): IamActionSpec[] {
	if (stmt.Action) {
		const patterns = stmt.Action;

		return IAM_ACTIONS.filter((spec) => patterns.some((pattern) => actionMatches(pattern, spec.name)));
	}

	const excluded = stmt.NotAction ?? [];

	return IAM_ACTIONS.filter((spec) => !excluded.some((pattern) => actionMatches(pattern, spec.name)));
}

function conditionsOf(stmt: PolicyStatement): SummaryCondition[] {
	const out: SummaryCondition[] = [];

	for (const [operator, keys] of Object.entries(stmt.Condition ?? {})) {
		for (const [key, values] of Object.entries(keys)) {
			out.push({ operator, key, values: [...values] });
		}
	}

	return out;
}

function addUnique(list: string[], values: string[]): void {
	for (const value of values) {
		if (!list.includes(value)) {
			list.push(value);
		}
	}
}

/**
 * Summarize a policy document. Statements under the same effect that reach the
 * same service merge into one row: their actions, resources and conditions are
 * united, as AWS's summary does, and the row remembers which statements it came
 * from so a screen can point back at them.
 */
export function summarizePolicyDocument(document: PolicyDocument): PolicyDocumentSummary {
	const rows = new Map<string, ServiceSummaryRow>();

	for (const [index, stmt] of document.Statement.entries()) {
		const reached = statementActions(stmt);
		const byService = new Map<string, IamActionSpec[]>();

		for (const spec of reached) {
			const list = byService.get(spec.service) ?? [];

			list.push(spec);
			byService.set(spec.service, list);
		}

		for (const [service, specs] of byService) {
			const key = `${stmt.Effect}:${service}`;
			let row = rows.get(key);

			if (!row) {
				row = {
					service,
					effect: stmt.Effect,
					actions: [],
					total: IAM_ACTIONS.filter((spec) => spec.service === service).length,
					full: false,
					levels: [],
					allResources: false,
					resources: [],
					exceptResources: [],
					conditions: [],
					statements: [],
				};

				rows.set(key, row);
			}

			addUnique(row.actions, specs.map((spec) => spec.name));
			row.statements.push(index);
			row.conditions.push(...conditionsOf(stmt));

			if (stmt.NotResource) {
				addUnique(row.exceptResources, stmt.NotResource);
			} else if ((stmt.Resource ?? []).includes("*")) {
				row.allResources = true;
			} else {
				addUnique(row.resources, stmt.Resource ?? []);
			}
		}
	}

	const order = (name: string): number => IAM_ACTIONS.findIndex((spec) => spec.name === name);

	for (const row of rows.values()) {
		row.actions.sort((left, right) => order(left) - order(right));
		row.full = row.actions.length === row.total;

		const specs = IAM_ACTIONS.filter((spec) => row.actions.includes(spec.name));
		const levels = new Set(specs.map(accessLevelOf));

		row.levels = SUMMARY_ACCESS_LEVELS.filter((level) => levels.has(level));

		if (row.allResources) {
			row.resources = [];
		}
	}

	const serviceOrder = (service: string): number => IAM_SERVICES.indexOf(service);

	const pick = (effect: PolicyEffect): ServiceSummaryRow[] =>
		[...rows.values()]
			.filter((row) => row.effect === effect)
			.sort((left, right) => serviceOrder(left.service) - serviceOrder(right.service));

	const allow = pick("Allow");
	const deny = pick("Deny");
	const touched = new Set([...allow, ...deny].map((row) => row.service));

	return {
		allow,
		deny,
		remaining: IAM_SERVICES.filter((service) => !touched.has(service)),
		services: IAM_SERVICES.length,
	};
}

/**
 * The actions of a row grouped by access level, for a screen that lists them
 * under each level the way the summary's drill-down does.
 */
export function actionsByLevel(row: ServiceSummaryRow): Record<SummaryAccessLevel, IamActionSpec[]> {
	const out: Record<SummaryAccessLevel, IamActionSpec[]> = { List: [], Read: [], Write: [], Delete: [] };

	for (const spec of IAM_ACTIONS) {
		if (row.actions.includes(spec.name)) {
			out[accessLevelOf(spec)].push(spec);
		}
	}

	return out;
}
