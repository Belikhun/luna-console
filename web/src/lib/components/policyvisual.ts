// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The model behind `PolicyVisualEditor.svelte`: a policy document as the form
 * edits it, one block per statement, and the two conversions between that and
 * the document the daemon stores.
 *
 * A statement the form cannot show faithfully (NotAction, NotResource, actions
 * of several services, wildcards other than `service:*`, set operators) is
 * carried through untouched as a raw block, so switching to the form and back
 * never rewrites what it could not display.
 */

import { t } from '$lib/i18n.svelte';
import { IAM_SERVICES, actionsOf, iamAction, type IamActionSpec, type IamResourceType } from '$shared/iam/actions';
import {
	CONDITION_KEYS,
	parseOperator,
	type ConditionOperator,
	type PolicyDocument,
	type PolicyEffect,
	type PolicyStatement
} from '$shared/iam/grammar';

/** One condition row: a key (its template plus the tag key), an operator, its values. */
export interface VisualCondition {
	id: number;
	/** one of `CONDITION_KEYS`, `<k>` standing for the tag key */
	template: string;
	/** the tag key, for a template that has one */
	tagKey: string;
	operator: ConditionOperator;
	ifExists: boolean;
	/** comma separated, as typed */
	values: string;
}

/** One statement as the form holds it. */
export interface VisualBlock {
	id: number;
	open: boolean;
	/** the action filter typed in this block; the form's own state, never saved */
	filter: string;
	/** the request conditions section is unfolded */
	conditionsOpen: boolean;
	/** set when the form cannot show the statement; it is then kept as is */
	unsupported: string;
	raw: PolicyStatement | null;
	sid: string;
	service: string;
	effect: PolicyEffect;
	/** `service:*` */
	all: boolean;
	/** catalog action names, when not `all` */
	actions: string[];
	resourceMode: 'all' | 'specific';
	resources: string[];
	conditions: VisualCondition[];
}

let nextId = 1;

/** A fresh id for a block or a condition row; only ever compared within one editor. */
export function visualId(): number {
	nextId += 1;

	return nextId;
}

/** The label a service is shown under. */
export function serviceLabel(service: string): string {
	const key = `web.iamServices.${service}`;
	const label = t(key);

	return label === key
		? service
		: label;
}

/** The resource type a service's actions are checked against, or null when they name none. */
export function serviceResourceType(service: string): IamResourceType | null {
	return actionsOf(service)[0]?.resourceType ?? null;
}

/** Split a condition key into the template it fills and its tag key. */
export function splitConditionKey(key: string): { template: string; tagKey: string } {
	const slash = key.indexOf('/');

	if (slash > 0) {
		const prefix = key.slice(0, slash);
		const template = `${prefix}/<k>`;

		if ((CONDITION_KEYS as readonly string[]).includes(template)) {
			return { template, tagKey: key.slice(slash + 1) };
		}
	}

	return { template: key, tagKey: '' };
}

/** The condition key a template and a tag key spell; empty when a tag key is needed and missing. */
export function joinConditionKey(template: string, tagKey: string): string {
	if (!template.includes('<k>')) {
		return template;
	}

	const trimmed = tagKey.trim();

	return trimmed
		? template.replace('<k>', trimmed)
		: '';
}

/**
 * Why the form cannot show a statement, as a language key, or an empty string
 * when it can.
 */
export function unsupportedReason(stmt: PolicyStatement): string {
	if (stmt.NotAction) {
		return 'web.policyVisual.unsupportedNotAction';
	}

	if (stmt.NotResource) {
		return 'web.policyVisual.unsupportedNotResource';
	}

	const services = new Set<string>();

	for (const pattern of stmt.Action ?? []) {
		if (pattern === '*') {
			return 'web.policyVisual.unsupportedEverything';
		}

		const wild = /^([a-z][a-z0-9-]*):\*$/.exec(pattern);

		if (wild && IAM_SERVICES.includes(wild[1]!)) {
			services.add(wild[1]!);

			continue;
		}

		const spec = iamAction(pattern);

		if (!spec) {
			return 'web.policyVisual.unsupportedPattern';
		}

		services.add(spec.service);
	}

	if (services.size > 1) {
		return 'web.policyVisual.unsupportedServices';
	}

	for (const operator of Object.keys(stmt.Condition ?? {})) {
		const parsed = parseOperator(operator);

		if (!parsed || parsed.set) {
			return 'web.policyVisual.unsupportedSetOperator';
		}
	}

	return '';
}

