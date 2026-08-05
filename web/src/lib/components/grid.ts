// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** Cell definition for InfoGrid (vloom ScreenGrid-style). */
export interface InfoCell {
	id?: string;
	label: string;
	value?: string | number | null;
	copyable?: boolean;
	/** value rendering style */
	style?: 'default' | 'heading' | 'code' | 'mono';
	colSpan?: number | 'all';
	help?: string;
	/** renders the value as a navigating link */
	href?: string;
}
