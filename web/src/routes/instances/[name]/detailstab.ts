// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * What the instance screen's Details tab works out from the instance and its
 * sampled hour: when it entered the state it is in, where its extra ports
 * answer, and the tone a live figure wears. Nothing here renders.
 */

import type { InstanceRow } from '$lib/api';
import { cpuCeiling } from '$lib/format';
import { stateChange, type InstanceEvent } from '$lib/components/events';

/** One instance as `/api/instances/<name>` answers it. */
export interface InstanceDetail extends InstanceRow {
	/** The command line the next start runs */
	javaCommand: string;
	/** The Java runtime the instance is pinned to; null when it takes the machine's default */
	java: string | null;
	/** Memory and swap of the machine the instance runs on, MB; absent until that machine reports */
	hostMemMb?: number;
	hostSwapMb?: number;
}

/** A port a plugin or mod binds beside the game port. */
export interface ExtraPort {
	/** Who asked for it, as the registry names the binding (`bluemap@paper/web`) */
	key: string;
	/** Where it answers: the game address's host with this port */
	address: string;
}

/**
 * The extra ports of an instance, at the host its game port answers on. They
 * are bound on the same machine, so a follower's voice chat port is shown at
 * that machine's address and not at the console's own loopback.
 */
export function extraPorts(inst: Pick<InstanceRow, 'address' | 'ports'>): ExtraPort[] {
	const host = (inst.address ?? '').split(':')[0] ?? '';

	return Object.entries(inst.ports).map(([key, port]) => ({
		key,
		address: host
			? `${host}:${port}`
			: String(port)
	}));
}

/**
 * When the instance entered the state it is in now, from the newest state
 * change that ended there; null when the events kept do not reach that far.
 */
export function stateSince(events: InstanceEvent[], state: string): number | null {
	let newest: number | null = null;

	for (const event of events) {
		const change = stateChange(event);

		if (!change || change.to !== state) {
			continue;
		}

		if (newest === null || event.t > newest) {
			newest = event.t;
		}
	}

	return newest;
}

/** The newest events first, cut to what a summary has room for. */
export function newestEvents(events: InstanceEvent[], count: number): InstanceEvent[] {
	return [...events]
		.sort((left, right) => right.t - left.t)
		.slice(0, count);
}

/** CPU against every core of its machine: past 70% is busy, past 90% is saturated. */
export function cpuTone(cpu: number, cores: number | null): 'warning' | 'critical' | undefined {
	const share = cpu / cpuCeiling(cores);

	if (share >= 0.9) {
		return 'critical';
	}

	return share >= 0.7
		? 'warning'
		: undefined;
}
