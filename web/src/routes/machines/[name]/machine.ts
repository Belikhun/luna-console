// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The shapes one machine's screen passes between its tabs, and the two merges
 * it works out itself: the environment a machine's instances see, and the
 * port ranges a machine departs from the cluster's with. Nothing here renders.
 */

import type { PortPool } from '$core/types';
import type { PortPoolUsage } from '$core/ports';

/** One variable as the instances on a machine resolve it. */
export interface MachineVar {
	name: string;
	/** The value instances on this machine resolve */
	value: string;
	secret: boolean;
	/** Where that value comes from: this machine, or inherited from the cluster */
	source: 'global' | 'machine';
	/** The cluster-wide value a machine override shadows, when there is one */
	global: string | null;
	globalSecret: boolean;
}

/** What `/api/env` answers, as far as this screen reads it. */
export interface EnvAnswer {
	variables: Array<{ name: string; value: string; secret: boolean }>;
	overrides: Array<{ name: string; value: string; secret: boolean; scope: string; target: string }>;
}

/** What `/api/ports` answers, as far as this screen reads it. */
export interface PortsAnswer {
	catalog: PortPool[];
	defaults: PortPool[];
	consumers: Record<string, Array<{ kind: string; name: string; protocol: string; portId?: string }>>;
	pools: PortPoolUsage[];
}

/** The fields of one pool's override on a machine, as typed. */
export interface OverrideDraft {
	from: string;
	to: string;
	reserved: string;
}

/**
 * Every value instances on a machine resolve: the cluster-wide set with the
 * machine's overrides applied over it, plus anything defined only there. The
 * source is what tells the two apart; a list of overrides alone could not
 * answer what the machine actually sees.
 */
export function machineEnvironment(data: EnvAnswer, machine: string): MachineVar[] {
	const globals = new Map(data.variables.map((entry) => [entry.name, entry]));
	const own = new Map(
		data.overrides
			.filter((entry) => entry.scope === 'machine' && entry.target === machine)
			.map((entry) => [entry.name, entry])
	);

	const names = new Set([...globals.keys(), ...own.keys()]);

	return [...names]
		.map((name): MachineVar => {
			const override = own.get(name);
			const global = globals.get(name);

			return {
				name,
				value: override
					? override.value
					: (global?.value ?? ''),
				secret: !!(override?.secret ?? global?.secret),
				source: override
					? 'machine'
					: 'global',
				global: global
					? global.value
					: null,
				globalSecret: !!global?.secret
			};
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

/** The override fields of every pool as the catalog holds them for a machine. */
export function overrideDrafts(catalog: PortPool[], machineKey: string): Record<string, OverrideDraft> {
	const drafts: Record<string, OverrideDraft> = {};

	for (const pool of catalog) {
		const override = pool.overrides?.[machineKey];

		drafts[pool.id] = {
			from: override?.range
				? String(override.range[0])
				: '',
			to: override?.range
				? String(override.range[1])
				: '',
			reserved: (override?.reserved ?? []).join(', ')
		};
	}

	return drafts;
}

/** Whether two sets of override fields say the same thing, spacing aside. */
export function sameDrafts(left: Record<string, OverrideDraft>, right: Record<string, OverrideDraft>): boolean {
	const ids = new Set([...Object.keys(left), ...Object.keys(right)]);

	for (const id of ids) {
		const one = left[id];
		const other = right[id];

		if (
			(one?.from ?? '').trim() !== (other?.from ?? '').trim() ||
			(one?.to ?? '').trim() !== (other?.to ?? '').trim() ||
			(one?.reserved ?? '').replace(/\s/g, '') !== (other?.reserved ?? '').replace(/\s/g, '')
		) {
			return false;
		}
	}

	return true;
}

/** The whole numbers typed into a "held back" field. */
export function parsePorts(text: string): number[] {
	return text
		.split(/[\s,]+/)
		.filter(Boolean)
		.map(Number)
		.filter((port) => Number.isInteger(port));
}

/** The catalog with one machine's override fields written into every pool. */
export function applyDrafts(catalog: PortPool[], drafts: Record<string, OverrideDraft>, machineKey: string): PortPool[] {
	return catalog.map((pool) => {
		const draft = drafts[pool.id] ?? { from: '', to: '', reserved: '' };
		const overrides = { ...(pool.overrides ?? {}) };
		const hasRange = draft.from.trim() !== '' && draft.to.trim() !== '';
		const held = parsePorts(draft.reserved);

		if (hasRange || held.length > 0) {
			overrides[machineKey] = {
				...(hasRange ? { range: [Number(draft.from), Number(draft.to)] as [number, number] } : {}),
				...(held.length > 0 ? { reserved: held } : {})
			};
		} else {
			delete overrides[machineKey];
		}

		return {
			...pool,
			overrides: Object.keys(overrides).length > 0
				? overrides
				: undefined
		};
	});
}
