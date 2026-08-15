// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The uptime store's runtime half: load it at boot, fold in what the health
 * samples already report, and write it back on a timer.
 *
 * Every observation the record needs is data the cluster already moves. The
 * primary's own sampler produces `HealthSample.states` every few seconds, and a
 * follower's samples ride the heartbeat pong, so the primary sees the whole
 * fleet's instance states without a single extra poll. That is the reason
 * accrual lives here rather than in the sampler: one funnel, fed from both.
 *
 * The store is **primary-local**, like `sessions.json` and unlike the mirrored
 * state files. The primary is the only writer, because it is the only daemon
 * that sees every machine's states; mirroring it would hand several daemons a
 * whole-document write of the same file every few seconds, and the last one
 * would win.
 */

import { existsSync } from "node:fs";

import { root, statePath } from "../core/config";
import { emptyStore, forget, observe, prune, type UptimeStore } from "../core/uptime";

import { log } from "./index";

/**
 * Path of the uptime store.
 *
 * Here rather than in `core/uptime` on purpose: that module is imported by the
 * console's timeline component, and reaching `core/config` from it would drag
 * `node:fs` into the browser bundle.
 */
export function uptimePath(): string {
	return statePath("uptime.json");
}

/**
 * How often the store reaches disk.
 *
 * Persisting every observation would rewrite a state file every few seconds for
 * a record whose resolution is a day. A transition flushes immediately, since
 * that is the part worth not losing.
 */
const FLUSH_INTERVAL_MS = 300_000;

let store: UptimeStore = emptyStore();
let loaded = false;
let dirty = false;
let flusher: ReturnType<typeof setInterval> | undefined;

/** Read the store, treating a missing file as an empty one. */
export async function loadUptime(): Promise<void> {
	if (loaded) {
		return;
	}

	loaded = true;

	if (!existsSync(uptimePath())) {
		return;
	}

	try {
		const parsed = (await Bun.file(uptimePath()).json()) as UptimeStore;

		store = parsed?.instances ? parsed : emptyStore();
	} catch (err) {
		// a corrupt store must not stop the daemon: uptime history is a record, not
		// a dependency, and starting a fresh one beats refusing to boot
		log(`uptime: could not read ${uptimePath()}: ${(err as Error).message}`);
	}
}

/** Write the store if anything changed since the last write. */
export async function flushUptime(): Promise<void> {
	if (!dirty) {
		return;
	}

	dirty = false;

	try {
		await Bun.write(uptimePath(), JSON.stringify(store, null, "\t") + "\n");
	} catch (err) {
		dirty = true;
		log(`uptime: could not write ${uptimePath()}: ${(err as Error).message}`);
	}
}

/**
 * Fold one machine's observed instance states into the record.
 *
 * Called with the primary's own sample and with each follower's as it lands, so
 * the caller never has to know which machine an instance belongs to.
 */
export function observeStates(states: Record<string, string>, at: number): void {
	if (!loaded || !Object.keys(states).length) {
		return;
	}

	observe(store, states, at);
	dirty = true;
}

/**
 * Stop crediting time to a machine's instances.
 *
 * A dropped follower link is not an outage; it is the end of observation. The
 * instances keep whatever state they were last seen in and accrue nothing until
 * the link returns, which is exactly what `seen` is for.
 */
export function forgetInstances(instances: string[]): void {
	if (!loaded || !instances.length) {
		return;
	}

	forget(store, instances);
	dirty = true;
}

/** Drop records for instances the cluster no longer has. */
export function pruneUptime(known: string[]): void {
	if (!loaded) {
		return;
	}

	if (prune(store, known) > 0) {
		dirty = true;
	}
}

/** The live store, for the read paths that report it. */
export function uptimeStore(): UptimeStore {
	return store;
}

/** Load the store and start the flush timer; the primary calls this at boot. */
export async function ensureUptimeRecorder(): Promise<void> {
	await loadUptime();

	if (flusher) {
		return;
	}

	flusher = setInterval(() => {
		void flushUptime();
	}, FLUSH_INTERVAL_MS);

	// the timer must not be what keeps the process alive
	flusher.unref?.();

	log(`uptime: recording to ${uptimePath().replace(root(), "")}`);
}
