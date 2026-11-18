// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * How `EventsTable` reads a daemon event: a state change as the two states it
 * moved between, who caused it in words a person recognises, and the reason
 * and figures it carries. Nothing here renders.
 */

import { t } from '$lib/i18n.svelte';
import { fmtDuration } from '$lib/format';
import { actorHref } from '$lib/resourcemeta.svelte';

/** One event, as the daemon logs it and the record keeps it. */
export interface InstanceEvent {
	t: number;
	kind: 'state' | 'action' | 'error';
	message: string;
	/** The instance it happened to, on a console-wide list */
	instance?: string;
	actor?: string;
	reasonKey?: string;
	reason?: string;
	facts?: Record<string, number | string>;
}

/** Who caused an event, as the table names them. */
export interface ActorView {
	kind: 'account' | 'shell' | 'mcp' | 'schedule' | 'server' | 'nobody';
	label: string;
	icon: string;
	/** The account's screen, for a person */
	href?: string;
}

/** The two states of a state change, or null for any other event. */
export function stateChange(event: InstanceEvent): { from: string; to: string } | null {
	if (event.kind !== 'state') {
		return null;
	}

	const match = /^(\S+) → (\S+)$/.exec(event.message);

	return match
		? { from: match[1]!, to: match[2]! }
		: null;
}

/**
 * The event's sentence without the actor it names: older entries spelled who
 * did it into the message ("restart requested by belikhun"), which the Caused
 * by column now says.
 */
export function eventText(event: InstanceEvent): string {
	const actor = event.actor;

	if (!actor) {
		return event.message;
	}

	return event.message
		.replace(` requested by ${actor}`, ' requested')
		.replace(new RegExp(` by ${escapeRegExp(actor)}(?=:|$| \\()`), '')
		.replace(new RegExp(` \\(${escapeRegExp(actor)}\\)$`), '');
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Who caused an event. An account is a person (linked); `root` is somebody at
 * a shell on the machine; `mcp:<token>` a program with a token; a schedule
 * nobody typed. A crash names the server itself, and a change with no cause
 * on record says so rather than inventing one.
 */
export function actorOf(event: InstanceEvent): ActorView {
	const actor = event.actor;

	if (!actor) {
		return event.reasonKey === 'crashed' || event.reasonKey === 'unasked' || event.reasonKey === 'recovered'
			? { kind: 'server', label: t('web.events.actor.server'), icon: 'server' }
			: { kind: 'nobody', label: t('web.events.actor.nobody'), icon: 'circle' };
	}

	if (actor === 'root') {
		return { kind: 'shell', label: t('web.events.actor.shell'), icon: 'terminal' };
	}

	if (actor === 'schedule') {
		return { kind: 'schedule', label: t('web.events.actor.schedule'), icon: 'calendar' };
	}

	if (actor.startsWith('mcp:')) {
		return { kind: 'mcp', label: t('web.events.actor.mcp', { token: actor.slice(4) }), icon: 'robot' };
	}

	return { kind: 'account', label: actor, icon: 'user', href: actorHref(actor) ?? undefined };
}

/** Why it happened, in the reader's language: a cause the daemon recognised, or the failure's own words. */
export function reasonOf(event: InstanceEvent): string | null {
	if (event.reasonKey) {
		return t(`web.events.reason.${event.reasonKey}`);
	}

	return event.reason ?? null;
}

/** The figures that were true at the moment, as short phrases. */
export function factsOf(event: InstanceEvent): string[] {
	const facts = event.facts ?? {};
	const out: string[] = [];

	if (typeof facts.players === 'number') {
		out.push(t('web.events.fact.players', { count: String(facts.players) }));
	}

	if (typeof facts.ranForMs === 'number') {
		out.push(t('web.events.fact.ranFor', { span: fmtDuration(facts.ranForMs) }));
	}

	if (typeof facts.tps === 'number') {
		out.push(t('web.events.fact.tps', { tps: facts.tps.toFixed(1) }));
	}

	if (typeof facts.rssMb === 'number') {
		out.push(t('web.events.fact.memory', { gb: (facts.rssMb / 1024).toFixed(1) }));
	}

	return out;
}

/** How long a request explains the state changes after it, as the daemon judges it. */
const REQUEST_WINDOW_MS = 5 * 60_000;

/** The verb of a "<verb> requested" event, or null. */
function requestedVerb(message: string): 'start' | 'stop' | 'restart' | null {
	const match = /^(start|stop|restart) requested\b/.exec(message);

	return match
		? (match[1] as 'start' | 'stop' | 'restart')
		: null;
}

/**
 * Fill in what an event from an older daemon could not say. The actor is read
 * out of the sentence it was spelled into ("restart requested by belikhun"),
 * and a state change with nobody on record is paired with the request it
 * answers, as a current daemon does when it logs it. Returns new objects; the
 * order of the list is kept.
 */
export function enrichEvents(events: InstanceEvent[]): InstanceEvent[] {
	const filled = events.map((event): InstanceEvent => {
		if (event.actor) {
			return event;
		}

		const by = / by ([A-Za-z0-9_.:@-]+)(?=:|$| \()/.exec(event.message) ?? / \(([A-Za-z0-9_.:@-]+)\)$/.exec(event.message);

		return by
			? { ...event, actor: by[1] }
			: event;
	});

	const oldestFirst = filled
		.map((event, index) => ({ event, index }))
		.sort((left, right) => left.event.t - right.event.t);
	const pending = new Map<string, { verb: 'start' | 'stop' | 'restart'; actor?: string; at: number }>();
	// a request's outcome ("restart finished") is the requester's too, even after its state is reached
	const asked = new Map<string, { verb: string; actor?: string; at: number }>();

	for (const entry of oldestFirst) {
		const event = entry.event;
		const key = event.instance ?? '';
		const verb = requestedVerb(event.message);

		if (verb) {
			pending.set(key, { verb, actor: event.actor, at: event.t });
			asked.set(key, { verb, actor: event.actor, at: event.t });

			continue;
		}

		const outcome = /^(start|stop|restart) (finished|failed)\b/.exec(event.message);
		const earlier = asked.get(key);

		if (outcome && earlier && earlier.verb === outcome[1] && !event.actor && earlier.actor) {
			filled[entry.index] = { ...event, actor: earlier.actor };

			continue;
		}

		const change = stateChange(event);
		const request = pending.get(key);

		if (!change || !request || event.t - request.at > REQUEST_WINDOW_MS) {
			continue;
		}

		if (!event.reasonKey?.startsWith('requested')) {
			filled[entry.index] = {
				...event,
				actor: event.actor ?? request.actor,
				reasonKey: `requested.${request.verb}`
			};
		}

		const done = request.verb === 'stop'
			? change.to === 'stopped'
			: change.to === 'running';

		if (done) {
			pending.delete(key);
		}
	}

	return filled;
}

/** When, short: the time alone today, the day and time before that. */
export function fmtWhen(at: number): string {
	const date = new Date(at);
	const today = new Date();
	const sameDay = date.toDateString() === today.toDateString();

	return sameDay
		? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
		: date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
