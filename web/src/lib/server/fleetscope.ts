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
