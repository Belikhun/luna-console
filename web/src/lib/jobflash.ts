/**
 * The flash-card wrapper for long-running jobs — the console's one way to run
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
import { Notify, type NotificationInit } from '$lib/notifications.svelte';

export interface JobFlashConfig {
	/** headline while the job runs, e.g. "Starting lobby…" */
	title: string;
	/** kick the job off — a route answering `{ job }` */
	start: () => Promise<{ job: JobView }>;
	/** called once the job is accepted — the place to navigate away */
	started?: (job: JobView) => void;
	/** card content once the job finishes (message, detail, action buttons) */
	success?: (result: unknown) => NotificationInit;
	/** card content when it fails; the error lands in `detail` by default */
	failure?: (error: string) => NotificationInit;
}

/**
 * The deepest step still in flight, as "Name — message". Work runs top to
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
		label = node.message ? `${node.name} — ${node.message}` : node.name;
	}

	return label || root.message || '';
}

/**
 * Run a job behind a live flash card. Resolves with the settled job, or
 * undefined when it failed — the failure is already on the card, so callers
 * only branch, never re-report.
 */
export async function jobFlash(config: JobFlashConfig): Promise<JobView | undefined> {
	const note = Notify.loading(config.title);

	const fail = (message: string): undefined => {
		const patch = config.failure?.(message) ?? {};

		note.set({
			level: 'error',
			message: patch.message ?? config.title,
			detail: patch.detail ?? message,
			progress: null,
			actions: patch.actions ?? [],
			closeable: true
		});

		return undefined;
	};

	let job: JobView;

	try {
		job = (await config.start()).job;
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}

	config.started?.(job);

	let done: JobView;

	try {
		done = await followJob(job.id, (view) => {
			note.set({
				progress: Math.round(view.progress.progress * 100),
				detail: activeStep(view.progress)
			});
		});
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}

	const patch = config.success?.(done.result) ?? {};

	note.set({
		level: 'success',
		message: patch.message ?? config.title,
		detail: patch.detail ?? '',
		progress: null,
		actions: patch.actions ?? [],
		closeable: true
	});

	// a card carrying a button must not dismiss itself out from under the user
	if (patch.actions?.length) {
		note.autoclose(false);
	}

	return done;
}
