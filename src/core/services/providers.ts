// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Addon providers: the upstream platforms luna installs plugins, mods,
 * resource packs and data packs from, behind one normalized surface. Each
 * client (modrinth, curseforge, hangar, smithed) translates its own API into
 * the shapes here; everything above this module; resolution, updates,
 * pinning, the pickers; is provider-blind and keys off the `RemoteRef`
 * stored in the lockfiles.
 *
 * The loader facet vocabulary is Modrinth's ("paper", "velocity", "neoforge",
 * "minecraft", "datapack") and stays the lingua franca: the other clients map
 * it onto their own filters (Hangar platforms, CurseForge classes/loaders).
 */

import type { ProviderId, RemoteRef } from "../types";
import { t } from "../../shared/i18n";

import * as curseforge from "./curseforge";
import * as hangar from "./hangar";
import * as modrinth from "./modrinth";
import * as smithed from "./smithed";

/** Kinds of addon luna installs from a provider. */
export type AddonType = "plugin" | "mod" | "resourcepack" | "datapack";

export type ReleaseChannel = "release" | "beta" | "alpha";

// The loader vocabulary lives with the family table it describes; re-exported
// here because every provider client reaches for it through this module.
import {
	DATAPACK_LOADERS,
	PAPER_LOADERS,
	RESOURCEPACK_LOADERS,
} from "../software";

export {
	DATAPACK_LOADERS,
	FABRIC_LOADERS,
	FORGE_LOADERS,
	NEOFORGE_LOADERS,
	PAPER_LOADERS,
	RESOURCEPACK_LOADERS,
	VELOCITY_LOADERS,
} from "../software";

/** One downloadable file of a version, with whatever hashes the provider knows. */
export interface AddonVersionFile {
	url: string;
	filename: string;
	primary: boolean;
	/** sha512 (modrinth), sha256 (hangar), sha1 (curseforge), none (smithed) */
	hashes: { sha512?: string; sha256?: string; sha1?: string };
	size: number;
}

/** One published version of a project, normalized across providers. */
export interface AddonVersion {
	id: string;
	project_id: string;
	version_number: string;
	version_type: ReleaseChannel;
	game_versions: string[];
	loaders: string[];
	date_published: string;
	files: AddonVersionFile[];
}

/** Project metadata, normalized across providers. */
export interface AddonProject {
	id: string;
	slug: string;
	title: string;
	description: string;
	loaders: string[];
	game_versions: string[];
	/** Hangar only: project owner, recorded into the RemoteRef for URLs */
	owner?: string;
}

/** One search hit, in the shape the console's picker renders. */
export interface AddonSearchHit {
	project_id: string;
	slug: string;
	title: string;
	description: string;
	downloads: number;
	author?: string;
	icon_url?: string;
	categories?: string[];
	versions?: string[];
	owner?: string;
}

/** What one client must implement to be a provider. */
export interface ProviderClient {
	id: ProviderId;
	label: string;
	/** Addon types this provider can serve at all */
	types: AddonType[];
	/** Whether the provider is usable right now (curseforge needs an API key) */
	status(): { available: boolean; reason?: string };
	search(query: string, type: AddonType, loaders: string[]): Promise<AddonSearchHit[]>;
	getProject(idOrSlug: string, type: AddonType): Promise<AddonProject | undefined>;
	getVersions(ref: RemoteRef, type: AddonType, loaders: string[]): Promise<AddonVersion[]>;
	projectUrl(ref: RemoteRef, type: AddonType): string;
	versionUrl(ref: RemoteRef, type: AddonType, version: { id: string; version_number: string }): string;
}

const REGISTRY: Record<ProviderId, ProviderClient> = {
	modrinth: modrinth.client,
	curseforge: curseforge.client,
	hangar: hangar.client,
	smithed: smithed.client,
};

/** The providers, in the order they are offered. */
export const PROVIDER_IDS: ProviderId[] = ["modrinth", "curseforge", "hangar", "smithed"];

/** Secrets and settings the daemon injects at startup. */
export interface ProvidersConfig {
	curseforgeApiKey?: string;
}

/**
 * Inject provider credentials. Called by the daemon once at startup, from its
 * own config; core never reads the environment itself.
 */
export function configureProviders(config: ProvidersConfig): void {
	curseforge.setApiKey(config.curseforgeApiKey);
}

/** The client for a provider id; throws on a name nothing registered. */
export function providerFor(id: ProviderId): ProviderClient {
	const client = REGISTRY[id];

	if (!client) {
		throw new Error(t("core.services.unknownProvider", { id }));
	}

	return client;
}

/** One provider's availability, as the console's picker reports it. */
export interface ProviderStatus {
	id: ProviderId;
	label: string;
	types: AddonType[];
	available: boolean;
	reason?: string;
}

/** Availability of every provider, for the pickers and `/api/providers`.
 *  Async because clients reach it over RPC; the key lives in the daemon. */
export async function providerStatus(): Promise<ProviderStatus[]> {
	return PROVIDER_IDS.map((id) => {
		const client = REGISTRY[id];
		const state = client.status();

		return {
			id,
			label: client.label,
			types: client.types,
			available: state.available,
			reason: state.reason,
		};
	});
}

