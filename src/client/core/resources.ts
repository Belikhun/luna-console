// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/resources: resource metadata and tags. Recording a
 * creation is not here on purpose; the daemon's dispatcher does that from the
 * registry, with the actor the request carried.
 */

import type * as core from "../../core/resources";

import { call } from "../rpc";

export type { ResourceFilter, ResourceRecord, ResourceView } from "../../core/resources";
export { isResourceType } from "../../shared/iam/resources";

export const describeResource = call("resources.describe") as typeof core.describeResource;
export const describeResources = call("resources.describeMany") as typeof core.describeResources;
export const listResources = call("resources.list") as typeof core.listResources;
export const tagResource = call("resources.tag") as typeof core.tagResource;
export const untagResource = call("resources.untag") as typeof core.untagResource;
export const tagVocabulary = call("resources.vocabulary") as typeof core.tagVocabulary;
export const sweepResources = call("resources.sweep") as typeof core.sweepResources;
