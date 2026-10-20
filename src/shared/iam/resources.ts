// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Resource ids: `luna:<type>/<name>`, the ARN of this console.
 *
 * The type is a catalog resource type and the name is whatever the resource's
 * own store keys it by: an instance's name, a plugin's `<name>@<family>`, an
 * account's username, a token's name, a knowledge item's id. A policy names
 * resources with the same wildcards it uses for actions.
 */

import { IAM_RESOURCE_TYPES, type IamResourceType } from "./actions";

export const RESOURCE_PREFIX = "luna:";

/** Limits on tags, AWS's own: 50 per resource, keys to 128 characters, values to 256. */
export const MAX_TAGS = 50;
export const MAX_TAG_KEY = 128;
export const MAX_TAG_VALUE = 256;

/** What a tag key or value may contain: letters, digits, space and the usual punctuation. */
export const TAG_KEY_PATTERN = /^[\p{L}\p{N} _.:/=+@-]{1,128}$/u;
export const TAG_VALUE_PATTERN = /^[\p{L}\p{N} _.:/=+@-]{0,256}$/u;

/** Build a resource id. */
export function resourceId(type: IamResourceType, name: string): string {
	return `${RESOURCE_PREFIX}${type}/${name}`;
}

/** Split a resource id into its type and name, or null when it is not one. */
export function parseResourceId(id: string): { type: IamResourceType; name: string } | null {
	if (!id.startsWith(RESOURCE_PREFIX)) {
		return null;
	}

	const rest = id.slice(RESOURCE_PREFIX.length);
	const slash = rest.indexOf("/");

	if (slash <= 0) {
		return null;
	}

	const type = rest.slice(0, slash);
	const name = rest.slice(slash + 1);

	if (!(IAM_RESOURCE_TYPES as string[]).includes(type) || name === "") {
		return null;
	}

	return { type: type as IamResourceType, name };
}

/** Whether a string is a resource type the catalog knows. */
export function isResourceType(value: string): value is IamResourceType {
	return (IAM_RESOURCE_TYPES as string[]).includes(value);
}

/** Validate a tag set, returning the first fault as a language key, or null. */
export function tagFault(tags: Record<string, string>): { key: string; params: Record<string, string | number> } | null {
	const entries = Object.entries(tags);

	if (entries.length > MAX_TAGS) {
		return { key: "core.resources.tooManyTags", params: { max: MAX_TAGS } };
	}

	for (const [key, value] of entries) {
		if (!TAG_KEY_PATTERN.test(key)) {
			return { key: "core.resources.badTagKey", params: { tag: key } };
		}

		if (typeof value !== "string" || !TAG_VALUE_PATTERN.test(value)) {
			return { key: "core.resources.badTagValue", params: { tag: key } };
		}

		if (key.toLowerCase().startsWith("luna:")) {
			return { key: "core.resources.reservedTagKey", params: { tag: key } };
		}
	}

	return null;
}
