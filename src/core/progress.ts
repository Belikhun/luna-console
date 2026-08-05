/**
 * Live progress reporting for long-running work.
 *
 * A reporter is one node in a tree: the root stands for the whole operation and
 * each child stands for a step the parent relies on. Every node reports its own
 * progress in [0, 1]; a parent's roll-up is its own progress (worth
 * `progressWeight` of the total) plus the weighted average of its children.
 * Every report bubbles to the root, so one listener at the root sees the whole
 * tree move; that is what the CLI renderer and the console's SSE job stream
 * subscribe to.
 */

export type ProgressStatus = "okay" | "info" | "warn" | "error";

/** Share of a node's roll-up taken by its own progress rather than its children's. */
const DEFAULT_PROGRESS_WEIGHT = 0.1;

/**
 * How close to 1 counts as finished. Weights rarely divide cleanly; three
 * children weighted 1/6/2 sum to 0.9999999999999999; and a node a float's
 * width short of 1 would render as still running forever.
 */
const ROLLUP_EPSILON = 1e-9;

/** One report, as the listening node saw it. */
export interface ProgressUpdate {
	/** Path of the node that reported, e.g. "0.1.2" */
	id: string;
	name: string;
	/** Depth in the tree; the root is 1 */
	level: number;
	status: ProgressStatus;
	message?: string;
	/** Roll-up of the node the listener is attached to, [0, 1] */
	progress: number;
	/** Roll-up of the node that reported, [0, 1] */
	sourceProgress: number;
}

/** Serializable state of a reporter and everything below it. */
export interface ProgressSnapshot {
	id: string;
	name: string;
	level: number;
	status: ProgressStatus;
	message?: string;
	/** Roll-up including children, [0, 1] */
	progress: number;
	done: boolean;
	children: ProgressSnapshot[];
}

export type ProgressListener = (update: ProgressUpdate) => void;

/** Labels for a `task()` step, one per outcome. */
export interface TaskLabels {
	/** Reported before the work starts */
	start: string;
	/** Reported when it returns; defaults to `start` */
	done?: string;
	/** Reported when it throws; defaults to `start` */
	failed?: string;
	/** How much of this node's own progress the step is worth (default: to 1) */
	progress?: number;
}

export class ProgressReporter {
	/** Path of this node in the tree, e.g. "0.1.2" */
	readonly id: string;
	readonly name: string;
	readonly level: number;
	readonly parent?: ProgressReporter;
	readonly children: ProgressReporter[] = [];

	/** What this node last reported for itself, [0, 1] */
	progress = 0;

	/** Roll-up of this node and its children. Never moves backwards. */
	calculated = 0;

	status: ProgressStatus = "info";
	message?: string;

	/** This node's share of its parent's child average */
	weight: number;

	/** Share of this node's roll-up taken by its own progress */
	progressWeight = DEFAULT_PROGRESS_WEIGHT;

	/**
	 * How many children this node will end up with. Set it up front and the
	 * average is taken over that many slots, so a tree that grows as it runs does
	 * not read as nearly-done after its first child finishes.
	 */
	expected = 0;

	/** How many reports this node has seen, its own and its descendants' */
	updates = 0;

	private totalWeight = 0;
	private listener?: ProgressListener;

	constructor(name = "task", parent?: ProgressReporter, weight = 1) {
		this.name = name;
		this.parent = parent;
		this.weight = weight;
		this.level = parent ? parent.level + 1 : 1;
		this.id = parent ? `${parent.id}.${parent.children.length}` : "0";
	}

	/** Create a child for a step this node's progress depends on. */
	child(name: string, weight = 1): ProgressReporter {
		const child = new ProgressReporter(name, this, weight);

		this.totalWeight += weight;
		this.children.push(child);

		return child;
	}

	/** Declare how many children are coming, before they exist. */
	expect(count: number): this {
		this.expected = count;

		return this;
	}

