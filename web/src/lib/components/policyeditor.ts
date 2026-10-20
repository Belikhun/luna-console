// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Types for `PolicyEditor.svelte`. A component's `<script>` block cannot
 * export types, so what a page needs to name lives here.
 */

import type { PolicyDocument, PolicyIssue } from '$shared/iam/grammar';

/** What the validate endpoint answers for one document. */
export interface PolicyValidation {
	ok: boolean;
	issues: PolicyIssue[];
	/** Statements the document parsed to; 0 while it does not parse */
	statements: number;
	/** The normalized document, when it parses; what the visual editor starts from */
	document?: PolicyDocument;
}

/** Which face the editor shows: the form, or the text that is saved. */
export type PolicyEditorMode = 'visual' | 'yaml';

/** How long the editor waits after the last keystroke before asking the daemon. */
export const POLICY_VALIDATE_DEBOUNCE_MS = 400;

/**
 * The document a new policy starts from: one harmless statement in the
 * grammar's own shape, so the operator edits a working example rather than a
 * blank page.
 */
export const POLICY_TEMPLATE = [
	'Version: 1',
	'Statement:',
	'  - Sid: DescribeInstances',
	'    Effect: Allow',
	'    Action:',
	'      - instance:List',
	'      - instance:Describe',
	'    Resource: "*"',
	''
].join('\n');
