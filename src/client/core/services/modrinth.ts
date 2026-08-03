/**
 * Bridge mirror of core/services/modrinth — version-picking helpers are pure,
 * the API calls go through the daemon (one host, one User-Agent, one cache).
 */

import type * as core from "../../../core/services/modrinth";

import { call } from "../../rpc";

export {
	PAPER_LOADERS,
	VELOCITY_LOADERS,
	RESOURCEPACK_LOADERS,
	DATAPACK_LOADERS,
	primaryFile,
	pickCompatible,
} from "../../../core/services/modrinth";
export type {
	MrProject,
	MrProjectType,
	MrSearchHit,
	MrVersion,
	MrVersionFile,
} from "../../../core/services/modrinth";

export const lookupByHash = call("modrinth.lookupByHash") as typeof core.lookupByHash;
export const getProject = call("modrinth.getProject") as typeof core.getProject;
export const getVersions = call("modrinth.getVersions") as typeof core.getVersions;
export const search = call("modrinth.search") as typeof core.search;
export const searchProjects = call("modrinth.searchProjects") as typeof core.searchProjects;
