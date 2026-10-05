// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import type { McpScope, McpToolGroup } from '$shared/mcptools';

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string')
		: [];
}

/**
 * A scope from a request body, shape-checked only; `core/mcp` drops groups and
 * tool names the catalog does not know, so this never has to repeat that list.
 */
export function parseScope(value: unknown): Partial<McpScope> | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	const record = value as Record<string, unknown>;
	const scope: Partial<McpScope> = {};

	if ('groups' in record) {
		scope.groups = strings(record.groups) as McpToolGroup[];
	}

	if ('allow' in record) {
		scope.allow = strings(record.allow);
	}

	if ('deny' in record) {
		scope.deny = strings(record.deny);
	}

	if ('instances' in record) {
		scope.instances = record.instances === null
			? null
			: strings(record.instances);
	}

	return scope;
}
