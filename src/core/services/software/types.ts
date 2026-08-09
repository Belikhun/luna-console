// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import type { Software } from "../../types";
import type { KnownHashes } from "../download";

/**
 * An upstream that publishes server software builds. One provider can serve
 * several softwares (papermc serves paper, folia and velocity; mohist serves
 * both youer flavours), which is why the software, not the provider, is what
 * an instance records.
 */
export type SoftwareProviderId =
	| "papermc"
	| "purpur"
	| "fabric"
	| "forge"
	| "neoforge"
	| "mohist"
	| "pumpkin";

/**
 * How a resolved build is materialized into an instance directory.
 *
 * `jar` and `native` are a single file written in place; `installer` is a jar
 * luna runs once, which then writes the library tree and the argument file the
 * server actually launches from.
 */
export type BuildKind = "jar" | "installer" | "native";

/** One resolvable build, normalized across every provider. */
export interface SoftwareBuild {
	software: Software;
	/** Minecraft version this build targets; absent for software that pins none */
	mcVersion?: string;
	/** The provider's own identifier, shown to the operator: a paper build number,
	 *  a forge version, a pumpkin release tag, a youer build id */
	buildId: string;
	/** What `InstanceConfig.loaderVersion` records, when the build carries one */
	loaderVersion?: string;
	url: string;
	fileName: string;
	/** Whatever the provider publishes; `downloadToFile` verifies what it can */
	hashes: KnownHashes;
	kind: BuildKind;
	/**
	 * The java feature release this build refuses to start without, when the
	 * provider states one. It is preferred over `suggestedFeature`, which can
	 * only infer a floor from a Minecraft version: a proxy's version is not one,
	 * and a build that raises the floor ahead of the game (velocity 4 wants 25
	 * while every MC release still runs on 21) is invisible to any inference.
	 */
	javaMinimum?: number;
}

/** Which build to resolve. Everything absent means "newest stable". */
export interface BuildSpec {
	mcVersion?: string;
	/** Pin a loader build rather than taking the newest */
	loaderVersion?: string;
	/** Platform triple of the machine that will run it, for native downloads */
	platform?: string;
}

/**
 * A spec the registry has already settled a concrete Minecraft version into.
 * Clients receive this, never the bare `BuildSpec`, so none of them has to
 * decide what "no version" means.
 */
export interface ResolvedBuildSpec extends BuildSpec {
	mcVersion: string;
}

/**
 * The interface every server-software provider implements. Mirrors
 * `ProviderClient` in services/providers.ts: normalized shapes in, normalized
 * shapes out, with the upstream's own vocabulary confined to the client.
 */
export interface SoftwareProviderClient {
	id: SoftwareProviderId;
	/** Minecraft versions on offer, newest first. May legitimately be empty when
	 *  an upstream has published nothing yet. */
	listMcVersions(software: Software): Promise<string[]>;
	/** Loader builds for one MC version, newest first. Only implemented by the
	 *  software that has a loader version beside the MC one. */
	listLoaderVersions?(software: Software, mcVersion?: string): Promise<string[]>;
	resolveBuild(software: Software, spec: ResolvedBuildSpec): Promise<SoftwareBuild>;
}
