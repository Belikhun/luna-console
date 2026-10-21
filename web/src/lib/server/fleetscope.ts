// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Machines as an account may see them.
 *
 * A machine is shared: every customer's instances run on the same few hosts.
 * Seeing a machine (`machine:List` / `machine:Describe`) tells an account how
 * loaded the host is and where it can launch, but its rows also name every
 * instance on it, in its instance list, its reachability probes, the per-instance
 * memory, CPU and state maps of each health sample, and its event log. Those
 * names belong to whoever created the instances, so they are kept to the ones
 * the account may describe (`instance:Describe`). Machine-wide figures (CPU,
 * memory, disk, the total resident memory of its servers) stay.
 */

import { ROOT_ACTOR } from '$core/accounts';
import { authorizeMany } from '$core/iam';
import { loadCluster } from '$core/config';
import { resourceId } from '$shared/iam/resources';

type Row = Record<string, unknown>;

/** The instance names a machine row mentions anywhere. */
function namesIn(row: Row): string[] {
	const names = new Set<string>();
	const health = (row.health ?? null) as Row | null;

	for (const name of (row.instances as string[] | undefined) ?? []) {
		names.add(name);
	}

	for (const probe of (row.reach as Array<{ instance: string }> | null | undefined) ?? []) {
		names.add(probe.instance);
	}

	for (const key of ['instanceRssMb', 'instanceCpu', 'states']) {
		for (const name of Object.keys((health?.[key] ?? {}) as Row)) {
			names.add(name);
		}
	}

	return [...names];
}

/**
 * The instances among `names` the account may describe, or null when it may
 * describe all of them (an administrator), in which case nothing is scrubbed.
 */
export async function visibleInstances(username: string | undefined, names: string[]): Promise<Set<string> | null> {
	const who = username ?? ROOT_ACTOR;
	const unique = [...new Set(names)];

	if (unique.length === 0) {
		return null;
	}

	const allowed = await authorizeMany(who, 'instance:Describe', unique.map((name) => resourceId('instance', name)));
	const visible = unique.filter((name) => allowed[resourceId('instance', name)]);

	return visible.length === unique.length
		? null
		: new Set(visible);
}

function keepKeys(map: unknown, visible: Set<string>): Row {
	return Object.fromEntries(Object.entries((map ?? {}) as Row).filter(([name]) => visible.has(name)));
}

/** One health sample with only the visible instances in its per-instance maps. */
function scrubSample(sample: Row | null, visible: Set<string>): Row | null {
	if (!sample) {
		return sample;
	}

	return {
		...sample,
		instanceRssMb: keepKeys(sample.instanceRssMb, visible),
		instanceCpu: keepKeys(sample.instanceCpu, visible),
		states: keepKeys(sample.states, visible)
	};
}

/** One machine row with only the visible instances in it. */
export function scrubRow(row: Row, visible: Set<string> | null): Row {
	if (!visible) {
		return row;
	}

	return {
		...row,
		instances: ((row.instances as string[] | undefined) ?? []).filter((name) => visible.has(name)),
		reach: row.reach
			? (row.reach as Array<{ instance: string }>).filter((probe) => visible.has(probe.instance))
			: row.reach,
		health: scrubSample((row.health ?? null) as Row | null, visible)
	};
}

/** Machine rows for an account: one decision over every instance they mention. */
export async function scopeRows(username: string | undefined, rows: Row[]): Promise<Row[]> {
	const visible = await visibleInstances(username, rows.flatMap(namesIn));

	return rows.map((row) => scrubRow(row, visible));
}

/**
 * A machine's detail for an account: its row, its health history and its event
 * log, the log keeping the machine's own events (`daemon:<name>`) and those of
 * visible instances.
 */
export async function scopeDetail(username: string | undefined, detail: Row): Promise<Row> {
	const row = detail.row as Row;
	const history = (detail.history as Row[] | undefined) ?? [];
	const events = (detail.events as Array<{ instance: string }> | undefined) ?? [];
	const names = [
		...namesIn(row),
		...history.flatMap((sample) => namesIn({ health: sample })),
		...events.map((event) => event.instance).filter((name) => !name.startsWith('daemon:'))
	];
	const visible = await visibleInstances(username, names);

	if (!visible) {
		return detail;
	}

	return {
		...detail,
		row: scrubRow(row, visible),
		history: history.map((sample) => scrubSample(sample, visible)),
		events: events.filter((event) => event.instance.startsWith('daemon:') || visible.has(event.instance))
	};
}

/** How long a stream reuses one decision before asking again, so a new instance appears. */
const STREAM_DECISION_MS = 30 * 1000;

/**
 * The fleet stream for an account: every `{ daemons }` frame passed through
 * `scrubRow`. Frames are re-encoded only when something is withheld.
 */
