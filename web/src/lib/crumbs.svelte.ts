// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Labels a page lends the breadcrumb for a segment it knows better than the
 * layout does.
 *
 * The trail is derived from the URL, which is enough for almost every segment: a
 * route literal is a noun and a dynamic one is a value shown as configured. One
 * segment is neither. The addon tab's name depends on the instance's software -
 * "Plugins" on Paper, "Mods" on a mod loader, "Plugins & Mods" on a hybrid - and
 * the layout has no way to know which; only the screen under it does.
 *
 * Keyed by the full path of the crumb, so a label set for one instance cannot be
 * read for another, and so it works for an *intermediate* crumb as well as the
 * current one (`/instances/<name>/plugins` is a link on the addon detail page).
 *
 * A page that sets one must clear it on destroy: the layout outlives every page
 * inside it, and a label left behind would caption the next instance's crumb with
 * the last one's software.
 */
const labels = $state<Record<string, string>>({});

/** The label a page has lent for this crumb path, when there is one. */
export function crumbLabel(path: string): string | undefined {
	return labels[path];
}

/** Lend the breadcrumb a label for one crumb path. */
export function setCrumbLabel(path: string, label: string): void {
	labels[path] = label;
}

/** Take it back, which every page that sets one owes on destroy. */
export function clearCrumbLabel(path: string): void {
	delete labels[path];
}
