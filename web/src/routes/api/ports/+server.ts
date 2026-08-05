// Copyright (c) 2026 Belikhun. All rights reserved.
// Proprietary software: use, copying, modification and distribution are
// prohibited without written permission. See LICENSE at the repository root.

import { error, json } from '@sveltejs/kit';
import type { PortPool, PortPoolOverride } from '$core/types';
import { loadCluster, loadLock, saveCluster } from '$core/config';
import {
	auditPorts,
	collectPortRows,
	ensurePortAllocations,
	machineInfo,
	poolCatalog,
	poolConsumers,
	portPoolUsage,
	setPoolCatalog
} from '$core/ports';
import { readVelocityServers } from '$core/proxy';

/**
 * GET → the port map, the pool catalog (with per-machine usage and what
 * consumes each pool), plus the audit.
 */
export async function GET() {
	const cfg = await loadCluster();
	const lock = await loadLock();
	const rows = await collectPortRows(cfg, lock);
	const onDisk = await readVelocityServers(cfg);
	const stored = Array.isArray(cfg.portPools) ? cfg.portPools : [];

	return json({
		ports: rows,
		catalog: poolCatalog(cfg),
		// the built-in definitions, so an editor can tell "customized" from
		// "inherited" and omit unchanged defaults rather than freezing them in
		defaults: poolCatalog({ ...cfg, portPools: undefined }),
		storedIds: stored.map((pool) => pool.id),
		consumers: poolConsumers(lock),
		pools: portPoolUsage(cfg, lock),
		machines: machineInfo(cfg),
		issues: await auditPorts(cfg, lock, onDisk)
	});
}

/** POST → re-ensure every plugin port allocation and rewrite the config files. */
export async function POST() {
	const cfg = await loadCluster();
	const lock = await loadLock();
	const results = await ensurePortAllocations(cfg, lock);

	await saveCluster(cfg);

	const onDisk = await readVelocityServers(cfg);

	return json({
		ok: true,
		ensured: results.length,
		issues: await auditPorts(cfg, lock, onDisk)
	});
}

/** Distinct integers out of a request value, sorted. */
function readPorts(raw: unknown): number[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	return [...new Set(raw.map(Number).filter((port: number) => Number.isInteger(port)))].sort(
		(a, b) => a - b
	);
}

/** One pool definition out of the request body, with everything coerced. */
function readPool(raw: unknown): PortPool {
	const body = (raw ?? {}) as Record<string, unknown>;
	const range = Array.isArray(body.range) ? body.range : [];

	const pool: PortPool = {
		id: String(body.id ?? '').trim(),
		protocol: body.protocol === 'udp' || body.protocol === 'both' ? body.protocol : 'tcp',
		range: [Number(range[0]), Number(range[1])]
	};

	const label = String(body.label ?? '').trim();

	if (label) {
		pool.label = label;
	}

	const reserved = readPorts(body.reserved);

	if (reserved.length) {
		pool.reserved = reserved;
	}

	const overrides: Record<string, PortPoolOverride> = {};

	for (const [machine, raw] of Object.entries(
		(body.overrides ?? {}) as Record<string, unknown>
	)) {
		const value = (raw ?? {}) as Record<string, unknown>;
		const override: PortPoolOverride = {};

		if (Array.isArray(value.range) && value.range.length === 2) {
			override.range = [Number(value.range[0]), Number(value.range[1])];
		}

		const held = readPorts(value.reserved);

		if (held.length) {
			override.reserved = held;
		}

		if (override.range || override.reserved) {
			overrides[machine] = override;
		}
	}

	if (Object.keys(overrides).length) {
		pool.overrides = overrides;
	}

	return pool;
}

/**
 * PUT { pools }; replace the cluster's pool catalog. An entry customizes the
 * built-in default of the same id, a new id adds a pool, an empty list returns
 * everything to the defaults. Nothing is written unless the whole catalog
 * validates.
 */
export async function PUT({ request }) {
	const body = await request.json();

	if (!Array.isArray(body.pools)) {
		throw error(400, 'pools must be an array');
	}

	const cfg = await loadCluster();
	const lock = await loadLock();
	const result = setPoolCatalog(cfg, body.pools.map(readPool), lock);

	if (result.errors.length) {
		throw error(400, result.errors.join('; '));
	}

	await saveCluster(cfg);

	const stored = Array.isArray(cfg.portPools) ? cfg.portPools : [];

	return json({
		ok: true,
		warnings: result.warnings,
		catalog: poolCatalog(cfg),
		defaults: poolCatalog({ ...cfg, portPools: undefined }),
		storedIds: stored.map((pool) => pool.id),
		pools: portPoolUsage(cfg, lock),
		machines: machineInfo(cfg)
	});
}