export function scopeStream(username: string | undefined, source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = '';
	let decided: { at: number; names: string; visible: Set<string> | null } | null = null;

	return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		async transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');

			let end = buffer.indexOf('\n\n');

			while (end >= 0) {
				const block = buffer.slice(0, end);

				buffer = buffer.slice(end + 2);
				end = buffer.indexOf('\n\n');

				const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');

				if (!data) {
					controller.enqueue(encoder.encode(`${block}\n\n`));

					continue;
				}

				try {
					const frame = JSON.parse(data) as { daemons?: Row[] };
					const rows = frame.daemons ?? [];
					const names = [...new Set(rows.flatMap(namesIn))].sort().join(',');

					if (!decided || decided.names !== names || Date.now() - decided.at > STREAM_DECISION_MS) {
						decided = { at: Date.now(), names, visible: await visibleInstances(username, names ? names.split(',') : []) };
					}

					const scoped = decided.visible
						? { ...frame, daemons: rows.map((row) => scrubRow(row, decided!.visible)) }
						: frame;

					controller.enqueue(encoder.encode(`data: ${JSON.stringify(scoped)}\n\n`));
				} catch {
					// a frame that is not the fleet shape carries no instance names
					controller.enqueue(encoder.encode(`${block}\n\n`));
				}
			}
		}
	}));
}

/**
 * The instances an account may not describe, or null when it may describe them
 * all. What the scrubbers below remove.
 */
export async function hiddenInstances(username: string | undefined): Promise<Set<string> | null> {
	const cfg = await loadCluster();
	const names = ['proxy', ...Object.keys(cfg.instances)];
	const visible = await visibleInstances(username, names);

	if (!visible) {
		return null;
	}

	return new Set(names.filter((name) => !visible.has(name)));
}

/** Fields whose value is a list of instance names (wildcards such as `*paper` are not names, so they stay). */
const NAME_LISTS = new Set(['targets', 'effective', 'effectiveTargets', 'matched', 'servers', 'usedBy', 'deployedTo', 'instances']);

/** Fields whose value is a map keyed by instance name. */
const NAME_MAPS = new Set(['assign', 'pins']);

/** Fields whose value lists rows naming an instance in `name` (in `consumers`, one list per runtime). */
const NAMED_ROWS = new Set(['instances', 'consumers']);

/** A server rule's instance name: `!survival` excludes survival. */
function bareName(rule: string): string {
	return rule.startsWith('!')
		? rule.slice(1)
		: rule;
}

function scrubValue(value: unknown, hidden: Set<string>, key: string | null, rowsByName: boolean): unknown {
	if (Array.isArray(value)) {
		const kept = value.filter((entry) => {
			if (typeof entry === 'string') {
				return !(key !== null && NAME_LISTS.has(key) && hidden.has(bareName(entry)));
			}

			if (entry && typeof entry === 'object') {
				const row = entry as Row;

				if (typeof row.instance === 'string' && hidden.has(row.instance)) {
					return false;
				}

				return !(rowsByName && typeof row.name === 'string' && hidden.has(row.name));
			}

			return true;
		});

		return kept.map((entry) => scrubValue(entry, hidden, null, false));
	}

	if (!value || typeof value !== 'object') {
		return value;
	}

	const out: Row = {};

	for (const [field, inner] of Object.entries(value as Row)) {
		if (key !== null && NAME_MAPS.has(key) && hidden.has(field)) {
			continue;
		}

		const byName = NAMED_ROWS.has(field) || (key === 'consumers');

		out[field] = scrubValue(inner, hidden, field, byName);
	}

	return out;
}

/**
 * Remove the hidden instances from a payload that mentions instances as a side
 * fact: an addon's targets, pins and usage, a pack's servers, the instances a
 * group, a profile or a runtime is used by. Every addon in the pool is visible
 * to a customer, but which servers run it is about other people's servers.
 */
export function scrubInstanceRefs<T>(payload: T, hidden: Set<string> | null): T {
	if (!hidden || hidden.size === 0) {
		return payload;
	}

	return scrubValue(payload, hidden, null, false) as T;
}

/**
 * A target list an account sends back, with the entries it was never shown put
 * back: saving a scrubbed list must not drop other people's servers from it.
 */
export function keepHiddenRefs(next: string[], previous: string[] | undefined, hidden: Set<string> | null): string[] {
	if (!hidden || hidden.size === 0) {
		return next;
	}

	const withheld = (previous ?? []).filter((rule) => hidden.has(bareName(rule)) && !next.includes(rule));

	return [...next, ...withheld];
}

/** Console API routes whose answers carry those side facts; the request hook scrubs them. */
export const INSTANCE_REF_ROUTES = ['/api/plugins', '/api/respacks', '/api/datapacks', '/api/addons', '/api/profiles', '/api/runtimes'];
