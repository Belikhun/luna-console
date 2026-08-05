import type { ProgressReporter, ProgressSnapshot } from "../core/progress";

/**
 * Mirror a remote progress snapshot into a local ProgressReporter tree.
 *
 * Jobs run in the daemon; their reporter trees cross the wire as
 * ProgressSnapshots. Renderers (the CLI's ProgressView, the hub relaying a
 * follower's job) want a live reporter to listen to, so this rebuilds the tree
 * locally: children are matched by position (the daemon side only appends),
 * every node weighs its own progress at 1 so its roll-up *is* the remote
 * roll-up we feed it, and a node only re-reports when something about it
 * actually changed; the local listener sees the same movement the remote one
 * did, without a flood of duplicate updates.
 */
export function applySnapshot(target: ProgressReporter, snap: ProgressSnapshot): void {
	target.weighOwn(1);

	for (let i = 0; i < snap.children.length; i++) {
		const childSnap = snap.children[i]!;

		if (!target.children[i]) {
			target.child(childSnap.name, 1);
		}

		applySnapshot(target.children[i]!, childSnap);
	}

	const changed =
		target.progress !== snap.progress ||
		target.status !== snap.status ||
		target.message !== snap.message;

	if (changed) {
		target.report(snap.progress, snap.status, snap.message);
	}
}
