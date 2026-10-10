// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/instancefiles. Every op is routed to the daemon that
 * owns the instance, since the files only exist on that machine.
 */

import type * as core from "../../core/instancefiles";

import { call, jobCall } from "../rpc";

export { ARCHIVE_TYPES, MAX_DETAIL_ENTRIES, MAX_FIND_DEPTH, MAX_FIND_RESULTS } from "../../core/instancefiles";
export type {
	ArchiveFormat,
	ArchiveOptions,
	CrossCopyOptions,
	CrossCopyResult,
	DeleteOptions,
	ExistingPolicy,
	FindQuery,
	FindResult,
	PathDetails,
	PathInfo,
	PlaceUploadOptions,
	TransferOptions,
} from "../../core/instancefiles";

export const statInstancePath = call("instancefiles.stat", { cfg: 0 }) as typeof core.statInstancePath;
export const findInstanceFiles = call("instancefiles.find", { cfg: 0 }) as typeof core.findInstanceFiles;
export const makeInstanceDir = call("instancefiles.mkdir", { cfg: 0 }) as typeof core.makeInstanceDir;
export const copyInstancePath = call("instancefiles.copy", { cfg: 0 }) as typeof core.copyInstancePath;
export const moveInstancePath = call("instancefiles.move", { cfg: 0 }) as typeof core.moveInstancePath;
export const deleteInstancePath = call("instancefiles.delete", { cfg: 0 }) as typeof core.deleteInstancePath;
export const pathDetails = call("instancefiles.details", { cfg: 0 }) as typeof core.pathDetails;

/**
 * Land a staged upload inside an instance. The token names a file the primary
 * staged chunk by chunk; the owning daemon pulls it over the link when it is a
 * follower, then moves it into place. The primary's staged copy survives a
 * remote placement, so the caller discards it afterwards.
 */
export const placeUpload = call("instancefiles.placeUpload", { cfg: 0 }) as (
	cfg: Parameters<typeof core.placeUploadedFile>[0],
	instance: string,
	token: string,
	relPath: string,
	opts?: core.PlaceUploadOptions,
) => Promise<core.PathInfo>;

/**
 * Copy between two instances, routed to the daemon owning the destination; a
 * source on another machine crosses the cluster link as a tar stream.
 */
export const copyAcrossInstances = jobCall("instancefiles.copyAcross", {
	cfg: 0,
	reporter: { arg: 5, prop: "reporter" },
	kind: "file-copy",
	targetArg: 1,
}) as typeof core.copyAcrossInstances;
