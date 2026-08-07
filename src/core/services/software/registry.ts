// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * The server-software provider registry.
 *
 * Every software luna can provision names a provider in its traits row, and
 * this is what turns that name into a client. Callers ask by *software*, never
 * by provider: which upstream serves paper is the registry's business, and an
 * instance records what it runs, not where the jar came from.
 *
 * Version lists are cached for the same reason the runtime catalog is: a launch
 * wizard asks for them on every keystroke of a software change, and the answer
 * moves a few times a week at most.
 */

import type { Software } from "../../types";
import { traitsOf } from "../../software";
import { t } from "../../../shared/i18n";
import * as fabric from "./fabric";
import * as forge from "./forge";
import * as mohist from "./mohist";
import * as neoforge from "./neoforge";
import * as papermc from "./papermc";
import * as pumpkin from "./pumpkin";
import * as purpur from "./purpur";
import type { BuildSpec, SoftwareBuild, SoftwareProviderClient, SoftwareProviderId } from "./types";

const REGISTRY: Record<SoftwareProviderId, SoftwareProviderClient> = {
	papermc: papermc.client,
	purpur: purpur.client,
	fabric: fabric.client,
	forge: forge.client,
	neoforge: neoforge.client,
	mohist: mohist.client,
	pumpkin: pumpkin.client,
};

/** How long a version list is reused before the upstream is asked again. */
const CATALOG_TTL_MS = 10 * 60_000;

const catalogCache = new Map<string, { at: number; versions: string[] }>();

/**
 * Remember one list, dropping whatever has gone stale. The loader key carries a
 * Minecraft version straight off a query string, so the key space is not one
 * this process gets to bound; expiring on write is what keeps it finite.
 */
function remember(key: string, versions: string[]): string[] {
	const now = Date.now();

	for (const [seen, entry] of catalogCache) {
		if (now - entry.at >= CATALOG_TTL_MS) {
			catalogCache.delete(seen);
		}
	}

	catalogCache.set(key, { at: now, versions });

	return versions;
}

/** The client serving a software's builds. Throws when luna can only adopt it. */
export function providerFor(software: Software): SoftwareProviderClient {
	const id = traitsOf(software).provider;

	if (!id) {
		throw new Error(t("core.services.software.noProvider", { software }));
	}

	const client = REGISTRY[id];

	if (!client) {
		throw new Error(t("core.services.unknownProvider", { provider: id }));
	}

	return client;
}

/**
 * Minecraft versions a software publishes builds for, newest first. An empty
 * list is a legitimate answer: an upstream that has announced a project but
 * released nothing yet says exactly that.
 */
export async function listMcVersions(software: Software, refresh = false): Promise<string[]> {
	const key = `mc:${software}`;
	const hit = catalogCache.get(key);

	if (!refresh && hit && Date.now() - hit.at < CATALOG_TTL_MS) {
		return hit.versions;
	}

	return remember(key, await providerFor(software).listMcVersions(software));
}

/** Loader builds for one Minecraft version, newest first; empty when it has none. */
export async function listLoaderVersions(
	software: Software,
	mcVersion?: string,
	refresh = false,
): Promise<string[]> {
	const client = providerFor(software);

	if (!client.listLoaderVersions) {
		return [];
	}

	const key = `loader:${software}:${mcVersion ?? ""}`;
	const hit = catalogCache.get(key);

	if (!refresh && hit && Date.now() - hit.at < CATALOG_TTL_MS) {
		return hit.versions;
	}

	return remember(key, await client.listLoaderVersions(software, mcVersion));
}

/**
 * Resolve the build a spec names; everything absent means newest stable.
 *
 * The Minecraft version is settled here, out of the cache the version pickers
 * already filled, so no client re-fetches a list the registry is holding and
 * every client is handed a concrete version rather than repeating the same
 * "or else the newest" dance seven times.
 */
export async function resolveBuild(software: Software, spec: BuildSpec = {}): Promise<SoftwareBuild> {
	const mcVersion = spec.mcVersion ?? (await listMcVersions(software))[0];

	if (!mcVersion) {
		throw new Error(t("core.services.software.noPublishedBuilds", { software }));
	}

	return await providerFor(software).resolveBuild(software, { ...spec, mcVersion });
}
