// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** One slice of a DistributionBar. */
export interface DistributionSegment {
	/** Stable key, also the tooltip/legend text when `label` is absent */
	key: string;
	label?: string;
	count: number;
	/** Any CSS colour; pass a design token, e.g. "var(--success)" */
	color: string;
}
