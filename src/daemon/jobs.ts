/**
 * Registry of long-running daemon operations.
 *
 * An RPC that cannot answer inside one request — creating an instance, changing
 * a Minecraft version, a full deploy — runs as a job instead: it gets a
 * ProgressReporter tree, the caller gets the job id straight away and watches
 * the tree move over SSE. Ported from the web console's job registry; the
 * daemon is the long-lived process now, so this is where jobs live.
 */

import { ProgressReporter, type ProgressSnapshot } from "../core/progress";

export type JobState = "running" | "done" | "failed";

/** Serializable state of one job, what SSE subscribers receive. */
export interface JobView {
	id: string;
	kind: string;
	target: string;
	state: JobState;
	startedAt: number;
	finishedAt: number | null;
	progress: ProgressSnapshot;
	result: unknown;
	error: string | null;
}

type Subscriber = (view: JobView) => void;

interface JobEntry {
	view: JobView;
	reporter: ProgressReporter;
	subscribers: Set<Subscriber>;
	/** progress moved since the last flush */
	dirty: boolean;
	flusher?: ReturnType<typeof setInterval>;
}

/**
 * How often subscribers are told about progress. A jar download reports per
 * chunk — hundreds of times — and none of those frames are worth their own
 * SSE message.
 */
const FLUSH_MS = 120;

/** How long a finished job stays readable, so a client can reconnect for its outcome. */
const RETAIN_MS = 300_000;

const jobs = new Map<string, JobEntry>();

let counter = 0;

/** Drop finished jobs nobody came back for. */
function prune(): void {
	const now = Date.now();

	for (const [id, entry] of jobs) {
		const finished = entry.view.finishedAt;

		if (finished !== null && now - finished > RETAIN_MS && entry.subscribers.size === 0) {
			jobs.delete(id);
		}
	}
}

function publish(entry: JobEntry): void {
	entry.dirty = false;

	for (const subscriber of entry.subscribers) {
		subscriber(entry.view);
	}
}

/**
 * Start a long-running operation in the background and return its job straight
 * away. `run` gets the root reporter to hang its steps off; whatever it returns
 * becomes the job's result, and anything it throws becomes the job's error.
 */
export function startJob(
	kind: string,
	target: string,
	label: string,
	run: (reporter: ProgressReporter) => Promise<unknown>,
): JobView {
	prune();

	const id = `${kind}-${++counter}`;
	const reporter = new ProgressReporter(label);

	const entry: JobEntry = {
		reporter,
		subscribers: new Set(),
		dirty: false,
		view: {
			id,
			kind,
			target,
			state: "running",
			startedAt: Date.now(),
			finishedAt: null,
			progress: reporter.snapshot(),
			result: null,
			error: null,
		},
	};

	reporter.onUpdate(() => {
		entry.view.progress = reporter.snapshot();
		entry.dirty = true;
	});

	entry.flusher = setInterval(() => {
		if (entry.dirty) {
			publish(entry);
		}
	}, FLUSH_MS);

	jobs.set(id, entry);

	const settle = (state: JobState, patch: Partial<JobView>): void => {
		if (entry.flusher) {
			clearInterval(entry.flusher);
			entry.flusher = undefined;
		}

		entry.view = {
			...entry.view,
			...patch,
			state,
			finishedAt: Date.now(),
			progress: reporter.snapshot(),
		};

		publish(entry);
	};

	// deliberately not awaited: the caller gets the id while this runs on
	void run(reporter)
		.then((result) => {
			// a step that never reported completion would leave the tree short of 100%
			reporter.settle();

			settle("done", { result: result ?? null });
		})
		.catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);

			reporter.say("error", message);

			settle("failed", { error: message });
		});

	return entry.view;
}

/** Current state of one job, or undefined once it has been pruned. */
/** How many jobs are still running — what an upgrade waits for. */
export function runningJobs(): number {
	let count = 0;

	for (const entry of jobs.values()) {
		if (entry.view.state === "running") {
			count += 1;
		}
	}

	return count;
}

export function getJob(id: string): JobView | undefined {
	return jobs.get(id)?.view;
}

/**
 * Watch a job. The callback fires with the job's current state immediately, then
 * on every throttled progress flush, and a last time when it settles. Returns
 * the unsubscribe function; it is safe to call for an unknown job.
 */
export function watchJob(id: string, subscriber: Subscriber): () => void {
	const entry = jobs.get(id);

	if (!entry) {
		return () => {};
	}

	entry.subscribers.add(subscriber);
	subscriber(entry.view);

	return () => {
		entry.subscribers.delete(subscriber);
	};
}
