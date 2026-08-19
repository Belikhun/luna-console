// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

/**
 * Bridge mirror of core/maps: the provider registry, which is a table of
 * constants and needs no daemon to read.
 *
 * Server-side only, despite being pure. The module reaches `node:fs` for the
 * webroot resolver it also exports, so a browser bundle that imports it dies on
 * the externalised builtin; components take the provider's *id* off the public
 * card and never the shape.
 */

export { MAP_PROVIDERS, mapProvider, mapProviderOfSlug } from "../../core/maps";
export type { MapProviderId, MapProviderSpec, MapWebroot } from "../../core/maps";