/** The loader facets a type implies when the caller has none of its own. */
function defaultLoaders(type: AddonType, loaders?: string[]): string[] {
	if (loaders && loaders.length) {
		return loaders;
	}

	if (type === "resourcepack") {
		return RESOURCEPACK_LOADERS;
	}

	if (type === "datapack") {
		return DATAPACK_LOADERS;
	}

	return PAPER_LOADERS;
}

/** Guard: the provider must serve this addon type and be available. */
function usable(client: ProviderClient, type: AddonType): void {
	if (!client.types.includes(type)) {
		throw new Error(t("core.services.typeUnhosted", { provider: client.label, type }));
	}

	const state = client.status();

	if (!state.available) {
		throw new Error(t("core.services.providerUnavailable", { provider: client.label, reason: state.reason ?? "unknown" }));
	}
}

/** Search one provider for projects of one type. */
export async function searchProvider(
	provider: ProviderId,
	query: string,
	type: AddonType,
	loaders?: string[],
): Promise<AddonSearchHit[]> {
	const client = providerFor(provider);

	usable(client, type);

	return await client.search(query, type, defaultLoaders(type, loaders));
}

/** Project metadata by provider id/slug. Undefined when it does not exist. */
export async function getProject(
	provider: ProviderId,
	idOrSlug: string,
	type: AddonType,
): Promise<AddonProject | undefined> {
	const client = providerFor(provider);

	usable(client, type);

	return await client.getProject(idOrSlug, type);
}

/** Every published version of a lock entry's remote project. */
export async function getVersions(
	ref: RemoteRef,
	type: AddonType,
	loaders?: string[],
): Promise<AddonVersion[]> {
	const client = providerFor(ref.provider);

	usable(client, type);

	return await client.getVersions(ref, type, defaultLoaders(type, loaders));
}

/** Web page of a remote project, for the console's external links. */
export function projectUrl(ref: RemoteRef, type: AddonType): string {
	return providerFor(ref.provider).projectUrl(ref, type);
}

/** Web page of one version of a remote project. */
export function versionUrl(
	ref: RemoteRef,
	type: AddonType,
	version: { id: string; version_number: string },
): string {
	return providerFor(ref.provider).versionUrl(ref, type, version);
}

/** The RemoteRef an install records for a project picked on a provider. */
export function remoteRefFor(provider: ProviderId, project: AddonProject): RemoteRef {
	const ref: RemoteRef = { provider, projectId: project.id, slug: project.slug };

	if (project.owner) {
		ref.owner = project.owner;
	}

	return ref;
}

/**
 * Whether a declared game version covers a required MC version. Exact match,
 * plus prefix coverage for providers (Smithed, some pack authors) that declare
 * "1.21" and mean the whole 1.21.x line; "1.21" covers "1.21.4", "1.2" does
 * not cover "1.21".
 */
export function coversMc(gameVersions: string[] | undefined, mcVersion: string): boolean {
	if (!gameVersions || gameVersions.length === 0) {
		return false;
	}

	return gameVersions.some(
		(declared) => declared === mcVersion || mcVersion.startsWith(declared + "."),
	);
}

/** The file to install for a version; the primary file, or the first one published. */
export function primaryFile(version: AddonVersion): AddonVersionFile {
	return version.files.find((file) => file.primary) ?? version.files[0]!;
}

const CHANNEL_RANK: Record<ReleaseChannel, number> = { release: 0, beta: 1, alpha: 2 };

export interface PickOptions {
	/** Most unstable channel to accept (default "release") */
	channel?: ReleaseChannel;
	/** Only accept versions published after this date (downgrade guard) */
	afterDate?: string;
}

/**
 * Pick the newest acceptable version whose game_versions cover every required
 * MC version. Channel-gated (no snapshots unless the entry opted in) and
 * downgrade-guarded (never older than what is installed).
 *
 * `newest` is the newest acceptable version regardless of MC coverage, so a
 * caller can explain *why* it is holding an instance back.
 */
export function pickCompatible(
	versions: AddonVersion[],
	requiredMc: string[],
	opts: PickOptions = {},
): { best?: AddonVersion; newest?: AddonVersion } {
	const maxRank = CHANNEL_RANK[opts.channel ?? "release"];
	const after = opts.afterDate ? new Date(opts.afterDate).getTime() : undefined;

	const sorted = [...versions].sort(
		(a, b) => new Date(b.date_published).getTime() - new Date(a.date_published).getTime(),
	);

	const acceptable = sorted.filter((version) => {
		const inChannel = CHANNEL_RANK[version.version_type ?? "release"] <= maxRank;
		const newEnough =
			after === undefined || new Date(version.date_published).getTime() > after;

		return inChannel && newEnough;
	});

	const required = requiredMc.filter(Boolean);
	const best = acceptable.find((version) =>
		required.every((mc) => coversMc(version.game_versions, mc)),
	);

	return { best, newest: acceptable[0] };
}
