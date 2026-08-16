// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/** One step of a {@link WizardModal}. */
export interface WizardStep {
	id: string;
	label: string;
	/** One line under the step's heading, saying what this step is for */
	description?: string;
	/**
	 * Why the wizard cannot move past this step yet.
	 *
	 * Non-empty blocks Next and is shown as the button's reason, following the
	 * console's rule that an unavailable control says what would make it
	 * available rather than simply going quiet.
	 */
	blocked?: string;
}
