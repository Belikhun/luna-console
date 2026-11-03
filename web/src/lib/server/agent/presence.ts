// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Who has a conversation open right now. Every chat window holds a stream on
 * its conversation (the run's, or the idle watch), so those streams are the
 * presence: each enters when it opens and leaves when it closes, and everyone
 * subscribed hears the new list. It lives in the console's memory, like runs.
 */

type Subscriber = (viewers: string[]) => void;

interface Room {
	/** Open streams per account; one person can have several windows */
	counts: Map<string, number>;
	subscribers: Set<Subscriber>;
}

const rooms = new Map<string, Room>();

function room(conversationId: string): Room {
	let found = rooms.get(conversationId);

	if (!found) {
		found = { counts: new Map(), subscribers: new Set() };
		rooms.set(conversationId, found);
	}

	return found;
}

function viewersOf(target: Room): string[] {
	return [...target.counts.keys()].sort();
}

function broadcast(target: Room): void {
	const viewers = viewersOf(target);

	for (const subscriber of target.subscribers) {
		try {
			subscriber(viewers);
		} catch {
			// a stream that closed mid-write drops itself on cancel
		}
	}
}

function prune(conversationId: string, target: Room): void {
	if (target.counts.size === 0 && target.subscribers.size === 0) {
		rooms.delete(conversationId);
	}
}

/**
 * Mark an account as looking at a conversation and hear who else is, at once
 * and on every change. Returns the leave function, which does both undo steps.
 */
export function enterConversation(conversationId: string, account: string, notify: Subscriber): () => void {
	const target = room(conversationId);
	let left = false;

	target.counts.set(account, (target.counts.get(account) ?? 0) + 1);
	target.subscribers.add(notify);
	broadcast(target);

	return () => {
		if (left) {
			return;
		}

		left = true;
		target.subscribers.delete(notify);

		const count = (target.counts.get(account) ?? 1) - 1;

		if (count > 0) {
			target.counts.set(account, count);
		} else {
			target.counts.delete(account);
		}

		broadcast(target);
		prune(conversationId, target);
	};
}

/** Who has a conversation open, by account. */
export function conversationViewers(conversationId: string): string[] {
	const target = rooms.get(conversationId);

	return target
		? viewersOf(target)
		: [];
}
