// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The flash-card wrapper for long-running jobs; the console's one way to run
 * an operation behind a live notification card. It raises a loading card,
 * starts the job, mirrors the ProgressReporter tree into the card (percent
 * bar + the deepest step still in flight as the "current task" line), and
 * settles the card green or red, optionally with action buttons ("Start now").
 *
 * Every long-running instance flow (provision, start, stop, restart, delete)
 * goes through this so they all read the same on screen.
 */

import type { ProgressSnapshot } from '$core/progress';
import { followJob, type JobView } from '$lib/jobs';
import {
	Notify,
	type NotificationHandle,
	type NotificationInit,
	type NotificationSegment
} from '$lib/notifications.svelte';

/**
 * Job ids this browser has already raised a card for; what stops a page that
 * discovers in-flight work (an instance detail opened mid-start) from raising
 * a second card next to the one the initiating flow is still updating.
 */
const flashedJobs = new Set<string>();

/** Fired when a flash-tracked job is accepted, and again when it settles. */
export type JobFlashEvent = 'started' | 'settled';

type JobFlashListener = (event: JobFlashEvent, job: JobView) => void;

const flashListeners = new Set<JobFlashListener>();

/**
 * Subscribe to every flash-tracked job's lifecycle. This is how a screen stays
 * current for work it did not start itself; a create finishing after the
 * launch page navigated away, a "Start now" clicked on a card. Returns the
 * unsubscribe function.
 */
export function onJobFlash(listener: JobFlashListener): () => void {
	flashListeners.add(listener);

	return () => {
		flashListeners.delete(listener);
	};
}

function emitJobFlash(event: JobFlashEvent, job: JobView): void {
	for (const listener of flashListeners) {
		listener(event, job);
	}
}

export interface JobFlashConfig {
	/** headline while the job runs, e.g. "Starting lobby…" */
	title: string;
	/** kick the job off; a route answering `{ job }` */
	start: () => Promise<{ job: JobView }>;
	/** called once the job is accepted; the place to navigate away */
	started?: (job: JobView) => void;
	/** card content once the job finishes (message, detail, action buttons) */
	success?: (result: unknown) => NotificationInit;
	/** card content when it fails; the error lands in `detail` by default */
	failure?: (error: string) => NotificationInit;
}

/** One step as the card's task line reads it: "Name; message". */
function describeStep(node: ProgressSnapshot): string {
	return node.message ? `${node.name}; ${node.message}` : node.name;
}

/**
 * The deepest step still in flight, as "Name; message". Work runs top to
 * bottom, so descending into the first unfinished child at every level lands
 * on what the operation is doing right now.
 */
export function activeStep(root: ProgressSnapshot | null | undefined): string {
	if (!root) {
		return '';
	}

	let node = root;
	let label = '';

	while (true) {
		const next = node.children.find((child) => !child.done);

		if (!next) {
			break;
		}

		node = next;
		label = describeStep(next);
	}

	if (label) {
		return label;
	}

	// every step is done but the job has not settled yet; a tracked start sits
	// here while it confirms the server answers pings. The card must not go
	// blank at 100%, so the last step stays on screen until success replaces it.
	const last = root.children.at(-1);

	return root.message || (last ? describeStep(last) : '');
}

/**
 * A job's tasks are the root's direct children (a create's "Server files",
 * "Plugins", …); each becomes one coloured segment of the card's bar. A tree
 * with no children; a single-step job; is its own lone segment.
 */
function taskSegments(root: ProgressSnapshot): NotificationSegment[] {
	const tasks = root.children.length > 0 ? root.children : [root];

	return tasks.map((task) => ({
		label: task.name,
		progress: task.progress,
		tone:
			task.status === 'error'
				? 'error'
				: task.status === 'warn'
					? 'warn'
					: task.done
						? 'done'
						: task.progress > 0
							? 'running'
							: 'idle'
	}));
}

/** Follow a running job into an already-raised card, settling it green or red. */
async function followIntoCard(
	job: JobView,
	note: NotificationHandle,
	config: Omit<JobFlashConfig, 'start' | 'started'>
): Promise<JobView | undefined> {
	let done: JobView;

	try {
		done = await followJob(job.id, (view) => {
			note.set({
				progress: Math.round(view.progress.progress * 100),
				detail: activeStep(view.progress),
				segments: taskSegments(view.progress)
			});
		});
	} catch (err) {
		emitJobFlash('settled', job);

		const message = err instanceof Error ? err.message : String(err);
		const patch = config.failure?.(message) ?? {};

		note.set({
			level: 'error',
			message: patch.message ?? config.title,
			detail: patch.detail ?? message,
			progress: null,
			segments: null,
			actions: patch.actions ?? [],
			closeable: true
		});

		return undefined;
	}

	emitJobFlash('settled', done);

	const patch = config.success?.(done.result) ?? {};

	note.set({
		level: 'success',
		message: patch.message ?? config.title,
		detail: patch.detail ?? '',
		progress: null,
		segments: null,
		actions: patch.actions ?? [],
		closeable: true
	});

	// a card carrying a button must not dismiss itself out from under the user
	if (patch.actions?.length) {
		note.autoclose(false);
	}

	return done;
}

/**
 * Run a job behind a live flash card. Resolves with the settled job, or
 * undefined when it failed; the failure is already on the card, so callers
 * only branch, never re-report.
 */
export async function jobFlash(config: JobFlashConfig): Promise<JobView | undefined> {
	const note = Notify.loading(config.title);

	let job: JobView;

	try {
		job = (await config.start()).job;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const patch = config.failure?.(message) ?? {};

		note.set({
			level: 'error',
			message: patch.message ?? config.title,
			detail: patch.detail ?? message,
			progress: null,
			segments: null,
			actions: patch.actions ?? [],
			closeable: true
		});

		return undefined;
	}

	flashedJobs.add(job.id);
	config.started?.(job);
	emitJobFlash('started', job);

	return await followIntoCard(job, note, config);
}

/**
 * Raise a card for a job that is already running; how a page shows work it
 * discovers rather than starts. A job this browser has flashed before is
 * skipped, so revisiting a page never duplicates a live card.
 */
export async function attachJobFlash(
	job: JobView,
	config: Omit<JobFlashConfig, 'start' | 'started'>
): Promise<JobView | undefined> {
	if (flashedJobs.has(job.id)) {
		return undefined;
	}

	flashedJobs.add(job.id);

	const note = Notify.loading(config.title);

	return await followIntoCard(job, note, config);
}
