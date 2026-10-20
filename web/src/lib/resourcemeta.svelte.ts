// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Resource metadata (who created a thing, when, and its tags) for the screens
 * that list or summarise resources.
 *
 * A list screen keeps one `ResourceMetaIndex` per resource type and syncs it
 * with its rows' names: the records arrive in one batched describe call, and
 * the owner and tag columns, their search text and their sort keys all read
 * from it. Metadata decorates a list, so a refused or failed describe leaves
 * the cells empty instead of breaking the table.
 */

import { untrack } from 'svelte';
import { post } from '$lib/api';
import { t } from '$lib/i18n.svelte';
import { resourceId } from '$shared/iam/resources';
import type { IamResourceType } from '$shared/iam/actions';
import type { ResourceView } from '$core/resources';
import type { Column, TableFilterGroup } from '$lib/components/table';

/** The most ids one describe call carries; the route caps it at the same number. */
export const DESCRIBE_BATCH = 500;

/**
 * The icon a resource type is drawn with: the one its screen carries in the
 * side nav, so a row in a mixed listing reads as the thing it links to.
 */
export const RESOURCE_TYPE_ICONS: Record<IamResourceType, string> = {
	instance: 'server',
	chat: 'comment',
	machine: 'hardDrive',
	plugin: 'plug',
	pack: 'image',
	datapack: 'box',
	'addon-group': 'layerGroup',
	runtime: 'microchip',
	profile: 'sliders',
	'port-pool': 'sitemap',
	domain: 'globe',
	schedule: 'clock',
	env: 'key',
	player: 'users',
	'permission-group': 'gavel',
	account: 'userShield',
	group: 'users',
	policy: 'fileLines',
	'mcp-token': 'plug',
	knowledge: 'bookOpen',
	conversation: 'cat'
};

/** How old a list's metadata may get before a refresh fetches all of it again. */
export const META_STALE_MS = 60_000;

/** Actors that are not console accounts, so they have no account screen to link to. */
const SYSTEM_ACTORS = new Set(['root']);

/** Describe resources in batches, keyed by resource id. */
export async function loadResourceMeta(ids: string[]): Promise<Record<string, ResourceView>> {
	const unique = [...new Set(ids)];
	const out: Record<string, ResourceView> = {};

	for (let start = 0; start < unique.length; start += DESCRIBE_BATCH) {
		const chunk = unique.slice(start, start + DESCRIBE_BATCH);
		const data = await post<{ resources: Record<string, ResourceView> }>('/resources/describe', { ids: chunk });

		Object.assign(out, data.resources);
	}

	return out;
}

/** One resource's record, or null when the describe was refused or failed. */
export async function loadOneResourceMeta(id: string): Promise<ResourceView | null> {
	try {
		const data = await loadResourceMeta([id]);

		return data[id] ?? null;
	} catch {
		return null;
	}
}

/** Tags as `key=value` words, key-sorted: what a search box and a sort key read. */
export function tagText(tags: Record<string, string>): string {
	return Object.keys(tags)
		.sort((a, b) => a.localeCompare(b))
		.map((key) => {
			const value = tags[key] ?? '';

			return value === ''
				? key
				: `${key}=${value}`;
		})
		.join(' ');
}

/** The account screen an actor links to, or null for one that is not an account (`root`, `mcp:<token>`). */
export function actorHref(actor: string | null | undefined): string | null {
	if (!actor || SYSTEM_ACTORS.has(actor) || actor.includes(':')) {
		return null;
	}

	return `/console/accounts?q=${encodeURIComponent(actor)}`;
}

/** Where a resource's own screen is, or null for a kind that has none. */
export function resourceHref(type: IamResourceType, name: string): string | null {
	const encoded = encodeURIComponent(name);

	switch (type) {
		case 'instance':
			return `/instances/${encoded}`;
		case 'plugin':
			return `/plugins/${encoded}`;
		case 'pack':
			return `/packs/${encoded}`;
		case 'datapack':
			return `/datapacks?q=${encoded}`;
		case 'env':
			return `/environment/${encoded}`;
		case 'account':
			return `/console/accounts?q=${encoded}`;
		case 'policy':
			return `/console/iam/policies/${encoded}`;
		case 'group':
			return `/console/iam/groups/${encoded}`;
		case 'mcp-token':
			return `/console/mcp?q=${encoded}`;
		case 'knowledge':
			return `/console/knowledge/${encoded}`;
		case 'schedule':
			return `/schedules?q=${encoded}`;
		case 'domain':
			return `/network/domains?q=${encoded}`;
		case 'machine':
			return `/machines/${encoded}`;
		default:
			return null;
	}
}

/** A resource type's label, or the type itself when the language has none. */
export function resourceTypeLabel(type: string): string {
	const key = `web.resources.types.${type}`;
	const label = t(key);

	return label === key
		? type
		: label;
}

/**
 * The owner and tag columns a list screen appends: "Created by" shown, "Tags"
 * one preferences click away, as AWS's list views offer them. Call it inside the
 * screen's `$derived` column list so the labels follow the locale.
 */
export function resourceMetaColumns(): Column[] {
	return [
		{ id: 'createdBy', label: t('web.resourceMeta.createdBy'), sortable: true, width: 130 },
		{ id: 'tags', label: t('web.resourceMeta.tags'), sortable: true, width: 220, hidden: true }
	];
}