/** The form's view of one statement. */
export function blockFromStatement(stmt: PolicyStatement): VisualBlock {
	const reason = unsupportedReason(stmt);

	const base: VisualBlock = {
		id: visualId(),
		open: true,
		filter: '',
		conditionsOpen: Object.keys(stmt.Condition ?? {}).length > 0,
		unsupported: reason,
		raw: reason ? stmt : null,
		sid: stmt.Sid ?? '',
		service: '',
		effect: stmt.Effect,
		all: false,
		actions: [],
		resourceMode: 'all',
		resources: [],
		conditions: []
	};

	if (reason) {
		return base;
	}

	for (const pattern of stmt.Action ?? []) {
		if (pattern.endsWith(':*')) {
			base.service = pattern.slice(0, -2);
			base.all = true;

			continue;
		}

		const spec = iamAction(pattern);

		if (spec) {
			base.service = spec.service;

			if (!base.actions.includes(spec.name)) {
				base.actions.push(spec.name);
			}
		}
	}

	const resources = stmt.Resource ?? ['*'];

	if (resources.includes('*')) {
		base.resourceMode = 'all';
	} else {
		base.resourceMode = 'specific';
		base.resources = [...resources];
	}

	for (const [operator, keys] of Object.entries(stmt.Condition ?? {})) {
		const parsed = parseOperator(operator);

		if (!parsed) {
			continue;
		}

		for (const [key, values] of Object.entries(keys)) {
			const { template, tagKey } = splitConditionKey(key);

			base.conditions.push({
				id: visualId(),
				template,
				tagKey,
				operator: parsed.base,
				ifExists: parsed.ifExists,
				values: values.join(', ')
			});
		}
	}

	return base;
}

/** A block for a statement nobody has written yet. */
export function emptyBlock(): VisualBlock {
	return {
		id: visualId(),
		open: true,
		filter: '',
		conditionsOpen: false,
		unsupported: '',
		raw: null,
		sid: '',
		service: '',
		effect: 'Allow',
		all: false,
		actions: [],
		resourceMode: 'all',
		resources: [],
		conditions: []
	};
}

/** The form's view of a document; an empty one starts with a single blank statement. */
export function blocksFromDocument(document: PolicyDocument): VisualBlock[] {
	if (document.Statement.length === 0) {
		return [emptyBlock()];
	}

	return document.Statement.map(blockFromStatement);
}

/** A copy of a block under fresh ids; a statement id is dropped, since two may not share one. */
export function duplicateBlock(block: VisualBlock): VisualBlock {
	const copy: VisualBlock = JSON.parse(JSON.stringify(block));

	copy.id = visualId();
	copy.sid = '';

	if (copy.raw) {
		delete copy.raw.Sid;
	}

	copy.conditions = copy.conditions.map((condition) => ({ ...condition, id: visualId() }));

	return copy;
}

/** The statement a block stands for. */
export function statementFromBlock(block: VisualBlock): PolicyStatement {
	if (block.raw) {
		return block.raw;
	}

	const stmt: PolicyStatement = { Effect: block.effect };

	if (block.sid.trim()) {
		stmt.Sid = block.sid.trim();
	}

	if (!block.service) {
		stmt.Action = [];
	} else if (block.all) {
		stmt.Action = [`${block.service}:*`];
	} else {
		const order = actionsOf(block.service).map((spec) => spec.name);

		stmt.Action = [...block.actions].sort((left, right) => order.indexOf(left) - order.indexOf(right));
	}

	const scoped = block.service !== '' && serviceResourceType(block.service) !== null;

	stmt.Resource = scoped && block.resourceMode === 'specific'
		? block.resources.map((entry) => entry.trim()).filter(Boolean)
		: ['*'];

	const condition: Record<string, Record<string, string[]>> = {};

	for (const row of block.conditions) {
		const key = joinConditionKey(row.template, row.tagKey);

		if (!key) {
			continue;
		}

		const operator = row.ifExists && row.operator !== 'Null'
			? `${row.operator}IfExists`
			: row.operator;

		const values = row.values
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean);

		condition[operator] ??= {};
		condition[operator][key] = values;
	}

	if (Object.keys(condition).length > 0) {
		stmt.Condition = condition;
	}

	return stmt;
}

/** The document the form spells. */
export function documentFromBlocks(blocks: VisualBlock[]): PolicyDocument {
	return { Version: 1, Statement: blocks.map(statementFromBlock) };
}

/** The actions of a service at one access level, narrowed by a filter. */
export function filterActions(specs: IamActionSpec[], filter: string, label: (spec: IamActionSpec) => string): IamActionSpec[] {
	const wanted = filter.trim().toLowerCase();

	if (!wanted) {
		return specs;
	}

	return specs.filter(
		(spec) => spec.name.toLowerCase().includes(wanted) || label(spec).toLowerCase().includes(wanted)
	);
}
