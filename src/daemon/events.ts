// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The daemon-owned cluster event log. This is the single log every client sees:
 * the web console reads it over the socket, followers push their events up into
 * the primary's copy, and the sampler/scheduler write straight into it.
 */

export interface ClusterEvent {
	t: number;
	instance: string;
	kind: "state" | "action" | "error";
	message: string;
}

const MAX_EVENTS = 200;

/**
 * Event-log key for a daemon. Daemon events share the log with instance events,
 * so they are filed under a namespaced pseudo-instance rather than a name that
 * could collide with a real one.
 */
export function daemonEventKey(name: string): string {
	return `daemon:${name}`;
}

const events: ClusterEvent[] = [];

/** A follower daemon forwards its events up to the primary through this. */
let forwarder: ((event: ClusterEvent) => void) | undefined;

/** Install (or clear) the upward event forwarder. */
export function installEventForwarder(hook: ((event: ClusterEvent) => void) | undefined): void {
	forwarder = hook;
}

/** Append to the event log, trimming it to MAX_EVENTS. */
export function pushEvent(instance: string, kind: ClusterEvent["kind"], message: string): void {
	const event: ClusterEvent = { t: Date.now(), instance, kind, message };

	events.push(event);

	if (events.length > MAX_EVENTS) {
		events.splice(0, events.length - MAX_EVENTS);
	}

	forwarder?.(event);
}

/** Event log, newest first, optionally filtered to one instance. */
export function getEvents(instance?: string): ClusterEvent[] {
	return events
		.filter((event) => !instance || event.instance === instance)
		.slice()
		.reverse();
}
