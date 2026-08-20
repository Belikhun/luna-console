// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** One key → value row in a node's hover card. */
export interface OverviewDetail {
	key: string;
	value: string;
	/** Render the value in the mono face; for ids, counts and durations */
	mono?: boolean;
}

/**
 * A single cell in a `NodeOverview` grid.
 *
 * A cell is coloured either by `color`, which is used as given, or by `value`
 * mapped onto the grid's ramp. `color` wins when both are set.
 */
export interface OverviewNode {
	/** Heading of the hover card; the cell itself carries no text */
	label: string;
	/** Explicit cell colour, any CSS colour or design token */
	color?: string;
	/** Mapped onto the ramp between the grid's `min` and `max` */
	value?: number;
	/** Pill beside the heading, for a state that is not a number */
	status?: string;
	/** Colour of that pill; falls back to the cell's own colour */
	statusColor?: string;
	/** Everything else worth knowing about the node */
	details?: OverviewDetail[];
}

/** A chip in the legend footer, for a grid coloured by explicit colours. */
export interface OverviewLegendEntry {
	color: string;
	label: string;
}