/** Every tag key in a set of records with the values each carries, both sorted. */
export function vocabularyOf(views: Iterable<ResourceView>): Record<string, string[]> {
	const keys = new Map<string, Set<string>>();

	for (const view of views) {
		for (const [key, value] of Object.entries(view.tags)) {
			const values = keys.get(key) ?? new Set<string>();

			values.add(value);
			keys.set(key, values);
		}
	}

	const out: Record<string, string[]> = {};

	for (const key of [...keys.keys()].sort((a, b) => a.localeCompare(b))) {
		out[key] = [...(keys.get(key) ?? [])].sort((a, b) => a.localeCompare(b));
	}

	return out;
}

/** The metadata of one list screen's rows, all of one resource type. */
export class ResourceMetaIndex {
	readonly type: IamResourceType;

	views: Record<string, ResourceView> = $state({});

	#fetchedAt = 0;
	#failedAt = 0;
	#busy = false;

	constructor(type: IamResourceType) {
		this.type = type;
	}

	/** The resource id a row of this list stands for. */
	idOf(name: string): string {
		return resourceId(this.type, name);
	}

	view(name: string): ResourceView | null {
		return this.views[this.idOf(name)] ?? null;
	}

	owner(name: string): string | null {
		return this.view(name)?.createdBy ?? null;
	}

	tags(name: string): Record<string, string> {
		return this.view(name)?.tags ?? {};
	}

	/**
	 * The creators of a row that stands for several resources (a plugin row
	 * groups one lock entry per family), each named once.
	 */
	owners(names: string | string[]): string[] {
		const list = typeof names === 'string'
			? [names]
			: names;
		const out = new Set<string>();

		for (const name of list) {
			const owner = this.owner(name);

			if (owner) {
				out.add(owner);
			}
		}

		return [...out];
	}

	/**
	 * The tags of one or several resources as one map; a key whose values differ
	 * between them shows every value, comma-joined.
	 */
	mergedTags(names: string | string[]): Record<string, string> {
		if (typeof names === 'string') {
			return this.tags(names);
		}

		const values = new Map<string, Set<string>>();

		for (const name of names) {
			for (const [key, value] of Object.entries(this.tags(name))) {
				const set = values.get(key) ?? new Set<string>();

				set.add(value);
				values.set(key, set);
			}
		}

		const out: Record<string, string> = {};

		for (const [key, set] of values) {
			out[key] = [...set].join(', ');
		}

		return out;
	}

	/** Words the table's search box should find this row by. */
	searchText(names: string | string[]): string {
		return `${this.owners(names).join(' ')} ${tagText(this.mergedTags(names))}`;
	}

	/** Sort key for the two metadata columns, null for any other column. */
	sortValue(names: string | string[], col: string): string | null {
		switch (col) {
			case 'createdBy':
				return this.owners(names).join(', ');
			case 'tags':
				return tagText(this.mergedTags(names));
			default:
				return null;
		}
	}

	/** The tag keys and values on the rows loaded so far. */
	vocabulary(): Record<string, string[]> {
		return vocabularyOf(Object.values(this.views));
	}

	/**
	 * A filter group over the rows' tags: one option per key (any value) and one
	 * per key and value. Built from the loaded records, so it needs no extra call.
	 */
	tagFilter<T>(nameOf: (row: T) => string | string[]): TableFilterGroup<T> {
		const vocabulary = this.vocabulary();
		const options: TableFilterGroup<T>['options'] = [{ value: 'any', label: t('web.resources.anyTag') }];

		for (const [key, values] of Object.entries(vocabulary)) {
			options.push({
				value: `key:${key}`,
				label: t('web.resourceMeta.tagAnyValue', { key }),
				match: (row: T) => key in this.mergedTags(nameOf(row))
			});

			for (const value of values) {
				options.push({
					value: `tag:${key}=${value}`,
					label: value === ''
						? t('web.resourceMeta.tagEmptyValue', { key })
						: `${key} = ${value}`,
					match: (row: T) => this.mergedTags(nameOf(row))[key] === value
				});
			}
		}

		return { id: 'tag', label: t('web.resources.filterTag'), options };
	}

	/**
	 * Bring the index in line with the rows: fetch what is missing, or everything
	 * once the last full fetch is older than `META_STALE_MS`. Safe to call from an
	 * effect on every refresh; a call while one is in flight is dropped.
	 */
	async sync(names: string[], force: boolean = false): Promise<void> {
		// a refused describe is not retried on every refresh tick
		if (this.#busy || (!force && Date.now() - this.#failedAt < META_STALE_MS)) {
			return;
		}

		const ids = names.map((name) => this.idOf(name));
		const stale = force || Date.now() - this.#fetchedAt > META_STALE_MS;
		const known = untrack(() => this.views);
		const wanted = stale
			? ids
			: ids.filter((id) => !(id in known));

		if (wanted.length === 0) {
			return;
		}

		this.#busy = true;

		try {
			const loaded = await loadResourceMeta(wanted);

			this.views = { ...untrack(() => this.views), ...loaded };

			if (stale) {
				this.#fetchedAt = Date.now();
			}
		} catch {
			// an account without tag:Describe still gets its list, just without owners
			this.#failedAt = Date.now();
		} finally {
			this.#busy = false;
		}
	}
}
