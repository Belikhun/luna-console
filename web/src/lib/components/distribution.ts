/** One slice of a DistributionBar. */
export interface DistributionSegment {
	/** Stable key, also the tooltip/legend text when `label` is absent */
	key: string;
	label?: string;
	count: number;
	/** Any CSS colour — pass a design token, e.g. "var(--success)" */
	color: string;
}
