// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * A synced crosshair: every chart handed the same group draws its crosshair at
 * the moment the pointer (or the keyboard) stands on in any of them, as
 * CloudWatch's dashboards do. Only the chart being pointed at shows its full
 * readout; the others mark the same moment and their values there.
 */
export class ChartGroup {
	/** The moment under the pointer, epoch ms; null when nobody points */
	hover: number | null = $state(null);

	/** Which chart the pointer is in, so only that one opens its readout */
	source: string | null = $state(null);

	/** Point the whole group at a moment, from one of its charts. */
	point(at: number, source: string): void {
		this.hover = at;
		this.source = source;
	}

	/** Let go, unless another chart has taken over since. */
	release(source: string): void {
		if (this.source !== source) {
			return;
		}

		this.hover = null;
		this.source = null;
	}
}