	/** Change how much of this node's roll-up comes from its own progress. */
	weighOwn(progressWeight: number): this {
		this.progressWeight = Math.min(1, Math.max(0, progressWeight));

		return this;
	}

	/** Subscribe to every report at or below this node. One listener per node. */
	onUpdate(listener: ProgressListener): this {
		this.listener = listener;

		return this;
	}

	/** Set this node's own progress and status, and bubble it to the root. */
	report(progress: number, status: ProgressStatus, message?: string): this {
		this.progress = Math.min(1, Math.max(0, progress));
		this.status = status;
		this.message = message;

		this.bubble(this, status, message);

		return this;
	}

	/** Report at the same progress this node already had. */
	say(status: ProgressStatus, message?: string): this {
		return this.report(this.progress, status, message);
	}

	info(progress: number, message?: string): this {
		return this.report(progress, "info", message);
	}

	okay(progress: number, message?: string): this {
		return this.report(progress, "okay", message);
	}

	warn(progress: number, message?: string): this {
		return this.report(progress, "warn", message);
	}

	error(progress: number, message?: string): this {
		return this.report(progress, "error", message);
	}

	/** Finish this node: full progress, okay status. */
	complete(message?: string): this {
		return this.report(1, "okay", message);
	}

	/**
	 * Force this node's roll-up to 1 regardless of its children; for a step that
	 * turned out to have nothing to do, whose children will never report.
	 */
	settle(): this {
		this.progress = 1;
		this.calculated = 1;
		this.progressWeight = 1;

		return this;
	}

	/**
	 * Run one step of this node's own work, reporting before and after. The step's
	 * failure message is reported before the error propagates, so a listener sees
	 * why the tree stopped.
	 */
	async task<T>(labels: TaskLabels, fn: (reporter: ProgressReporter) => Promise<T>): Promise<T> {
		const target = Math.min(1, labels.progress ?? 1);

		this.report(this.progress, "info", labels.start);

		try {
			const result = await fn(this);

			this.report(target, "okay", labels.done ?? labels.start);

			return result;
		} catch (err) {
			this.report(this.progress, "error", labels.failed ?? labels.start);

			throw err;
		}
	}

	/** This node and its subtree, as plain data for a client or a log. */
	snapshot(): ProgressSnapshot {
		const snapshot: ProgressSnapshot = {
			id: this.id,
			name: this.name,
			level: this.level,
			status: this.status,
			progress: this.calculated,
			done: this.calculated >= 1,
			children: this.children.map((child) => child.snapshot())
		};

		if (this.message !== undefined) {
			snapshot.message = this.message;
		}

		return snapshot;
	}

	/**
	 * Recompute this node's roll-up, then hand the report to the parent and to
	 * this node's own listener. The parent is notified first, so a root listener
	 * always sees a fully recomputed tree.
	 */
	private bubble(source: ProgressReporter, status: ProgressStatus, message?: string): void {
		this.updates += 1;
		this.calculated = this.rollUp();

		this.parent?.bubble(source, status, message);

		this.listener?.({
			id: source.id,
			name: source.name,
			level: source.level,
			status,
			message,
			progress: this.calculated,
			sourceProgress: source.calculated
		});
	}

	/** Own progress blended with the children's weighted average. */
	private rollUp(): number {
		if (!this.children.length) {
			return this.progress;
		}

		// With an expected count the average is taken over that many slots, so
		// children that do not exist yet still hold their share back.
		const slots = Math.max(this.expected, this.children.length);
		let childProgress = 0;

		for (const child of this.children) {
			const share = this.expected > 0 ? 1 / slots : child.weight / this.totalWeight;

			childProgress += child.calculated * share;
		}

		const blended =
			this.progress * this.progressWeight + childProgress * (1 - this.progressWeight);

		const settled = blended >= 1 - ROLLUP_EPSILON ? 1 : blended;

		// monotonic: a step that re-reports a lower figure must not rewind the whole
		// operation, which would read as work being undone
		return Math.max(this.calculated, settled);
	}
}
