// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** One choice of a `SegmentedControl`. */
export interface SegmentOption {
	id: string;
	label: string;
	icon?: string;
	/** Shown by the kit tooltip on hover */
	hint?: string;
	/** A count beside the label (open changes, waiting calls) */
	badge?: string | number;
	disabled?: boolean;
}
