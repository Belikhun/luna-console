// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** One reading handed to a `CalendarGraph`, bucketed into the day it falls in. */
export interface CalendarPoint {
	/** Epoch millis; the local calendar day of this instant is the cell it lands in */
	at: number;
	/** Added to that day's total; readings sharing a day are summed */
	value: number;
}

/** A single day cell, after bucketing. */
export interface CalendarDay {
	/** Local midnight of the day, epoch millis; the cell's identity */
	start: number;
	/** Sum of the day's readings */
	value: number;
	/** How many readings landed on it, which is not the same as the sum */
	count: number;
}
