// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The daemon-owned cluster event log. This is the single log every client sees:
 * the web console reads it over the socket, followers push their events up into
 * the primary's copy, and the sampler/scheduler write straight into it.
 */

import { recordEvent } from "../core/metrics";

/**
 * What an event can say beyond its sentence: who caused it, why, and the
 * figures that were true at the moment. `reasonKey` is a language key under
 * `web.events.reason`, for the causes the daemon itself recognises; `reason`
 * is free text (a failure's own message).
 */
export interface EventExtra {
	/** The account, `root` (a shell), `mcp:<token>` or `schedule`; absent when nobody asked */
	actor?: string;
	reasonKey?: string;
	reason?: string;
	/** Figures at the moment: players online, how long the run lasted, the tick rate */
	facts?: Record<string, number | string>;
}

export interface ClusterEvent extends EventExtra {
	t: number;
	instance: string;
	kind: "state" | "action" | "error";
	message: string;
}

/** A start, stop or restart somebody asked for, until the state it asked for is reached. */
interface PendingRequest {
	verb: "start" | "stop" | "restart";
	actor: string;
	at: number;
}

/** How long a request explains the state changes after it. A stop that takes longer has its own problem. */
const REQUEST_WINDOW_MS = 5 * 60_000;

/** The ops that start, stop or restart an instance, and which verb each is. */
const LIFECYCLE_OPS: Record<string, PendingRequest["verb"]> = {
	"instances.startInstance": "start",
	"instances.stopInstance": "stop",
	"lifecycle.startTracked": "start",
	"lifecycle.stopTracked": "stop",
	"lifecycle.restartTracked": "restart",
};

const requests = new Map<string, PendingRequest>();

/**
 * Remember who asked an instance to change state, from the op that asked.
 * `runOp` calls this for every op, so the CLI, the console, MCP and schedules
 * are all attributed the same way, wherever the instance runs: the request is
 * seen here, and the follower's state change is forwarded back through here.
 */
export function noteRequest(op: string, instance: unknown, actor: string): void {
	const verb = LIFECYCLE_OPS[op];

	if (!verb || typeof instance !== "string") {
		return;
	}

	requests.set(instance, { verb, actor, at: Date.now() });
}

/** States an instance is up in, for telling a stop nobody asked for from one that was. */
const UP_STATES = new Set(["running", "starting", "restarting"]);

/**
 * Explain a state change: the request it answers, a crash, or a stop nobody
 * asked for. The sampler writes state changes as `<from> → <to>`, which is
 * also all a follower on an older build forwards, so the message is parsed.
 */
function attribute(instance: string, message: string, extra: EventExtra): EventExtra {
	const match = /^(\S+) → (\S+)$/.exec(message);

	if (!match) {
		return extra;
	}

	const from = match[1]!;
	const to = match[2]!;
	const request = requests.get(instance);
	const fresh = request && Date.now() - request.at <= REQUEST_WINDOW_MS
		? request
		: undefined;
	const out: EventExtra = { ...extra };

	if (fresh && !out.actor) {
		out.actor = fresh.actor;
		// a follower guesses without seeing requests made here, so a request wins
		out.reasonKey = `requested.${fresh.verb}`;

		// the request is answered once the state it asked for is reached
		const done = fresh.verb === "stop"
			? to === "stopped"
			: to === "running";

		if (done) {
			requests.delete(instance);
		}
	}

	if (!out.reasonKey) {
		if (to === "auto-restarting") {
			out.reasonKey = "crashed";
		} else if ((to === "stopped" || to === "stopping") && UP_STATES.has(from)) {
			out.reasonKey = "unasked";
		} else if (to === "running" && from === "auto-restarting") {
			out.reasonKey = "recovered";
		}
	}

	return out;
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

/** Live readers of the log; the console's agent triggers wake on these instead of polling. */
const subscribers = new Set<(event: ClusterEvent) => void>();

/**
 * Be told of every event as it is logged, followers' included (the hub logs
 * those through `pushEvent` too). Returns the unsubscriber.
 */
export function subscribeEvents(listener: (event: ClusterEvent) => void): () => void {
	subscribers.add(listener);

	return () => {
		subscribers.delete(listener);
	};
}

/** Append to the event log, trimming it to MAX_EVENTS. */
export function pushEvent(instance: string, kind: ClusterEvent["kind"], message: string, extra: EventExtra = {}): void {
	const detail = kind === "state"
		? attribute(instance, message, extra)
		: extra;
	const event: ClusterEvent = { t: Date.now(), instance, kind, message, ...detail };

	events.push(event);

	if (events.length > MAX_EVENTS) {
		events.splice(0, events.length - MAX_EVENTS);
	}

	recordEvent(instance, { t: event.t, kind, message, ...detail });
	forwarder?.(event);

	for (const listener of subscribers) {
		try {
			listener(event);
		} catch {
			// a reader whose stream broke is dropped by its own cancel
		}
	}
}

/** Event log, newest first, optionally filtered to one instance. */
export function getEvents(instance?: string): ClusterEvent[] {
	return events
		.filter((event) => !instance || event.instance === instance)
		.slice()
		.reverse();
}
